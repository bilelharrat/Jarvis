import SwiftUI

/// First run: find the Mac (Bonjour, or its address), enter the six-digit code it shows.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var browser = BonjourBrowser()
    @State private var selected: BonjourBrowser.Mac?
    @State private var address = ""
    @State private var code = ""
    @State private var deviceName = UIDevice.current.name
    @State private var working = false
    @State private var failure: JarvisError?
    @State private var tried: URL?
    @State private var searchedAWhile = false
    @State private var probe: Probe = .idle
    @State private var probeTask: Task<Void, Never>?
    @State private var showScanner = false
    @FocusState private var codeFocused: Bool
    @FocusState private var addressFocused: Bool

    /// The Mac's certificate, read before anything is sent (trust on first use).
    enum Probe: Equatable {
        case idle
        case checking(URL)
        case found(URL, fingerprint: String)
        case failed(JarvisError)
    }

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if let notice = model.pairingNotice {
                    Section {
                        ErrorCallout(title: "Pair again", message: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }
                Section {
                    Button {
                        failure = nil
                        showScanner = true
                    } label: {
                        HStack(spacing: Space.s) {
                            IconTile(symbol: "qrcode.viewfinder", tint: .blue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Scan the Pairing Code")
                                    .foregroundStyle(Palette.ink)
                                Text("Jarvis Settings › iPhone & Watch on your Mac")
                                    .font(.footnote)
                                    .foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    .disabled(working)
                    .accessibilityHint("Opens the camera. The code is in Jarvis Settings, iPhone and Watch, on your Mac.")
                } footer: {
                    Text("The quickest way: the code carries your Mac’s address, a one-time code and its certificate.")
                }

                Section {
                    ForEach(browser.macs) { mac in
                        macRow(mac)
                    }
                    if browser.macs.isEmpty {
                        searchRow
                    }
                    addressRow
                } header: {
                    Text("Or Pair by Hand")
                } footer: {
                    Text("On your Mac, open Jarvis Settings › iPhone & Watch and turn on “Let my phone connect”. Its addresses are listed there.")
                }

                Section {
                    CodeEntryField(code: $code, focused: $codeFocused, invalid: isWrongCode)
                        .listRowInsets(EdgeInsets(top: Space.s, leading: Space.m, bottom: Space.s, trailing: Space.m))
                    fingerprintRow
                    LabeledContent("This iPhone") {
                        TextField("iPhone", text: $deviceName)
                            .multilineTextAlignment(.trailing)
                            .submitLabel(.done)
                            .accessibilityLabel("Name for this iPhone on the Mac")
                    }
                } header: {
                    Text("Pairing Code")
                } footer: {
                    Text("On the Mac, tap “Pair a phone” for a six-digit code. It works once, for five minutes.")
                }

                if let failure {
                    Section {
                        ErrorCallout(title: failure.title, message: failure.message, hint: hint(for: failure))
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .id(Self.failureID)
                    }
                }

                Section {
                    pairButton
                        .id(Self.pairID)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } footer: {
                    footer.padding(.top, Space.s)
                }
            }
            .animation(.default, value: failure)
            .animation(.default, value: browser.macs)
            .onChange(of: failure) { _, failure in
                guard failure != nil else { return }
                Task {  // after the keyboard has settled
                    try? await Task.sleep(for: .milliseconds(350))
                    withAnimation { proxy.scrollTo(Self.failureID, anchor: .bottom) }
                }
            }
            // The whole code is in: put the keyboard away so the fingerprint and the Pair
            // button are both in view, to compare and then pair.
            .onChange(of: code) { _, value in
                guard value.count == 6 else { return }
                codeFocused = false
                Task {
                    try? await Task.sleep(for: .milliseconds(350))
                    withAnimation { proxy.scrollTo(Self.pairID, anchor: .bottom) }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Pair with Your Mac")
        .navigationBarTitleDisplayMode(.large)
        .onAppear {
            browser.start()
            if address.isEmpty, let previous = model.previousAddress { address = previous }
        }
        .onDisappear {
            browser.stop()
            probeTask?.cancel()
        }
        .sheet(isPresented: $showScanner) {
            ScanPairingSheet { link in
                Task { await pair(with: link) }
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(5))
            searchedAWhile = true
        }
        .task { await debugPrefill() }
        .onChange(of: browser.macs) { _, macs in
            if selected == nil, address.isEmpty, macs.count == 1 { selected = macs.first }
            if let current = selected, !macs.contains(current) { selected = nil }
        }
        .onChange(of: address) { _, value in
            if !value.isEmpty { selected = nil }
            checkCertificate(after: .milliseconds(700))
        }
        .onChange(of: selected) { _, _ in
            checkCertificate(after: .zero)
        }
    }

    // MARK: - Rows

    private var addressRow: some View {
        HStack(spacing: Space.s) {
            IconTile(symbol: "network", tint: .gray)
            TextField("Address, e.g. 192.168.1.20", text: $address)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($addressFocused)
                .onSubmit { codeFocused = true }
                .accessibilityLabel("Mac address")
                .accessibilityHint("Host name or IP address, with :port if it isn't 8765")
        }
    }

    private func macRow(_ mac: BonjourBrowser.Mac) -> some View {
        let isSelected = selected == mac
        return Button {
            selected = mac
            address = ""
            addressFocused = false
            codeFocused = code.count < 6
        } label: {
            HStack(spacing: Space.s) {
                IconTile(symbol: "desktopcomputer", tint: .blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.shortName(mac.name))
                        .foregroundStyle(Palette.ink)
                    Text(mac.host ?? "Found on this network")
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                }
                Spacer(minLength: Space.xs)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .accessibilityLabel(mac.name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var searchRow: some View {
        HStack(spacing: Space.s) {
            if let problem = browser.problem {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(Palette.amber)
                    .frame(width: 29)
                Text(problem)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            } else if searchedAWhile {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .foregroundStyle(Palette.muted)
                    .frame(width: 29)
                Text("No Mac has announced itself yet. Type its address below.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            } else {
                ProgressView()
                    .frame(width: 29)
                Text("Looking for Jarvis on your network…")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The certificate this iPhone will trust, to compare with the Mac's Settings before
    /// the code goes anywhere.
    @ViewBuilder
    private var fingerprintRow: some View {
        switch probe {
        case .idle:
            EmptyView()
        case .checking:
            HStack(spacing: Space.s) {
                ProgressView()
                Text("Checking the Mac’s certificate…")
                    .foregroundStyle(Palette.ink2)
            }
            .accessibilityElement(children: .combine)
        case .found(_, let fingerprint):
            let warn = hintDisagrees(with: fingerprint)
            VStack(alignment: .leading, spacing: Space.xs) {
                LabeledContent {
                    Text(CertificatePin.short(fingerprint))
                        .font(.body.monospaced().weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .textSelection(.enabled)
                } label: {
                    Label("Mac’s Fingerprint", systemImage: warn ? "exclamationmark.shield.fill" : "lock.shield.fill")
                        .foregroundStyle(warn ? Palette.amber : Palette.ink)
                }
                Text(warn
                    ? "This isn’t the fingerprint the Mac announced on the network. Pair only if it matches the one in Jarvis Settings on your Mac."
                    : "Check it matches the fingerprint in Jarvis Settings › iPhone & Watch on your Mac, then pair.")
                    .font(.footnote)
                    .foregroundStyle(warn ? Palette.amber : Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mac’s fingerprint: \(CertificatePin.short(fingerprint).map { String($0) }.joined(separator: " "))")
        case .failed(let error):
            VStack(alignment: .leading, spacing: 4) {
                Label(error.title, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Palette.amber)
                Text(error.message)
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                if let hint = hint(for: error) {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                }
            }
        }
    }

    private func hintDisagrees(with fingerprint: String) -> Bool {
        guard let hint = selected?.fingerprintHint else { return false }
        return !CertificatePin.shortMatches(hint, fingerprint)
    }

    private var pairButton: some View {
        Button {
            Task { await pair() }
        } label: {
            HStack(spacing: Space.s - 2) {
                if working {
                    ProgressView().tint(Palette.onAction)
                } else {
                    Image(systemName: "link")
                }
                Text(working ? "Pairing…" : "Pair with Mac")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(!canPair || working)
        .accessibilityLabel("Pair with Mac")
        .accessibilityHint(pairHint)
    }

    private var pairHint: String {
        if case .found(_, let fingerprint) = probe {
            return "Trusts the Mac with fingerprint \(CertificatePin.short(fingerprint))."
        }
        return "Choose your Mac and enter its code first."
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Label("Same Wi‑Fi as the Mac, or Tailscale on both when you’re away.", systemImage: "wifi")
            Label("Encrypted to your Mac’s own certificate, and to no other.", systemImage: "lock.shield.fill")
            Label("Your token stays in this iPhone’s Keychain.", systemImage: "lock.fill")
        }
        .font(.footnote)
        .foregroundStyle(Palette.muted)
        .labelStyle(FooterLabelStyle())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Pairing

    private static let failureID = "pairing-failure"
    private static let pairID = "pair-button"

    /// "J.A.R.V.I.S. on Tony-MacBook-Pro" → "Tony-MacBook-Pro" (display only; the whole
    /// name stays the row's VoiceOver label).
    private static func shortName(_ name: String) -> String {
        let prefix = "J.A.R.V.I.S. on "
        guard name.hasPrefix(prefix), name.count > prefix.count else { return name }
        return String(name.dropFirst(prefix.count))
    }

    private var canPair: Bool {
        guard code.count == 6, case .found = probe else { return false }
        return true
    }

    /// Where to look: the Mac picked from the list, else the typed address.
    private func target() async throws -> URL? {
        if let selected { return try await browser.address(of: selected) }
        return MacAddress.normalize(address)
    }

    /// Reads the certificate at the chosen address (after a pause while typing).
    private func checkCertificate(after delay: Duration) {
        probeTask?.cancel()
        let haveTarget = selected != nil || MacAddress.normalize(address) != nil
        guard haveTarget else {
            probe = .idle
            return
        }
        probeTask = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            do {
                guard let url = try await target() else { return }
                guard !Task.isCancelled else { return }
                if case .found(url, _) = probe { return }
                probe = .checking(url)
                tried = url
                let fingerprint = try await JarvisAPI.probeFingerprint(at: url)
                guard !Task.isCancelled else { return }
                withAnimation { probe = .found(url, fingerprint: fingerprint) }
            } catch is CancellationError {
            } catch let error as JarvisError {
                guard !Task.isCancelled else { return }
                withAnimation { probe = .failed(error) }
            } catch {
                guard !Task.isCancelled else { return }
                withAnimation { probe = .failed(.unreachable(error.localizedDescription)) }
            }
        }
    }

    private var isWrongCode: Bool {
        if case .wrongCode = failure { return true }
        return false
    }

    private var name: String { deviceName.trimmed.isEmpty ? "iPhone" : deviceName.trimmed }

    /// By hand: to the certificate shown above, which the person has compared.
    private func pair() async {
        guard !working, canPair, case .found(let url, let fingerprint) = probe else { return }
        await pair { try await model.pair(at: url, fingerprint: fingerprint, code: code, deviceName: name, macName: selected?.name) }
    }

    /// From the QR code: the fingerprint came from the Mac's own screen.
    private func pair(with link: PairingLink) async {
        tried = link.baseURL
        await pair {
            try await model.pair(at: link.baseURL, fingerprint: link.fingerprint, code: link.code, deviceName: name, macName: link.macName)
        }
    }

    private func pair(_ attempt: () async throws -> Void) async {
        guard !working else { return }
        withAnimation { failure = nil }
        working = true
        codeFocused = false
        addressFocused = false
        defer { working = false }
        do {
            try await attempt()
            Haptics.answered(negative: false)
        } catch let error as JarvisError {
            Haptics.failure()
            withAnimation { failure = error }
            if case .wrongCode = error {
                code = ""
                codeFocused = true
            }
        } catch {
            Haptics.failure()
            withAnimation { failure = .unreachable(error.localizedDescription) }
        }
    }

    private func hint(for error: JarvisError) -> String? {
        switch error {
        case .unreachable:
            let target = tried.map { "Tried \(MacAddress.display($0)). " } ?? ""
            return target + "If iOS asked about Local Network access and you said no, turn it on in Settings › Privacy & Security › Local Network."
        case .notJarvis, .notEncrypted:
            return tried.map { "Tried \(MacAddress.display($0))." }
        default:
            return nil
        }
    }

    private func debugPrefill() async {
        #if DEBUG
        guard !DebugLaunch.prefilled else { return }
        DebugLaunch.prefilled = true
        if let server = DebugLaunch.server, address.isEmpty { address = server }
        if let debugCode = DebugLaunch.code, code.isEmpty {
            try? await Task.sleep(for: .seconds(1.5))
            for digit in debugCode.prefix(6) {  // typed, one digit at a time
                code.append(digit)
                try? await Task.sleep(for: .milliseconds(140))
            }
            for _ in 0..<40 where !canPair {  // the certificate check may still be running
                try? await Task.sleep(for: .milliseconds(250))
            }
            await pair()
        }
        #endif
    }
}

private struct FooterLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
            configuration.icon
                .foregroundStyle(Palette.titanium)
                .frame(width: 18)
            configuration.title
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
