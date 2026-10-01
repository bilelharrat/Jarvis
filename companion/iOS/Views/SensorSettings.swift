import AVFoundation
import CoreLocation
import SwiftUI

/// Settings › Sensors: location, health, the live camera, contacts and the calendar, each
/// off until turned on (iOS asks its permission then), each saying plainly what it sends
/// and when; and why notifications aren't one of them.
struct SensorSettings: View {
    @State private var location = LocationService.shared.enabled
    @State private var authorization = LocationService.shared.authorization
    @State private var home = LocationService.shared.place(.home) != nil
    @State private var work = LocationService.shared.place(.work) != nil
    @State private var settingPlace: LocationReport.Region?
    @State private var health = HealthService.shared.enabled
    @State private var healthProblem: String?
    @AppStorage(SensorSettings.liveCameraKey) private var liveCamera = false
    @State private var cameraProblem: String?
    @State private var contacts = PhoneSensors.shared.contactsOn
    @State private var contactsProblem: String?
    @State private var calendar = PhoneSensors.shared.calendarOn
    @State private var calendarProblem: String?
    @State private var calendarSent = PhoneSensors.shared.calendarSentAt
    @State private var syncing = false

    static let liveCameraKey = "sensors.camera.live"

    var body: some View {
        Group {
            Section {
                Toggle(isOn: Binding(get: { location }, set: setLocation)) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "location.fill")
                        Text("Share my location")
                    }
                }
                .accessibilityLabel("Share my location")
                if location {
                    place(.home, set: home)
                    place(.work, set: work)
                    if authorization == .denied || authorization == .restricted {
                        openSettings("Location is off for J.A.R.V.I.S. in Settings.")
                    } else if authorization == .authorizedWhenInUse {
                        openSettings("Allow location “Always” so arrivals count when the app is closed.")
                    }
                }
            } header: {
                ListHeader("Location")
            } footer: {
                ListFooter("Tells Jarvis on your Mac where you are, so travel times start from you, and when you arrive at or leave home and work. It uses iOS’s low-power updates (about every 500 m), never continuous tracking, and only your Mac gets it.")
            }
            .glassRow()

            Section {
                Toggle(isOn: Binding(get: { health }, set: setHealth)) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "heart.fill")
                        Text("Daily health summary")
                    }
                }
                .disabled(!HealthService.shared.available)
                .accessibilityLabel("Daily health summary")
                if let healthProblem {
                    Text(healthProblem)
                        .font(.footnote)
                        .foregroundStyle(Palette.amber)
                }
            } header: {
                ListHeader("Health")
            } footer: {
                ListFooter(HealthService.shared.available
                    ? "A few times a day: steps, last night’s sleep, resting heart rate and workouts, read from Apple Health (never written). Your Mac keeps two weeks, and your briefing may mention them."
                    : "Apple Health isn’t on this device.")
            }
            .glassRow()

            Section {
                Toggle(isOn: Binding(get: { liveCamera }, set: setLiveCamera)) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "camera.viewfinder")
                        Text("Point and ask")
                    }
                }
                .accessibilityLabel("Point and ask")
                if let cameraProblem { openSettings(cameraProblem) }
            } header: {
                ListHeader("Camera")
            } footer: {
                ListFooter("Adds a live view to Show Jarvis: point the camera and ask “What’s this?” or “Read this”. The camera shows only on your screen; one still frame goes to Jarvis each time you ask, never a video stream. Show Jarvis can always take a single photo.")
            }
            .glassRow()

            Section {
                Toggle(isOn: Binding(get: { contacts }, set: setContacts)) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "person.crop.circle.fill")
                        Text("Look up contacts")
                    }
                }
                .accessibilityLabel("Look up contacts")
                if let contactsProblem { openSettings(contactsProblem) }
            } header: {
                ListHeader("Contacts")
            } footer: {
                ListFooter("When your Mac’s Contacts don’t have someone, Jarvis can ask this iPhone “who is…”. It looks up that one name here and sends back at most five matches: name, job, company, numbers and emails. Your address book is never uploaded.")
            }
            .glassRow()

            Section {
                Toggle(isOn: Binding(get: { calendar }, set: setCalendar)) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "calendar")
                        Text("Share my calendar")
                    }
                }
                .accessibilityLabel("Share my calendar")
                if calendar {
                    HStack(spacing: Space.s) {
                        Text(calendarSent.map { "Sent \($0.formatted(.relative(presentation: .named)))" } ?? "Not sent yet")
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                        Spacer(minLength: Space.xs)
                        if syncing {
                            ProgressView()
                        } else {
                            Button("Sync now") { syncCalendar() }
                                .foregroundStyle(Palette.cyan)
                                .buttonStyle(.borderless)
                        }
                    }
                }
                if let calendarProblem { openSettings(calendarProblem) }
            } header: {
                ListHeader("Calendar")
            } footer: {
                ListFooter("For calendars that live only on this iPhone: the next 14 days of events (title, time, place and calendar name; never notes, invitees or links) go to your Mac every 30 minutes, and when Jarvis asks. Your Mac keeps only the latest copy and forgets it when you turn this off.")
            }
            .glassRow()

            Section {
                Label {
                    Text("Other apps’ notifications")
                        .foregroundStyle(Palette.ink)
                } icon: {
                    Image(systemName: "bell.slash")
                        .foregroundStyle(Palette.muted)
                }
                .accessibilityElement(children: .combine)
                Button("Open Shortcuts") {
                    if let url = URL(string: "shortcuts://") { UIApplication.shared.open(url) }
                }
                .foregroundStyle(Palette.cyan)
            } header: {
                ListHeader("Notifications")
            } footer: {
                ListFooter("iOS doesn’t let any app read other apps’ notifications, so Jarvis can’t see them. Two things come close: a Focus filter (Settings › Focus) decides which apps and people can reach you, and a Shortcuts automation (Shortcuts › Automation, for example “When I get an email from…” or “When an app is opened”) can run “Ask Jarvis” with what you choose to pass it.")
            }
            .glassRow()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            authorization = LocationService.shared.authorization
        }
    }

    private func place(_ region: LocationReport.Region, set: Bool) -> some View {
        HStack(spacing: Space.s) {
            Text(region == .home ? "Home" : "Work")
                .foregroundStyle(Palette.ink)
            Spacer(minLength: Space.xs)
            if settingPlace == region {
                ProgressView()
            } else if set {
                Button("Clear") {
                    Task {
                        await LocationService.shared.clearPlace(region)
                        refresh()
                    }
                }
                .foregroundStyle(Palette.muted)
                .buttonStyle(.borderless)
            }
            Button(set ? "Use here" : "Set to here") {
                settingPlace = region
                Task {
                    _ = await LocationService.shared.setPlace(region)
                    settingPlace = nil
                    refresh()
                }
            }
            .foregroundStyle(Palette.cyan)
            .buttonStyle(.borderless)
            .disabled(settingPlace != nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(region == .home ? "Home" : "Work"), \(set ? "set" : "not set")")
    }

    private func openSettings(_ text: String) -> some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
                Text("Open Settings")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.cyan)
            }
        }
        .buttonStyle(.plain)
    }

    private func setLocation(_ on: Bool) {
        location = on
        if on {
            LocationService.shared.turnOn()
        } else {
            LocationService.shared.turnOff()
        }
        refresh()
    }

    private func setHealth(_ on: Bool) {
        healthProblem = nil
        guard on else {
            health = false
            HealthService.shared.turnOff()
            return
        }
        health = true
        Task {
            if await HealthService.shared.turnOn() == false {
                health = false
                healthProblem = "Apple Health didn’t allow it. You can allow it in Settings › Health › Data Access."
            }
        }
    }

    private func setLiveCamera(_ on: Bool) {
        cameraProblem = nil
        guard on else {
            liveCamera = false
            return
        }
        Task {
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            liveCamera = allowed
            if !allowed { cameraProblem = "The camera is off for J.A.R.V.I.S. in Settings." }
        }
    }

    private func setContacts(_ on: Bool) {
        contactsProblem = nil
        contacts = on
        Task {
            if on {
                if await PhoneSensors.shared.turnOnContacts() == false {
                    contacts = false
                    contactsProblem = "Contacts are off for J.A.R.V.I.S. in Settings."
                }
            } else {
                await PhoneSensors.shared.turnOffContacts()
            }
        }
    }

    private func setCalendar(_ on: Bool) {
        calendarProblem = nil
        calendar = on
        Task {
            if on {
                syncing = true
                if await PhoneSensors.shared.turnOnCalendar() == false {
                    calendar = false
                    calendarProblem = "Calendars are off for J.A.R.V.I.S. in Settings (it needs full access to read them)."
                }
                syncing = false
            } else {
                await PhoneSensors.shared.turnOffCalendar()
            }
            calendarSent = PhoneSensors.shared.calendarSentAt
        }
    }

    private func syncCalendar() {
        syncing = true
        Task {
            await PhoneSensors.shared.sendCalendarIfDue(force: true)
            calendarSent = PhoneSensors.shared.calendarSentAt
            syncing = false
        }
    }

    private func refresh() {
        authorization = LocationService.shared.authorization
        home = LocationService.shared.place(.home) != nil
        work = LocationService.shared.place(.work) != nil
    }
}
