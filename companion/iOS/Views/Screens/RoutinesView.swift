import SwiftUI

/// The Mac's routines: turn one on or off, run it now, change its time and days, or delete
/// it (after a confirmation).
struct RoutinesView: View {
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<[RoutineItem]> = .loading
    /// An older Mac without /api/routines: run-only, from /api/state.
    @State private var runOnly = false
    @State private var editing: RoutineItem?
    @State private var busy: Set<String> = []

    var body: some View {
        Group {
            if runOnly {
                legacyList
            } else if let routines = state.value {
                if routines.isEmpty {
                    ContentUnavailableView {
                        Label("No routines yet", systemImage: "bolt.slash")
                    } description: {
                        Text("Ask Jarvis for one, like “brief me every weekday at 7”. Routines show up here, to run or change.")
                    }
                } else {
                    list(routines)
                }
            } else {
                LoadStateView(state: state) { await load() }
            }
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { routine in
            RoutineEditor(routine: routine) { await load() }
        }
    }

    private func list(_ routines: [RoutineItem]) -> some View {
        List {
            Section {
                ForEach(routines) { routine in
                    row(routine)
                }
            } footer: {
                ListFooter("They run on your Mac. Tap one to change its time or days.")
            }
            .glassRow()
        }
        .glassList()
    }

    private func row(_ routine: RoutineItem) -> some View {
        HStack(spacing: Space.s) {
            Button {
                editing = routine
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "bolt.fill", tint: routine.enabled ? Palette.ink : Palette.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(routine.name)
                            .foregroundStyle(routine.enabled ? Palette.ink : Palette.muted)
                            .lineLimit(2)
                        Text(subtitle(routine))
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                            .lineLimit(2)
                    }
                    Spacer(minLength: Space.xxs)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(routine.name), \(subtitle(routine))")
            .accessibilityHint("Change its time or days, or delete it")

            Toggle("On", isOn: Binding(get: { routine.enabled }, set: { value in Task { await setEnabled(routine, value) } }))
                .labelsHidden()
                .tint(Palette.cyan)
                .disabled(busy.contains(routine.id))
                .accessibilityLabel(routine.enabled ? "Turn off \(routine.name)" : "Turn on \(routine.name)")

            runButton(id: routine.id, name: routine.name)
        }
        .padding(.vertical, Space.xxs)
    }

    private func runButton(id: String, name: String) -> some View {
        Button {
            Task { await run(id: id, name: name) }
        } label: {
            Image(systemName: "play.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(Palette.onAction)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Palette.action))
                .overlay(Circle().strokeBorder(.white.opacity(0.45), lineWidth: 0.5))
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Run \(name)")
    }

    /// An older Mac: run what /api/state lists.
    private var legacyList: some View {
        List {
            Section {
                ForEach(model.remote?.routines ?? []) { routine in
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "bolt.fill")
                        Text(routine.name).foregroundStyle(Palette.ink)
                        Spacer(minLength: Space.xs)
                        runButton(id: routine.id, name: routine.name)
                    }
                }
            } footer: {
                ListFooter("Runs on your Mac, right away. Update Jarvis on your Mac to change routines from here.")
            }
            .glassRow()
        }
        .glassList()
    }

    private func subtitle(_ routine: RoutineItem) -> String {
        var parts: [String] = []
        if !routine.scheduleText.isEmpty { parts.append(routine.scheduleText.capitalizedFirst) }
        if !routine.enabled {
            parts.append("Off")
        } else if let next = routine.nextRun, next > Date() {
            parts.append("Next \(next.formatted(.relative(presentation: .named)))")
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            state = .loaded(try await api.routines())
            runOnly = false
        } catch JarvisError.unsupported {
            runOnly = true
        } catch is CancellationError {
        } catch {
            guard model.handle(error) != nil else { return }
            if state.value == nil { state = .from(error) }
        }
    }

    private func setEnabled(_ routine: RoutineItem, _ enabled: Bool) async {
        guard let api = model.pairing?.api, var routines = state.value,
              let index = routines.firstIndex(where: { $0.id == routine.id }) else { return }
        busy.insert(routine.id)
        defer { busy.remove(routine.id) }
        routines[index].enabled = enabled  // at once; put back if the Mac says no
        state = .loaded(routines)
        Haptics.tap()
        do {
            if try await api.updateRoutine(id: routine.id, enabled: enabled) == false {
                model.show("Your Mac couldn’t change that routine.", style: .problem)
            }
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
        await load()
    }

    private func run(id: String, name: String) async {
        await model.runRoutine(id: id, name: name)
    }
}

/// One routine's time and days, run now, or delete.
private struct RoutineEditor: View {
    let routine: RoutineItem
    let onChange: () async -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var time: Date
    @State private var days: Set<Int>
    @State private var saving = false
    @State private var confirmDelete = false

    private let originalClock: String?
    private let originalDays: Set<Int>?

    init(routine: RoutineItem, onChange: @escaping () async -> Void) {
        self.routine = routine
        self.onChange = onChange
        originalClock = routine.clock
        originalDays = routine.weekdays.map(Set.init)
        _time = State(initialValue: routine.clock.map { RoutineSchedule.date(for: $0) } ?? RoutineSchedule.date(for: "08:00"))
        _days = State(initialValue: Set(routine.weekdays ?? []))
    }

    /// A one-off routine has a date, not days.
    private var repeats: Bool { !routine.scheduleText.lowercased().hasPrefix("once") }

    private var clock: String { RoutineSchedule.clock(of: time) }
    private var timeChanged: Bool { clock != originalClock }
    private var daysChanged: Bool { repeats && !days.isEmpty && days != (originalDays ?? []) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                        .foregroundStyle(Palette.ink)
                } header: {
                    ListHeader("When")
                } footer: {
                    if !routine.scheduleText.isEmpty { ListFooter("Now: \(routine.scheduleText).") }
                }
                .glassRow()

                if repeats {
                    Section {
                        DayPicker(days: $days)
                            .listRowInsets(EdgeInsets(top: Space.s, leading: Space.m, bottom: Space.s, trailing: Space.m))
                    } header: {
                        ListHeader("Days")
                    } footer: {
                        ListFooter(days.isEmpty ? "Pick at least one day." : dayText)
                    }
                    .glassRow()
                }

                Section {
                    Button {
                        Task {
                            await model.runRoutine(id: routine.id, name: routine.name)
                            dismiss()
                        }
                    } label: {
                        Label("Run now", systemImage: "play.fill")
                    }
                    .foregroundStyle(Palette.cyan)
                }
                .glassRow()

                Section {
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Text("Delete routine")
                            .font(.body.weight(.medium))
                            .foregroundStyle(Palette.danger)
                            .frame(maxWidth: .infinity)
                    }
                    .confirmationDialog("Delete “\(routine.name)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete", role: .destructive) { Task { await delete() } }
                    } message: {
                        Text("It won’t run again. This can’t be undone.")
                    }
                }
                .glassRow()
            }
            .glassList()
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
            .navigationTitle(routine.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save").fontWeight(.semibold) }
                    }
                    .disabled(saving || !(timeChanged || daysChanged))
                }
            }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet + 4)
    }

    private var dayText: String {
        let sorted = days.sorted()
        if sorted == Array(0...6) { return "Every day." }
        if sorted == [0, 1, 2, 3, 4] { return "Weekdays." }
        if sorted == [5, 6] { return "Weekends." }
        return sorted.map { RoutineSchedule.dayNames[$0] }.joined(separator: ", ") + "."
    }

    private func save() async {
        guard let api = model.pairing?.api else { return }
        saving = true
        defer { saving = false }
        do {
            let ok = try await api.updateRoutine(
                id: routine.id,
                time: timeChanged ? clock : nil,
                days: daysChanged ? days.sorted() : nil
            )
            if ok {
                Haptics.answered(negative: false)
                await onChange()
                dismiss()
            } else {
                model.show("Your Mac couldn’t change that routine.", style: .problem)
            }
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }

    private func delete() async {
        guard let api = model.pairing?.api else { return }
        do {
            if try await api.deleteRoutine(id: routine.id) {
                Haptics.answered(negative: true)
                model.show("Deleted “\(routine.name)”.", style: .success)
            }
            await onChange()
            dismiss()
        } catch {
            if let problem = model.handle(error) {
                Haptics.failure()
                model.show(problem.errorDescription ?? problem.title, style: .problem)
            }
        }
    }
}

/// Seven round day keys, Monday first (the Mac's 0 = Monday).
private struct DayPicker: View {
    @Binding var days: Set<Int>

    var body: some View {
        HStack(spacing: Space.xs) {
            ForEach(0..<7, id: \.self) { day in
                let on = days.contains(day)
                Button {
                    if on { days.remove(day) } else { days.insert(day) }
                    Haptics.tap()
                } label: {
                    Text(RoutineSchedule.dayLetters[day])
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(on ? Palette.ice : Palette.muted)
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(on ? Palette.cyan.opacity(0.2) : Color.white.opacity(0.05)))
                        .overlay(Circle().strokeBorder(on ? Palette.cyan.opacity(0.7) : Color.white.opacity(0.08), lineWidth: 1))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(RoutineSchedule.dayNames[day])
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

