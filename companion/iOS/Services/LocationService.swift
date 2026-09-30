import CoreLocation
import Foundation

/// Where the owner is, off until they turn it on. iOS's low-power significant-change
/// updates (about every 500 m) give the Mac a recent fix for travel times, and home and work
/// regions tell it when they arrive or leave. Nothing tracks continuously; only the Mac gets
/// it (POST /api/location, kept in the outbox for an hour when the Mac is away).
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    static let shared = LocationService()

    struct Place: Codable, Equatable {
        var latitude: Double
        var longitude: Double
    }

    static let regionRadius: CLLocationDistance = 150

    private let manager = CLLocationManager()
    private var monitor: CLMonitor?
    private var events: Task<Void, Never>?
    private var waitingForHere: CheckedContinuation<CLLocation?, Never>?
    private var lastSent: (location: CLLocation, at: Date)?

    private static let enabledKey = "sensors.location"
    private static func placeKey(_ region: LocationReport.Region) -> String { "sensors.location.\(region.rawValue)" }

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    func place(_ region: LocationReport.Region) -> Place? {
        UserDefaults.standard.data(forKey: Self.placeKey(region)).flatMap { try? JSONDecoder().decode(Place.self, from: $0) }
    }

    /// At launch (also when iOS relaunched the app for a region or a significant change).
    func resume() {
        guard enabled else { return }
        start()
    }

    /// Turning it on asks for "while using" first, then "always" (arrivals need it).
    func turnOn() {
        enabled = true
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        start()
    }

    func turnOff() {
        enabled = false
        manager.stopMonitoringSignificantLocationChanges()
        events?.cancel()
        events = nil
        if let monitor {
            Task {
                for region in LocationReport.Region.allCases { await monitor.remove(region.rawValue) }
            }
        }
    }

    /// Makes "here" home or work.
    func setPlace(_ region: LocationReport.Region) async -> Bool {
        guard let here = await currentLocation() else { return false }
        let place = Place(latitude: here.coordinate.latitude, longitude: here.coordinate.longitude)
        UserDefaults.standard.set(try? JSONEncoder().encode(place), forKey: Self.placeKey(region))
        await watch(region, at: place)
        return true
    }

    func clearPlace(_ region: LocationReport.Region) async {
        UserDefaults.standard.removeObject(forKey: Self.placeKey(region))
        await monitor?.remove(region.rawValue)
    }

    // MARK: - Watching

    private func start() {
        guard enabled, [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus) else { return }
        manager.startMonitoringSignificantLocationChanges()
        guard events == nil else { return }
        events = Task {
            let monitor = await CLMonitor("com.bshventures.jarvis.companion.places")
            self.monitor = monitor
            for region in LocationReport.Region.allCases {
                if let place = place(region) { await watch(region, at: place, in: monitor) }
            }
            do {
                for try await event in await monitor.events {
                    guard let region = LocationReport.Region(rawValue: event.identifier),
                          event.state == .satisfied || event.state == .unsatisfied else { continue }
                    await arrivedOrLeft(region, arrived: event.state == .satisfied, at: event.date)
                }
            } catch {
                // Monitoring ended: it restarts at the next launch.
            }
        }
    }

    private func watch(_ region: LocationReport.Region, at place: Place, in given: CLMonitor? = nil) async {
        guard let monitor = given ?? monitor else { return }
        let condition = CLMonitor.CircularGeographicCondition(
            center: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude),
            radius: Self.regionRadius
        )
        await monitor.add(condition, identifier: region.rawValue, assuming: .unsatisfied)
    }

    private func arrivedOrLeft(_ region: LocationReport.Region, arrived: Bool, at date: Date) async {
        guard enabled, let place = place(region) else { return }
        let fix = manager.location
        let report = LocationReport(
            latitude: fix?.coordinate.latitude ?? place.latitude,
            longitude: fix?.coordinate.longitude ?? place.longitude,
            accuracy: fix?.horizontalAccuracy ?? Self.regionRadius,
            at: date,
            event: arrived ? .arrive : .leave,
            region: region
        )
        await send(report)
    }

    // MARK: - Sending

    private func send(_ report: LocationReport) async {
        do {
            guard let api = PairingStore.load().flatMap({ $0.isPinned ? $0.api : nil }) else { return }
            try await api.sendLocation(report)
        } catch let error as JarvisError where error.neverDelivered {
            try? Outbox.shared.add(.location(report))
        } catch {
            // The Mac refused it or went quiet mid-way: the next fix follows soon enough.
        }
    }

    /// Whether a new fix is worth sending: a few minutes on, or far enough away.
    nonisolated static func worthSending(_ location: CLLocation, after last: (location: CLLocation, at: Date)?, now: Date) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last.at) >= 5 * 60 || location.distance(from: last.location) >= 400
    }

    private func currentLocation() async -> CLLocation? {
        if let recent = manager.location, Date().timeIntervalSince(recent.timestamp) < 60 { return recent }
        return await withCheckedContinuation { continuation in
            waitingForHere?.resume(returning: nil)
            waitingForHere = continuation
            manager.requestLocation()
        }
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if manager.authorizationStatus == .authorizedWhenInUse, self.enabled {
                manager.requestAlwaysAuthorization()  // arrivals and departures need "always"
            }
            self.start()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            if let waiting = self.waitingForHere {
                self.waitingForHere = nil
                waiting.resume(returning: location)
            }
            guard self.enabled, location.horizontalAccuracy >= 0, location.horizontalAccuracy < 1000,
                  Self.worthSending(location, after: self.lastSent, now: Date()) else { return }
            self.lastSent = (location, Date())
            await self.send(LocationReport(
                latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                accuracy: location.horizontalAccuracy, at: location.timestamp
            ))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.waitingForHere?.resume(returning: nil)
            self.waitingForHere = nil
        }
    }
}
