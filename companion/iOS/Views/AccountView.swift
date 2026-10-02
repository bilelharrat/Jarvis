import AuthenticationServices
import StoreKit
import SwiftUI

/// Settings › Account: the optional Jarvis account. Signed out, what it adds and Sign in with
/// Apple; signed in, the plan and what's been used, the devices on it, linking a Mac, sync,
/// and signing out or deleting it.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    private var store: AccountStore { AccountStore.shared }

    @State private var showUpgrade = false
    @State private var manageSubscription = false
    @State private var restoring = false
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var removing: Account.Device?

    // Linking a Mac
    @State private var code = ""
    @State private var showScanner = false
    @State private var lookingUp = false
    @State private var offered: (code: String, info: AccountClient.LinkInfo)?
    @State private var linkProblem: String?
    @State private var linkDone: String?
    /// The paired Mac's own word on whether it's linked (nil: it can't say).
    @State private var pairedLink: (linked: Bool, accountID: String?, deviceID: String?)?
    @State private var linkingPaired = false

    // Sync
    @State private var syncOn = SyncEngine.shared.isOn
    @State private var confirmStartOver = false

    var body: some View {
        GlassForm {
            if store.isSignedIn {
                signedIn
            } else {
                signedOut
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.isSignedIn) {
            guard store.isSignedIn else { return }
            await store.refresh()
            await checkPairedMac()
        }
        .onChange(of: model.pendingLinkCode, initial: true) { _, pending in
            guard let pending, store.isSignedIn else { return }
            model.pendingLinkCode = nil
            code = pending
            Task { await lookUp() }
        }
        .sheet(isPresented: $showUpgrade) {
            UpgradeSheet()
        }
        .sheet(isPresented: $showScanner) {
            LinkScanSheet { scanned in
                code = scanned
                Task { await lookUp() }
            }
        }
        .manageSubscriptionsSheet(isPresented: $manageSubscription)
        .confirmationDialog(
            offered.map { "Link “\($0.info.name)”?" } ?? "", isPresented: Binding(get: { offered != nil }, set: { if !$0 { offered = nil } }),
            titleVisibility: .visible, presenting: offered
        ) { offer in
            Button("Link") { Task { await approve(offer.code, offer.info) } }
            Button("Don’t Link", role: .destructive) {
                Task { await store.denyLink(offer.code) }
                offered = nil
            }
            Button("Cancel", role: .cancel) { offered = nil }
        } message: { _ in
            Text("It joins your account: it can use the AI included with your plan, send notifications to this iPhone, be reached through the Jarvis relay, and read what you sync. Only link a Mac that’s yours.")
        }
        .confirmationDialog("Sign out of your Jarvis account?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive) { Task { await store.signOut() } }
        } message: {
            Text("This iPhone leaves the account. Your other devices, your plan and what’s synced stay.")
        }
        .confirmationDialog("Delete your Jarvis account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Account", role: .destructive) { Task { await store.deleteAccount() } }
        } message: {
            Text("Every device is signed out, and your plan record, usage and everything synced are deleted. This can’t be undone. If you subscribe to Jarvis Plus, also cancel the subscription in Settings › Subscriptions, or Apple keeps renewing it.")
        }
        .confirmationDialog(
            removing.map { "Sign out “\($0.name)”?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible, presenting: removing
        ) { device in
            Button("Sign Out", role: .destructive) { Task { await store.removeDevice(device) } }
        } message: { device in
            Text(device.isMac
                ? "It leaves your account at once: no more relay, notifications or sync through it. Link it again with a new code."
                : "It leaves your account and has to sign in again.")
        }
        .confirmationDialog("Start sync over?", isPresented: $confirmStartOver, titleVisibility: .visible) {
            Button("Start Over", role: .destructive) { Task { await SyncEngine.shared.startOver() } }
        } message: {
            Text("Everything synced is deleted from your account and sealed again with a new key, from this iPhone. Your other devices need the new key: iPhones get it through iCloud Keychain; link your Macs again.")
        }
    }

    // MARK: - Signed out

    @ViewBuilder
    private var signedOut: some View {
        Section {
            HStack(spacing: Space.m) {
                OrbMark(size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("A Jarvis Account")
                        .font(.title3.weight(.semibold))
                    Text("Optional. Everything works without one, exactly as it does now.")
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .padding(.vertical, Space.xxs)
            .accessibilityElement(children: .combine)
        }

        Section {
            feature("sparkles", .purple, "AI Included", "Jarvis answers on this iPhone without an API key of your own: a free trial to start, and Jarvis Plus for more.")
            feature("bell.badge.fill", .red, "Notifications from Your Mac", "Approvals and heads-ups reach this iPhone with nothing to set up.")
            feature("globe", .blue, "Your Mac from Anywhere", "No shared Wi‑Fi or Tailscale needed. Encrypted from this iPhone to your Mac; nobody in between can read it.")
            feature("arrow.triangle.2.circlepath", .green, "Sync", "Memory, what Jarvis calls you, and your chats on all your devices, sealed so only they can open them.")
        } header: {
            Text("What It Adds")
        } footer: {
            Text("No name or email is kept (the email Sign in with Apple can share is never stored), and conversations only ever travel sealed.")
        }

        Section {
            SignInWithAppleButton(.signIn) { request in
                store.prepare(request)
            } onCompletion: { result in
                Task { await store.completeSignIn(result) }
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 50)
            .clipShape(Capsule())
            .disabled(store.isWorking)
            .overlay { if store.isWorking { ProgressView() } }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            if let problem = store.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
                    .listRowBackground(Color.clear)
            }
        }
    }

    private func feature(_ symbol: String, _ tint: Color, _ title: String, _ detail: String) -> some View {
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

    // MARK: - Signed in

    @ViewBuilder
    private var signedIn: some View {
        planSection
        devicesSection
        linkSection
        syncSection
        Section {
            Button("Sign Out") { confirmSignOut = true }
                .frame(maxWidth: .infinity)
                .disabled(store.isWorking)
        }
        Section {
            Button("Delete Account", role: .destructive) { confirmDelete = true }
                .frame(maxWidth: .infinity)
                .disabled(store.isWorking)
        } footer: {
            Text("Deletes the account and everything in it. A Jarvis Plus subscription is billed by Apple: cancel it in Settings › Subscriptions too.")
        }
    }

    private var plan: Account.Plan { store.account?.plan ?? Account.Plan() }
    private var usage: Account.Usage { store.account?.usage ?? Account.Usage() }

    private var planSection: some View {
        Section {
            HStack(spacing: Space.m) {
                IconTile(symbol: plan.isPlus ? "sparkles" : "person.crop.circle.fill", tint: plan.isPlus ? .purple : .blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(plan.isPlus ? "Jarvis Plus" : "Free")
                        .font(.title3.weight(.semibold))
                    Text(planDetail)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
                Spacer(minLength: 0)
                if store.account == nil { ProgressView() }
            }
            .accessibilityElement(children: .combine)
            if plan.isPlus || usage.budgetUSD > 0 {
                meter(
                    "Included AI This Month", value: usage.spentFraction,
                    detail: "\(usage.spentUSD.dollars) of \(usage.budgetUSD.dollars)", tint: usage.spentFraction > 0.9 ? .orange : .accentColor
                )
            }
            if usage.voiceDaily > 0 {
                meter(
                    "JARVIS Voice Today", value: usage.voiceFraction,
                    detail: "\(usage.voiceToday.formatted()) of \(usage.voiceDaily.formatted()) characters", tint: .pink
                )
            }
            if !plan.isPlus {
                Button {
                    showUpgrade = true
                } label: {
                    Label("Upgrade to Jarvis Plus", systemImage: "sparkles")
                }
            } else {
                Button {
                    manageSubscription = true
                } label: {
                    Label("Manage Subscription", systemImage: "creditcard")
                }
            }
            Button {
                Task {
                    restoring = true
                    do {
                        try await store.subscriptions.restore()
                    } catch {
                        store.problem = "Couldn’t restore purchases: \(error.localizedDescription)"
                    }
                    restoring = false
                }
            } label: {
                HStack {
                    Label("Restore Purchases", systemImage: "arrow.clockwise")
                    Spacer()
                    if restoring { ProgressView() }
                }
            }
            .disabled(restoring)
            if let problem = store.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
            }
        } header: {
            Text("Plan")
        } footer: {
            Text("The included AI is Claude, through askeden.com, and answers on this iPhone whenever you haven’t added a Claude key of your own. Your own keys always come first.")
        }
    }

    private var planDetail: String {
        if store.account == nil { return "Loading…" }
        if plan.isPlus {
            guard let expires = plan.expires else { return "Active" }
            let day = expires.formatted(date: .abbreviated, time: .omitted)
            return plan.renews == false ? "Ends \(day)" : "Renews \(day)"
        }
        return usage.trialLeftUSD > 0 ? "Trial: \(usage.trialLeftUSD.dollars) left" : "Trial used"
    }

    private func meter(_ title: String, value: Double, detail: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                Text(title)
                Spacer()
                Text(detail)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Palette.muted)
            }
            ProgressView(value: value)
                .tint(tint)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Devices

    private var devicesSection: some View {
        Section {
            ForEach(store.account?.devices ?? []) { device in
                HStack(spacing: Space.s) {
                    IconTile(symbol: device.symbol, tint: device.isMac ? .gray : .blue)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(device.name)
                        Text(deviceDetail(device))
                            .font(.footnote)
                            .foregroundStyle(device.isThis ? Color.green : Palette.muted)
                    }
                    Spacer(minLength: 0)
                    if !device.isThis {
                        Button("Sign Out \(device.name)", systemImage: "minus.circle.fill") { removing = device }
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.red)
                            .buttonStyle(.borderless)
                    }
                }
                .accessibilityElement(children: .combine)
                .swipeActions {
                    if !device.isThis {
                        Button("Sign Out", role: .destructive) { removing = device }
                    }
                }
            }
        } header: {
            Text("Devices")
        } footer: {
            Text("Signing a device out takes it off your account at once.")
        }
    }

    private func deviceDetail(_ device: Account.Device) -> String {
        if device.isThis { return "This iPhone" }
        var parts: [String] = []
        if device.isMac, device.relay { parts.append("Reachable from anywhere") }
        if let seen = device.lastSeen { parts.append("Seen \(seen.formatted(.relative(presentation: .named)))") }
        return parts.isEmpty ? (device.isMac ? "Linked" : "Signed in") : parts.joined(separator: " · ")
    }

    // MARK: - Linking a Mac

    /// The paired Mac isn't on this account yet (and can say so).
    private var canLinkPairedMac: Bool {
        guard model.pairing != nil, let pairedLink else { return false }
        return !pairedLink.linked || pairedLink.accountID != store.credential?.accountID
    }

    private var linkSection: some View {
        Section {
            if canLinkPairedMac, let pairing = model.pairing {
                Button {
                    Task { await linkPaired() }
                } label: {
                    HStack(spacing: Space.s) {
                        IconTile(symbol: "laptopcomputer", tint: .blue)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Link \(pairing.macLabel)")
                                .foregroundStyle(Palette.ink)
                            Text("The Mac this iPhone is paired with, in one tap")
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        if linkingPaired { ProgressView() }
                    }
                }
                .disabled(linkingPaired || model.isOffline)
            }
            HStack(spacing: Space.s) {
                IconTile(symbol: "link", tint: .teal)
                TextField("Code from your Mac", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { Task { await lookUp() } }
                    .accessibilityLabel("Link code")
                Button("Scan the Code", systemImage: "qrcode.viewfinder") { showScanner = true }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            }
            if LinkCode.normalize(code) != nil {
                Button {
                    Task { await lookUp() }
                } label: {
                    HStack {
                        Text("Continue")
                        Spacer()
                        if lookingUp { ProgressView() }
                    }
                }
                .disabled(lookingUp)
            }
            if let linkProblem {
                Text(linkProblem)
                    .font(.footnote)
                    .foregroundStyle(Palette.amber)
            } else if let linkDone {
                Text(linkDone)
                    .font(.footnote)
                    .foregroundStyle(Color.green)
            }
        } header: {
            Text("Link a Mac")
        } footer: {
            Text("When you link it in JARVIS on your Mac, it shows a code like K7QM-4ZTR and a QR code. Type the code or scan it here.")
        }
    }

    private func lookUp() async {
        guard !lookingUp else { return }
        guard let normalized = LinkCode.normalize(code) else {
            linkProblem = "That isn’t a link code. It has eight letters and numbers, like K7QM-4ZTR."
            return
        }
        lookingUp = true
        defer { lookingUp = false }
        linkProblem = nil
        linkDone = nil
        do {
            let info = try await store.lookUpLink(normalized)
            offered = (normalized, info)
        } catch AccountError.notFound {
            linkProblem = "No Mac is waiting with that code. Check it, or make a new one on the Mac."
        } catch {
            linkProblem = AccountStore.words(error)
        }
    }

    private func approve(_ code: String, _ info: AccountClient.LinkInfo) async {
        offered = nil
        do {
            let linked = try await store.approveLink(code, info: info)
            self.code = ""
            linkDone = "\(linked.name ?? info.name) is linked."
            await checkPairedMac()
        } catch {
            Haptics.failure()
            linkProblem = AccountStore.words(error)
        }
    }

    private func linkPaired() async {
        guard let api = model.pairing?.api else { return }
        linkingPaired = true
        defer { linkingPaired = false }
        linkProblem = nil
        do {
            let linked = try await store.linkPairedMac(api)
            model.learnMacDeviceID(linked.deviceID)
            linkDone = "\(linked.name ?? model.pairing?.macLabel ?? "Your Mac") is linked."
            await checkPairedMac()
        } catch {
            Haptics.failure()
            linkProblem = (error as? JarvisError)?.message ?? AccountStore.words(error)
        }
    }

    private func checkPairedMac() async {
        guard let api = model.pairing?.api else { return }
        pairedLink = await store.pairedMacLink(api)
        if let deviceID = pairedLink?.deviceID, pairedLink?.accountID == store.credential?.accountID {
            model.learnMacDeviceID(deviceID)
        }
    }

    // MARK: - Sync

    private var syncSection: some View {
        let engine = SyncEngine.shared
        return Section {
            Toggle(isOn: Binding(get: { syncOn }, set: { on in
                syncOn = on
                engine.isOn = on
            })) {
                HStack(spacing: Space.s) {
                    IconTile(symbol: "arrow.triangle.2.circlepath", tint: .green)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Sync")
                        Text(syncText(engine))
                            .font(.footnote)
                            .foregroundStyle(syncProblem(engine) ? Palette.amber : Palette.muted)
                    }
                }
            }
            if syncOn {
                Button("Start Sync Over", role: .destructive) { confirmStartOver = true }
                    .disabled(engine.status == .syncing)
            }
        } header: {
            Text("Sync")
        } footer: {
            Text("Memory, what Jarvis calls you, and this iPhone’s chats, on all your devices. Each is sealed on the device with a key kept in your iCloud Keychain; askeden.com stores it without being able to read it.")
        }
    }

    private func syncText(_ engine: SyncEngine) -> String {
        guard syncOn else { return "Off" }
        switch engine.status {
        case .off: return "Starting…"
        case .syncing: return "Syncing…"
        case .idle:
            guard let last = engine.lastSynced else { return "Up to date" }
            return "Up to date · \(last.formatted(date: .omitted, time: .shortened))"
        case .needsKey: return "Waiting for the sync key from iCloud Keychain. If it never comes, start sync over."
        case .wrongKey: return "This iPhone’s sync key doesn’t open your account’s data. Nothing was changed. Start sync over to use this iPhone’s."
        case .problem(let words): return words
        }
    }

    private func syncProblem(_ engine: SyncEngine) -> Bool {
        switch engine.status {
        case .needsKey, .wrongKey, .problem: true
        default: false
        }
    }
}

/// Jarvis Plus, bought with Apple's own purchase sheet. The purchase carries the account id
/// (appAccountToken), and goes to askeden.com as soon as Apple confirms it.
private struct UpgradeSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SubscriptionStoreView(productIDs: Subscriptions.productIDs) {
            VStack(spacing: Space.s) {
                OrbMark(size: 64)
                Text("Jarvis Plus")
                    .font(.largeTitle.weight(.bold))
                Text("AI included: Jarvis answers on your iPhone, and on your Mac, without an API key of your own, with a generous monthly allowance of Claude and more JARVIS voice each day.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .multilineTextAlignment(.center)
            }
            .padding(Space.l)
        }
        .storeButton(.visible, for: .restorePurchases)
        .storeButton(.visible, for: .cancellation)
        .inAppPurchaseOptions { _ in
            await MainActor.run { AccountStore.shared.appAccountToken.map { [.appAccountToken($0)] } ?? [] }
        }
        .onInAppPurchaseCompletion { _, result in
            guard case .success(.success(let verification)) = result else { return }
            await AccountStore.shared.subscriptions.handle(verification)
            await AccountStore.shared.refresh()
            dismiss()
        }
        .preferredColorScheme(.dark)
    }
}

/// Scan the QR code a Mac shows while it waits to be linked (`jarvis-link://XXXX-XXXX`).
private struct LinkScanSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access = CameraAccess.current
    @State private var notALink = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch access {
                case .granted:
                    QRCameraView { text in handle(text) }
                        .ignoresSafeArea()
                    Viewfinder()
                        .frame(width: 250, height: 250)
                        .accessibilityHidden(true)
                case .undetermined:
                    ProgressView().tint(Palette.ink2)
                case .denied, .unavailable:
                    VStack(spacing: Space.m) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(Palette.muted)
                        Text(access == .denied ? "Camera is off for J.A.R.V.I.S." : "No camera here")
                            .font(.headline)
                        Text("Type the code your Mac shows instead.")
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                    }
                    .padding(Space.xl)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if access == .granted {
                    Text(notALink ? "That isn’t a Jarvis link code." : "Point at the code JARVIS on your Mac shows.")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(notALink ? Palette.amber : Palette.ink)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.m)
                        .frame(maxWidth: .infinity)
                        .glassCard(cornerRadius: 20)
                        .padding(.horizontal, Space.m)
                        .padding(.bottom, Space.s)
                }
            }
            .navigationTitle("Scan Link Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task {
            if access == .undetermined { access = await CameraAccess.request() }
        }
    }

    private func handle(_ text: String) {
        guard let code = LinkCode.fromQR(text) else {
            if !notALink { Haptics.failure() }
            notALink = true
            return
        }
        Haptics.answered(negative: false)
        onScan(code)
        dismiss()
    }
}
