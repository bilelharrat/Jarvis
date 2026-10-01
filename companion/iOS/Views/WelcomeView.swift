import SwiftUI

/// First run: the orb, and two ways in — pair Jarvis on your Mac (everything it does), or
/// run Jarvis on this iPhone with your own Claude API key. Either can be added later.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showKey = false
    @State private var path: [Step] = []

    enum Step: Hashable { case pair }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: Space.xl) {
                    ReactorView(mode: .idle, size: 240)
                        .padding(.top, Space.xl)
                    VStack(spacing: Space.s) {
                        Text("J.A.R.V.I.S.")
                            .font(.largeTitle.weight(.bold))
                        Text("Your assistant, on your iPhone and your Mac.")
                            .font(.title3)
                            .foregroundStyle(Palette.ink2)
                            .multilineTextAlignment(.center)
                    }
                    VStack(alignment: .leading, spacing: Space.l) {
                        feature("waveform", .purple, "Just ask", "Say “Hey Jarvis”, press the Action Button, or tap the orb.")
                        feature("desktopcomputer", .blue, "Everything on your Mac", "Jarvis Code, files, mail, iMessage, routines and approvals, from anywhere.")
                        feature("iphone", .green, "Works on its own", "Calendar, reminders, weather, timers, music, Home and the web, right here.")
                    }
                    .padding(.horizontal, Space.s)
                }
                .padding(.horizontal, Space.l)
                .padding(.bottom, Space.l)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: Space.s) {
                    NavigationLink(value: Step.pair) {
                        Text("Pair with Your Mac")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    Button("Use on This iPhone") { showKey = true }
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .padding(.horizontal, Space.l)
                .padding(.bottom, Space.s)
            }
            .background(SpaceBackground(grouped: false))
            .navigationDestination(for: Step.self) { _ in PairingView() }
            .onAppear {
                // Came back to pair again (the Mac forgot this iPhone), or a test server to pair with.
                var straightToPairing = model.pairingNotice != nil
                #if DEBUG
                straightToPairing = straightToPairing || DebugLaunch.server != nil
                #endif
                if straightToPairing, path.isEmpty { path = [.pair] }
            }
            .sheet(isPresented: $showKey) {
                NavigationStack {
                    GlassForm {
                        PhoneBrainSettings()
                    }
                    .navigationTitle("Jarvis on iPhone")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel", systemImage: "xmark") { showKey = false }
                        }
                    }
                }
                .presentationDetents([.large])
            }
        }
    }

    private func feature(_ symbol: String, _ tint: Color, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(tint)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
