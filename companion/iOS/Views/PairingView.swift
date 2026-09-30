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
    @FocusState private var codeFocused: Bool
    @FocusState private var addressFocused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: Space.xl) {
                        header
                        if let notice = model.pairingNotice {
                            ErrorCallout(title: "Pair again", message: notice)
                        }
                        macSection
                        codeSection
                        VStack(spacing: Space.l) {
                            pairButton
                            footer
                        }
                    }
                    .padding(.horizontal, Space.m + 4)
                    .padding(.top, Space.xs)
                    .padding(.bottom, Space.xxl)
                    .animation(.spring(response: 0.4, dampingFraction: 0.86), value: failure)
                    .animation(.spring(response: 0.4, dampingFraction: 0.86), value: browser.macs)
                }
                .onChange(of: failure) { _, failure in
                    guard failure != nil else { return }
                    Task {  // after the keyboard has settled
                        try? await Task.sleep(for: .milliseconds(350))
                        withAnimation { proxy.scrollTo(Self.failureID, anchor: .bottom) }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            TopScrim()
        }
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.12)))
        .onAppear { browser.start() }
        .onDisappear { browser.stop() }
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
        }
        .onChange(of: selected) { _, mac in
            if mac != nil, code.count == 6, canPair { Task { await pair() } }  // code first, then the Mac
        }
        .onChange(of: code) { _, value in
            if value.count == 6, canPair { Task { await pair() } }
        }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: Space.s) {
            ReactorView(mode: working ? .thinking : .idle, size: 176)
                .padding(.bottom, Space.xxs)
            Text("J.A.R.V.I.S.")
                .font(.display)
                .tracking(4)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text("Pair this iPhone with Jarvis on your Mac.")
                .font(.body)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, Space.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("J.A.R.V.I.S. companion. Pair with your Mac.")
    }

    private var macSection: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            SectionLabel(number: "01", title: "Your Mac")
            VStack(spacing: 0) {
                ForEach(browser.macs) { mac in
                    macRow(mac)
                    rowDivider
                }
                if browser.macs.isEmpty {
                    searchRow
                    rowDivider
                }
                addressRow
            }
            .glassCard(cornerRadius: 20, tint: addressFocused ? Palette.cyan : .white, strength: addressFocused ? 0.7 : 1)

            footnote("On your Mac, open Jarvis Settings › iPhone & Watch and turn on “Let my phone connect”. Its addresses are listed there.")
        }
    }

    private var rowDivider: some View {
        Rectangle()
            .fill(Palette.hairline)
            .frame(height: 0.5)
            .padding(.leading, 60)
    }

    private var addressRow: some View {
        HStack(spacing: Space.s + 2) {
            Image(systemName: "network")
                .symbolRenderingMode(.hierarchical)
                .font(.body)
                .foregroundStyle(addressFocused ? Palette.cyan : Palette.muted)
                .frame(width: 30)
                .accessibilityHidden(true)
            TextField("", text: $address, prompt: Text("Or type its address, e.g. 192.168.1.20").foregroundStyle(Palette.muted))
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($addressFocused)
                .onSubmit { codeFocused = true }
                .foregroundStyle(Palette.ink)
                .accessibilityLabel("Mac address")
                .accessibilityHint("Host name or IP address, with :port if it isn't 8765")
            if !address.isEmpty {
                Button { address = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Palette.muted)
                }
                .accessibilityLabel("Clear address")
            }
        }
        .padding(.horizontal, Space.m)
        .frame(minHeight: 54)
    }

    private func macRow(_ mac: BonjourBrowser.Mac) -> some View {
        let isSelected = selected == mac
        return Button {
            selected = mac
            address = ""
            addressFocused = false
            codeFocused = code.count < 6
        } label: {
            HStack(spacing: Space.s + 2) {
                IconTile(symbol: "desktopcomputer", tint: isSelected ? Palette.ice : Palette.ink)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.shortName(mac.name))
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .multilineTextAlignment(.leading)
                    Text(mac.host ?? "Found on this network")
                        .font(.footnote)
                        .foregroundStyle(Palette.muted)
                }
                Spacer(minLength: Space.xs)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .symbolRenderingMode(isSelected ? SymbolRenderingMode.palette : .monochrome)
                    .foregroundStyle(isSelected ? Palette.onAction : Palette.muted.opacity(0.6), Palette.cyan)
                    .contentTransition(.symbolEffect(.replace))
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mac.name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var searchRow: some View {
        HStack(spacing: Space.s + 2) {
            if let problem = browser.problem {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(Palette.amber)
                    .frame(width: 30)
                Text(problem)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            } else if searchedAWhile {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .foregroundStyle(Palette.muted)
                    .frame(width: 30)
                Text("No Mac has announced itself yet. Type its address below.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            } else {
                ProgressView()
                    .tint(Palette.ink2)
                    .frame(width: 30)
                Text("Looking for Jarvis on your network…")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.m)
        .accessibilityElement(children: .combine)
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            SectionLabel(number: "02", title: "Pairing code")
            CodeEntryField(code: $code, focused: $codeFocused, invalid: isWrongCode)
            if let failure {
                ErrorCallout(title: failure.title, message: failure.message, hint: hint(for: failure))
                    .id(Self.failureID)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            footnote("On the Mac, tap “Pair a phone” for a six-digit code. It works once, for five minutes.")
            HStack(spacing: Space.s) {
                Text("This iPhone")
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                TextField("iPhone", text: $deviceName)
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(Palette.ink2)
                    .font(.body)
                    .submitLabel(.done)
                    .accessibilityLabel("Name for this iPhone on the Mac")
            }
            .padding(.horizontal, Space.m)
            .frame(minHeight: 50)
            .glassCard(cornerRadius: 16)
            .padding(.top, Space.xxs)
        }
    }

    private func footnote(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.m)
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
            .frame(minHeight: 56)
        }
        .buttonStyle(PrimaryButtonStyle(cornerRadius: 18))
        .disabled(!canPair || working)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Label("Same Wi‑Fi as the Mac, or Tailscale on both when you’re away.", systemImage: "wifi")
            Label("Your token stays in this iPhone’s Keychain.", systemImage: "lock.fill")
        }
        .font(.footnote)
        .foregroundStyle(Palette.muted)
        .labelStyle(FooterLabelStyle())
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.m)
    }

    // MARK: - Pairing

    private static let failureID = "pairing-failure"

    /// "J.A.R.V.I.S. on Tony-MacBook-Pro" → "Tony-MacBook-Pro" (display only; the whole
    /// name stays the row's VoiceOver label).
    private static func shortName(_ name: String) -> String {
        let prefix = "J.A.R.V.I.S. on "
        guard name.hasPrefix(prefix), name.count > prefix.count else { return name }
        return String(name.dropFirst(prefix.count))
    }

    private var canPair: Bool {
        code.count == 6 && (selected != nil || MacAddress.normalize(address) != nil)
    }

    private var isWrongCode: Bool {
        if case .wrongCode = failure { return true }
        return false
    }

    private func pair() async {
        guard !working, canPair else { return }
        withAnimation { failure = nil }
        working = true
        codeFocused = false
        addressFocused = false
        defer { working = false }
        do {
            let url: URL
            if let selected {
                url = try await browser.address(of: selected)
            } else if let typed = MacAddress.normalize(address) {
                url = typed
            } else {
                throw JarvisError.invalidAddress
            }
            tried = url
            let name = deviceName.trimmed.isEmpty ? "iPhone" : deviceName.trimmed
            try await model.pair(at: url, code: code, deviceName: name, macName: selected?.name)
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
        case .notJarvis:
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
