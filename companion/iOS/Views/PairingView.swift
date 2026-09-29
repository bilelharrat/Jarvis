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
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 28) {
                    header
                    if let notice = model.pairingNotice {
                        ErrorCallout(title: "Pair again", message: notice)
                    }
                    macSection
                    codeSection
                    pairButton
                    footer
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 40)
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: failure)
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: browser.macs)
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
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0.1)))
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
        VStack(spacing: 12) {
            ReactorView(mode: working ? .thinking : .idle, size: 136)
            Text("J.A.R.V.I.S.")
                .font(.system(.title, design: .default).weight(.semibold))
                .tracking(7)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HUDText("Companion · Pair with your Mac", color: Palette.cyan)
        }
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("J.A.R.V.I.S. companion. Pair with your Mac.")
    }

    private var macSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(number: "01", title: "Your Mac")
            VStack(spacing: 0) {
                ForEach(browser.macs) { mac in
                    macRow(mac)
                    if mac != browser.macs.last {
                        Divider().overlay(Palette.hairline)
                    }
                }
                if browser.macs.isEmpty {
                    searchRow
                }
            }
            .glassCard(cornerRadius: 18)

            HStack(spacing: 12) {
                Image(systemName: "network")
                    .foregroundStyle(addressFocused ? Palette.cyan : Palette.muted)
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
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.muted)
                    }
                    .accessibilityLabel("Clear address")
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .glassCard(cornerRadius: 16, strength: addressFocused ? 1.8 : 1)

            Text("On your Mac, open Jarvis Settings › iPhone & Watch and turn on “Let my phone connect”. Its addresses are listed there.")
                .font(.footnote)
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
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
            HStack(spacing: 14) {
                Image(systemName: "desktopcomputer")
                    .font(.title3)
                    .foregroundStyle(Palette.cyan)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(mac.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Palette.ink)
                    HUDText(mac.host ?? "Found on this network")
                }
                Spacer()
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? Palette.cyan : Palette.muted.opacity(0.6))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mac.name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var searchRow: some View {
        HStack(spacing: 14) {
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
                    .tint(Palette.cyan)
                    .frame(width: 30)
                Text("Looking for Jarvis on your network…")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionLabel(number: "02", title: "Pairing code")
            CodeEntryField(code: $code, focused: $codeFocused, invalid: isWrongCode)
            if let failure {
                ErrorCallout(title: failure.title, message: failure.message, hint: hint(for: failure))
                    .id(Self.failureID)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            Text("On the Mac, tap “Pair a phone” for a six-digit code. It works once, for five minutes.")
                .font(.footnote)
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                HUDText("This iPhone")
                TextField("iPhone", text: $deviceName)
                    .multilineTextAlignment(.trailing)
                    .foregroundStyle(Palette.ink2)
                    .font(.subheadline)
                    .submitLabel(.done)
                    .accessibilityLabel("Name for this iPhone on the Mac")
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 46)
            .glassCard(cornerRadius: 14, strength: 0.7)
        }
    }

    private var pairButton: some View {
        Button {
            Task { await pair() }
        } label: {
            HStack(spacing: 10) {
                if working {
                    ProgressView().tint(Palette.space)
                } else {
                    Image(systemName: "link")
                }
                Text(working ? "Pairing…" : "Pair with Mac")
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 54)
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(!canPair || working)
    }

    private var footer: some View {
        VStack(spacing: 8) {
            Label("Same Wi‑Fi as the Mac, or Tailscale on both when you’re away.", systemImage: "wifi")
            Label("Your token stays in this iPhone’s Keychain.", systemImage: "lock.fill")
        }
        .font(.caption)
        .foregroundStyle(Palette.muted)
        .labelStyle(FooterLabelStyle())
    }

    // MARK: - Pairing

    private static let failureID = "pairing-failure"

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
        HStack(spacing: 6) {
            configuration.icon.foregroundStyle(Palette.cyan.opacity(0.7))
            configuration.title
        }
    }
}
