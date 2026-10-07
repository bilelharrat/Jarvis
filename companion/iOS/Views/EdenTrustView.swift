import SwiftUI

/// Settings › Account's row for Eden sync: where it stands, and the way in to approving a
/// browser.
struct EdenTrustSection: View {
    private var trust: EdenTrust { EdenTrust.shared }

    var body: some View {
        Section {
            NavigationLink {
                EdenTrustView()
            } label: {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "lock.laptopcomputer", tint: .indigo)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Trust a Browser for Eden Sync")
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            }
        } header: {
            Text("Eden Sync")
        } footer: {
            Text("Eden at askeden.com keeps your chats end to end encrypted. A new browser gets the key only after you check it shows the same six digits as this iPhone.")
        }
        .task { await trust.refresh() }
    }

    private var detail: String {
        let waiting = trust.status?.requests.count ?? 0
        return switch trust.state {
        case .unknown: "Eden’s chat history on your browsers"
        case .off: "Not turned on yet"
        case .locked: "This iPhone needs Eden’s key first"
        case .asking: "Waiting for a browser to approve this iPhone"
        case .on: waiting == 0 ? "No browser is waiting" : waiting == 1 ? "A browser is waiting" : "\(waiting) browsers are waiting"
        }
    }
}

/// Approving a browser for Eden sync: the browsers waiting, each with its six digits, Approve or
/// Deny. First, once, this iPhone gets Eden's key: from a browser that already syncs (it shows
/// this iPhone's six digits), or with the recovery passphrase.
struct EdenTrustView: View {
    private var trust: EdenTrust { EdenTrust.shared }

    @State private var passphrase = ""
    @State private var checking: EdenSyncStatus.Request?
    @State private var confirmStop = false
    @FocusState private var typing: Bool

    var body: some View {
        GlassForm {
            switch trust.state {
            case .unknown:
                Section {
                    HStack {
                        Text(trust.problem ?? "Checking with askeden.com…")
                            .foregroundStyle(trust.problem == nil ? Palette.muted : Palette.amber)
                        Spacer()
                        if trust.problem == nil { ProgressView() }
                    }
                }
            case .off:
                Section {
                    note("lock.open", .gray, "Eden Sync Isn’t On",
                         "Turn it on in Eden at askeden.com, in Account › Sync. Then this iPhone can let your other browsers in.")
                }
            case .locked:
                lockedSections
            case .asking(let code):
                askingSection(code)
            case .on:
                waitingSection
                membersSection
            }
            if let problem = trust.problem, trust.state != .unknown {
                Section {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(Palette.amber)
                }
            } else if let done = trust.done {
                Section {
                    Text(done)
                        .font(.footnote)
                        .foregroundStyle(Color.green)
                }
            }
        }
        .navigationTitle("Eden Sync")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await trust.refresh() }
        .task {
            // Browsers waiting to sync show up while this screen is open.
            while !Task.isCancelled {
                await trust.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .confirmationDialog(
            checking.map { "Does “\($0.name)” show \($0.code)?" } ?? "",
            isPresented: Binding(get: { checking != nil }, set: { if !$0 { checking = nil } }),
            titleVisibility: .visible, presenting: checking
        ) { request in
            Button("Approve") { Task { await trust.approve(request) } }
            Button("Deny", role: .destructive) { Task { await trust.deny(request) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Approve only if the browser shows exactly these digits. It gets the key that opens your Eden chats.")
        }
        .confirmationDialog("Stop holding Eden’s key on this iPhone?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await trust.forget() } }
        } message: {
            Text("Browsers that sync keep syncing. This iPhone just can’t approve new ones until it gets the key again.")
        }
    }

    private func note(_ symbol: String, _ tint: Color, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            IconTile(symbol: symbol, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    // MARK: Getting the key

    @ViewBuilder
    private var lockedSections: some View {
        Section {
            note("key.fill", .orange, "First, Eden’s Key",
                 "To approve browsers, this iPhone needs Eden’s key once. A browser that already syncs can give it, or your recovery passphrase opens it.")
            Button {
                Task { await trust.ask() }
            } label: {
                Label("Ask a Browser That Syncs", systemImage: "laptopcomputer.and.iphone")
            }
        }
        if trust.status?.wrap == true {
            Section {
                SecureField("Recovery passphrase", text: $passphrase)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($typing)
                    .submitLabel(.go)
                    .onSubmit(unlock)
                Button(action: unlock) {
                    HStack {
                        Text("Unlock")
                        Spacer()
                        if trust.isWorking { ProgressView() }
                    }
                }
                .disabled(passphrase.isEmpty || trust.isWorking)
            } header: {
                Text("Or the Recovery Passphrase")
            } footer: {
                Text("The one you chose when you turned Eden sync on. It stays on this iPhone.")
            }
        }
    }

    private func unlock() {
        let words = passphrase
        passphrase = ""
        typing = false
        Task { await trust.unlock(passphrase: words) }
    }

    private func askingSection(_ code: String) -> some View {
        Section {
            VStack(spacing: Space.s) {
                Text("In Eden on a browser that already syncs, open Account › Sync and approve this iPhone if it shows:")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .multilineTextAlignment(.center)
                Text(code)
                    .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .accessibilityLabel("Code \(code)")
                ProgressView()
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.s)
            Button("Cancel", role: .cancel) { Task { await trust.cancel() } }
                .frame(maxWidth: .infinity)
        } header: {
            Text("Waiting for Approval")
        }
    }

    // MARK: Approving

    private var waitingSection: some View {
        Section {
            let requests = trust.status?.requests ?? []
            if requests.isEmpty {
                note("checkmark.shield.fill", .green, "No Browser Is Waiting",
                     "On the new browser, open Account › Sync in Eden and choose “Ask a device that syncs”. It shows up here with six digits.")
            }
            ForEach(requests) { request in
                HStack(spacing: Space.s) {
                    IconTile(symbol: request.symbol, tint: .blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(request.name)
                        Text(request.code)
                            .font(.system(.title2, design: .monospaced).weight(.semibold))
                            .accessibilityLabel("Code \(request.code)")
                    }
                    Spacer(minLength: 0)
                    Button("Check") { checking = request }
                        .buttonStyle(.borderedProminent)
                        .disabled(trust.isWorking)
                }
                .swipeActions {
                    Button("Deny", role: .destructive) { Task { await trust.deny(request) } }
                }
            }
        } header: {
            Text("Waiting to Sync")
        } footer: {
            Text("Approve a browser only if it shows the same six digits. Then it gets Eden’s key, sealed so only that browser can open it.")
        }
    }

    private var membersSection: some View {
        Section {
            ForEach(Array((trust.status?.members ?? []).enumerated()), id: \.offset) { _, member in
                HStack {
                    Text(member.name)
                    Spacer()
                    if member.isThis {
                        Text("This iPhone")
                            .font(.footnote)
                            .foregroundStyle(Color.green)
                    }
                }
            }
            Button("Stop Holding the Key Here", role: .destructive) { confirmStop = true }
        } header: {
            Text("Devices with Eden’s Key")
        } footer: {
            Text("This iPhone never reads your Eden chats; it holds the key only to hand it on.")
        }
    }
}
