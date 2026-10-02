import SwiftUI

/// The Jarvises this iPhone is paired with (a Mac, the cloud Jarvis on the owner's server),
/// and a switch between them: Code, chats and approvals go to the one in use. The cloud one
/// keeps working while the Mac is shut or off.
struct JarvisSwitcherSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Section {
            if let current = model.pairing {
                HStack(spacing: Space.s) {
                    IconTile(symbol: JarvisSwitcher.symbol(for: current), tint: .green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(current.macLabel)
                        Text("In use").font(.footnote).foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Image(systemName: "checkmark").foregroundStyle(Palette.cyan)
                }
            }
            ForEach(model.otherPairings, id: \.baseURL) { other in
                Button {
                    model.use(other)
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: JarvisSwitcher.symbol(for: other), tint: .gray)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(other.macLabel).foregroundStyle(Palette.ink)
                            Text(other.address).font(.footnote).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        Text("Use").font(.footnote.weight(.semibold)).foregroundStyle(Palette.cyan)
                    }
                }
                .swipeActions {
                    Button("Forget", systemImage: "trash", role: .destructive) { model.forgetOther(other) }
                }
            }
            NavigationLink {
                PairingView()
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "plus", tint: .blue)
                    Text("Pair Another Jarvis")
                }
            }
        } header: {
            Text("Your Jarvises")
        } footer: {
            Text("Pair your Mac and your cloud Jarvis, and switch here: the cloud one keeps Jarvis Code working while your Mac is shut or off.")
        }
    }
}

/// The Code tab's switch: which Jarvis its sessions are on.
struct JarvisSwitcherMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let current = model.pairing, !model.otherPairings.isEmpty {
            Menu {
                Section("Jarvis Code on") {
                    Label(current.macLabel, systemImage: "checkmark")
                    ForEach(model.otherPairings, id: \.baseURL) { other in
                        Button(other.macLabel, systemImage: JarvisSwitcher.symbol(for: other)) { model.use(other) }
                    }
                }
            } label: {
                Label(current.macLabel, systemImage: JarvisSwitcher.symbol(for: current))
                    .labelStyle(.titleAndIcon)
                    .font(.footnote.weight(.semibold))
            }
            .accessibilityLabel("Jarvis in use: \(current.macLabel). Switch")
        }
    }
}

enum JarvisSwitcher {
    /// A cloud for a Jarvis named as one (or on a public address), a Mac otherwise.
    static func symbol(for pairing: Pairing) -> String {
        let name = pairing.macLabel.lowercased()
        if name.contains("cloud") || name.contains("server") { return "cloud.fill" }
        return MacAddress.isLocal(pairing.baseURL) ? "desktopcomputer" : "cloud.fill"
    }
}
