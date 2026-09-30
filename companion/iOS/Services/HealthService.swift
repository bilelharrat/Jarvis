import Foundation
import HealthKit

/// The daily health summary, off until the owner turns it on: steps, last night's sleep,
/// resting heart rate and workouts, read from Apple Health (never written) and sent to the
/// Mac for the briefing. At most every three hours: yesterday's whole day, and today so far
/// (last night's sleep, the steps until now). The Mac keeps 14 days.
@MainActor
final class HealthService {
    static let shared = HealthService()

    private let store = HKHealthStore()
    private static let enabledKey = "sensors.health"
    private static let sentKey = "sensors.health.sent"

    var available: Bool { HKHealthStore.isHealthDataAvailable() }

    var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    private var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) { types.insert(steps) }
        if let resting = HKObjectType.quantityType(forIdentifier: .restingHeartRate) { types.insert(resting) }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(sleep) }
        return types
    }

    /// Asks to read (only read) the four kinds of data, then sends the first summaries.
    func turnOn() async -> Bool {
        guard available else { return false }
        do {
            try await store.requestAuthorization(toShare: [], read: readTypes)
        } catch {
            return false
        }
        enabled = true
        await sendIfDue(force: true)
        return true
    }

    func turnOff() {
        enabled = false
        UserDefaults.standard.removeObject(forKey: Self.sentKey)
    }

    /// On opening the app and on background refresh.
    func sendIfDue(force: Bool = false, now: Date = Date()) async {
        guard enabled, available else { return }
        let last = UserDefaults.standard.double(forKey: Self.sentKey)
        guard force || now.timeIntervalSince1970 - last > 3 * 60 * 60 else { return }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: today) else { return }
        var days: [HealthDay] = []
        for day in [yesterday, today] {
            let summary = await summary(for: day, now: now)
            if !summary.isEmpty { days.append(summary) }
        }
        guard !days.isEmpty else { return }
        let api = PairingStore.load().flatMap { $0.isPinned ? $0.api : nil }
        for day in days {
            do {
                guard let api else { throw JarvisError.notPinned }
                try await api.sendHealth(day)
            } catch let error as JarvisError where error.neverDelivered {
                try? Outbox.shared.add(.health(day))  // one per day, the latest
            } catch {
                return  // tried again in a while
            }
        }
        UserDefaults.standard.set(now.timeIntervalSince1970, forKey: Self.sentKey)
    }

    // MARK: - Reading Health

    func summary(for day: Date, now: Date) async -> HealthDay {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: day)
        let end = min(now, calendar.date(byAdding: .day, value: 1, to: start) ?? now)
        async let steps = sum(.stepCount, unit: .count(), from: start, to: end)
        async let resting = average(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), from: start, to: end)
        async let sleep = sleepHours(endingOn: start)
        async let workouts = workouts(from: start, to: end)
        return HealthDay(
            day: HealthDay.key(for: start),
            steps: await steps.map { Int($0.rounded()) },
            sleepHours: await sleep,
            restingHeartRate: await resting.map { Int($0.rounded()) },
            workouts: await workouts
        )
    }

    private func sum(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, from start: Date, to end: Date) async -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKSamplePredicate.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
        let query = HKStatisticsQueryDescriptor(predicate: predicate, options: .cumulativeSum)
        return (try? await query.result(for: store))?.sumQuantity()?.doubleValue(for: unit)
    }

    private func average(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, from start: Date, to end: Date) async -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKSamplePredicate.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
        let query = HKStatisticsQueryDescriptor(predicate: predicate, options: .discreteAverage)
        return (try? await query.result(for: store))?.averageQuantity()?.doubleValue(for: unit)
    }

    /// The night that ended on this day's morning: asleep from 6 pm the day before to noon.
    private func sleepHours(endingOn day: Date) async -> Double? {
        guard let type = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let start = day.addingTimeInterval(-6 * 60 * 60)
        let end = day.addingTimeInterval(12 * 60 * 60)
        let predicate = HKSamplePredicate.categorySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
        let query = HKSampleQueryDescriptor(predicates: [predicate], sortDescriptors: [])
        guard let samples = try? await query.result(for: store) else { return nil }
        let asleep = samples.filter { HealthMath.isAsleep($0.value) }.map { ($0.startDate, $0.endDate) }
        return HealthMath.hours(merging: asleep)
    }

    private func workouts(from start: Date, to end: Date) async -> [HealthDay.Workout]? {
        let predicate = HKSamplePredicate.workout(HKQuery.predicateForSamples(withStart: start, end: end))
        let query = HKSampleQueryDescriptor(predicates: [predicate], sortDescriptors: [SortDescriptor(\.startDate)])
        guard let workouts = try? await query.result(for: store), !workouts.isEmpty else { return nil }
        return workouts.map { HealthDay.Workout(kind: HealthMath.name(of: $0.workoutActivityType), minutes: Int(($0.duration / 60).rounded())) }
    }
}

/// The arithmetic, apart from HealthKit.
enum HealthMath {
    /// Asleep, of any stage (in bed and awake don't count).
    static func isAsleep(_ value: Int) -> Bool {
        let asleep: Set<Int> = [
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue,
        ]
        return asleep.contains(value)
    }

    /// Hours covered by the intervals, overlaps counted once (the iPhone and the Watch both
    /// record the same night); nil when there's none.
    static func hours(merging intervals: [(Date, Date)]) -> Double? {
        let sorted = intervals.filter { $0.1 > $0.0 }.sorted { $0.0 < $1.0 }
        guard var current = sorted.first else { return nil }
        var total: TimeInterval = 0
        for interval in sorted.dropFirst() {
            if interval.0 <= current.1 {
                current.1 = max(current.1, interval.1)
            } else {
                total += current.1.timeIntervalSince(current.0)
                current = interval
            }
        }
        total += current.1.timeIntervalSince(current.0)
        return total / 3600
    }

    static func name(of type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .traditionalStrengthTraining, .functionalStrengthTraining: "strength training"
        case .highIntensityIntervalTraining: "HIIT"
        case .rowing: "rowing"
        case .elliptical: "elliptical"
        case .dance, .socialDance, .cardioDance: "dance"
        case .pilates: "pilates"
        case .tennis: "tennis"
        case .golf: "golf"
        case .soccer: "soccer"
        case .basketball: "basketball"
        case .mindAndBody: "mind and body"
        default: "workout"
        }
    }
}
