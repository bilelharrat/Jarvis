import CoreLocation
import SwiftUI

/// Settings › Sensors: location, health and the camera, each off until turned on, each
/// saying plainly what it sends and when.
struct SensorSettings: View {
    @State private var location = LocationService.shared.enabled
    @State private var authorization = LocationService.shared.authorization
    @State private var home = LocationService.shared.place(.home) != nil
    @State private var work = LocationService.shared.place(.work) != nil
    @State private var settingPlace: LocationReport.Region?
    @State private var health = HealthService.shared.enabled
    @State private var healthProblem: String?
    @AppStorage(SensorSettings.cameraKey) private var camera = false

    static let cameraKey = "sensors.camera"

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
                Toggle(isOn: $camera) {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "camera.fill")
                        Text("Show Jarvis")
                    }
                }
                .accessibilityLabel("Show Jarvis")
            } header: {
                ListHeader("Camera")
            } footer: {
                ListFooter("Adds Show Jarvis to the menu: take a photo and ask about it. A photo goes to your Mac only when you send it.")
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

    private func refresh() {
        authorization = LocationService.shared.authorization
        home = LocationService.shared.place(.home) != nil
        work = LocationService.shared.place(.work) != nil
    }
}
