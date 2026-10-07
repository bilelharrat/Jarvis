import AuthenticationServices
import Foundation
import StoreKit
import UIKit

/// The owner's optional Jarvis account on this iPhone: signing in with Apple, the account as
/// askeden.com last described it, this device's push token, linking Macs, and the plan.
/// Everything in the app works without it; it adds Jarvis Plus (AI included), notifications
/// without setup, reaching the Mac from anywhere, and sync.
@MainActor
@Observable
final class AccountStore {
    static let shared = AccountStore()

    /// This device's credential (the token stays in the Keychain).
    private(set) var credential: AccountCredential?
    /// The account as askeden.com last described it.
    private(set) var account: Account?
    /// What went wrong last, for the account screen.
    var problem: String?
    private(set) var isWorking = false

    @ObservationIgnored let subscriptions = Subscriptions()
    @ObservationIgnored private var nonce: String?
    @ObservationIgnored private var started = false

    nonisolated private static let plusKey = "account.plus"
    private static let pushSentKey = "account.push.sent"

    /// Jarvis Plus, as last seen (read from anywhere, without the account).
    nonisolated static var cachedPlus: Bool { UserDefaults.standard.bool(forKey: plusKey) }

    init() {
        credential = AccountKeychain.load()
    }

    var isSignedIn: Bool { credential != nil }

    /// The API on this device's token (nil when signed out).
    var client: AccountClient? { credential.map { AccountClient(token: $0.token) } }

    /// At launch: purchases, the account, push, sync.
    func start() {
        guard !started else { return }
        started = true
        subscriptions.start(store: self)
        guard isSignedIn else { return }
        Task {
            await refresh()
            await sendPushToken()
            await subscriptions.sendNewestEntitlement()
        }
        SyncEngine.shared.start()
    }

    // MARK: - Sign in with Apple

    /// Readies Apple's request: no name or email, and a fresh nonce whose hash Apple signs.
    func prepare(_ request: ASAuthorizationAppleIDRequest) {
        let raw = SignInNonce.make()
        nonce = raw
        request.requestedScopes = []
        request.nonce = SignInNonce.sha256Hex(raw)
    }

    func completeSignIn(_ result: Result<ASAuthorization, Error>) async {
        problem = nil
        switch result {
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            problem = "Sign in with Apple didn’t finish: \(error.localizedDescription)"
        case .success(let authorization):
            guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identity = apple.identityToken.flatMap({ String(data: $0, encoding: .utf8) }),
                  let nonce else {
                problem = "Apple didn’t send what Jarvis needs to sign you in. Try again."
                return
            }
            let code = apple.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
            await signIn(identityToken: identity, nonce: nonce, authorizationCode: code)
        }
    }

    private func signIn(identityToken: String, nonce: String, authorizationCode: String?) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await AccountClient().signInWithApple(
                identityToken: identityToken, nonce: nonce, authorizationCode: authorizationCode, device: Self.thisDevice
            )
            guard let parsed = AccountCredential.parse(result.token), parsed.accountID == result.account.id else {
                throw AccountError.malformed
            }
            try AccountKeychain.save(parsed)
            self.nonce = nil
            credential = parsed
            remember(result.account)
            UserDefaults.standard.removeObject(forKey: Self.pushSentKey)
            await MacRouter.shared.reload()
            Haptics.answered(negative: false)
            await PushCoordinator.shared.registerIfAllowed()
            await sendPushToken()
            await subscriptions.sendNewestEntitlement()
            SyncEngine.shared.start()
        } catch {
            Haptics.failure()
            problem = Self.words(error)
        }
    }

    static var thisDevice: AccountClient.DeviceInfo {
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "1.0") (\(info?["CFBundleVersion"] as? String ?? "1"))"
        return AccountClient.DeviceInfo(name: UIDevice.current.name, kind: "iphone", appVersion: version)
    }

    // MARK: - The account

    func refresh() async {
        guard let client else { return }
        do {
            remember(try await client.account())
            problem = nil
        } catch {
            handle(error)
        }
    }

    /// Signs this iPhone out (askeden.com forgets this device), then forgets the account here.
    func signOut() async {
        isWorking = true
        defer { isWorking = false }
        if let client { try? await client.removeDevice("me") }
        forget()
    }

    /// Deletes the account and everything in it (devices, plan record, usage, sync).
    func deleteAccount() async -> Bool {
        guard let client else { return false }
        isWorking = true
        defer { isWorking = false }
        do {
            try await client.deleteAccount()
            SyncKeyStore.clear()  // nothing it sealed exists anymore
            forget()
            return true
        } catch {
            handle(error)
            return false
        }
    }

    func removeDevice(_ device: Account.Device) async {
        guard let client, !device.isThis else { return }
        do {
            try await client.removeDevice(device.id)
            await refresh()
        } catch {
            handle(error)
        }
    }

    /// askeden.com turned this token down (the proxy said so): forget it, if it's still ours.
    func tokenRejected(_ token: String) {
        guard credential?.token == token else { return }
        forget()
        problem = AccountError.signedOut.errorDescription
    }

    /// Forgets the account on this iPhone (the sync key stays: it's the owner's, in iCloud
    /// Keychain; Eden sync's keys, this iPhone's alone, go).
    func forget() {
        AccountKeychain.clear()
        credential = nil
        account = nil
        UserDefaults.standard.removeObject(forKey: Self.plusKey)
        UserDefaults.standard.removeObject(forKey: Self.pushSentKey)
        SyncEngine.shared.signedOut()
        EdenTrust.shared.signedOut()
        Task { await MacRouter.shared.reload() }
    }

    func remember(_ account: Account) {
        self.account = account
        UserDefaults.standard.set(account.plan.isPlus, forKey: Self.plusKey)
    }

    /// A 401 forgets the account; anything else is shown.
    func handle(_ error: Error) {
        if case AccountError.signedOut = error {
            forget()
        }
        problem = Self.words(error)
    }

    static func words(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: - Push

    /// Tells askeden.com where to push (the APNs token and which APNs it belongs to): after
    /// signing in, and whenever the token changes.
    func sendPushToken(force: Bool = false) async {
        guard let client, let credential, let token = PushCoordinator.shared.token else { return }
        let environment = PushCoordinator.environment
        let key = "\(credential.deviceID)|\(token)|\(environment)"
        if !force, UserDefaults.standard.string(forKey: Self.pushSentKey) == key { return }
        do {
            try await client.updateThisDevice(["apns_token": .string(token), "apns_env": .string(environment)])
            UserDefaults.standard.set(key, forKey: Self.pushSentKey)
        } catch {
            if case AccountError.signedOut = error { forget() }
        }
    }

    // MARK: - Linking a Mac

    /// What a Mac's code is for ("Link “Bilel's MacBook Air”?").
    func lookUpLink(_ code: String) async throws -> AccountClient.LinkInfo {
        guard let client else { throw AccountError.signedOut }
        do {
            return try await client.linkInfo(code: code)
        } catch {
            if case AccountError.signedOut = error { forget() }
            throw error
        }
    }

    /// Lets the Mac in, handing it the sync key sealed to the Mac's own key (when this iPhone
    /// has one).
    func approveLink(_ code: String, info: AccountClient.LinkInfo) async throws -> AccountClient.Linked {
        guard let client else { throw AccountError.signedOut }
        var sealed: LinkSeal.Sealed?
        // The sync key goes only to a Mac; a browser never gets it.
        if !info.isWeb, let key = SyncKeyStore.load(), let publicKey = info.publicKey {
            sealed = try LinkSeal.seal(syncKey: key.data, macPublicKey: publicKey)
        }
        do {
            let linked = try await client.approveLink(code: code, sealedKey: sealed?.sealedKey, senderKey: sealed?.senderKey)
            Haptics.answered(negative: false)
            await refresh()
            return linked
        } catch {
            if case AccountError.signedOut = error { forget() }
            throw error
        }
    }

    func denyLink(_ code: String) async {
        try? await client?.denyLink(code: code)
    }

    /// The paired Mac's own word on whether it's linked (the companion's GET /api/account):
    /// nil when the Mac can't say (an older Jarvis, or it can't be reached).
    func pairedMacLink(_ api: JarvisAPI) async -> (linked: Bool, accountID: String?, deviceID: String?)? {
        guard let json = try? await api.json("api/account", timeout: 8) else { return nil }
        return (json["linked"]?.boolValue ?? false, json["account_id"]?.stringValue, json["device_id"]?.stringValue)
    }

    /// One tap: the paired Mac starts a link (the companion's POST /api/account/link) and this
    /// iPhone approves it straight away.
    func linkPairedMac(_ api: JarvisAPI) async throws -> AccountClient.Linked {
        let started = try await api.json(post: "api/account/link", [:], timeout: 20)
        guard let raw = started["code"]?.stringValue, let code = LinkCode.normalize(raw) else { throw AccountError.malformed }
        let info = try await lookUpLink(code)
        return try await approveLink(code, info: info)
    }

    // MARK: - The plan

    /// The App Store transaction (its JWS) to askeden.com, which checks it and moves the plan.
    @discardableResult
    func sendTransaction(_ jws: String) async -> Bool {
        guard let client else { return false }
        do {
            remember(try await client.sendTransaction(jws))
            return true
        } catch {
            if case AccountError.signedOut = error { forget() }
            return false
        }
    }

    /// The account id as StoreKit's appAccountToken.
    var appAccountToken: UUID? { credential.flatMap { UUID(uuidString: $0.accountID) } }
}

/// Jarvis Plus through the App Store (StoreKit 2): purchases carry the account id as their
/// appAccountToken, and every transaction goes to askeden.com, which checks Apple's signature
/// before it changes the plan.
@MainActor
final class Subscriptions {
    static let productIDs = ["com.askeden.jarvis.plus.monthly", "com.askeden.jarvis.plus.yearly"]

    private var updates: Task<Void, Never>?
    private weak var store: AccountStore?

    /// At launch: listens for renewals, refunds and purchases made elsewhere.
    func start(store: AccountStore) {
        self.store = store
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
    }

    /// One transaction: sent to askeden.com, then finished. When it can't be sent yet (no
    /// connection) it stays unfinished, so StoreKit offers it again.
    func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        guard Self.productIDs.contains(transaction.productID) else {
            await transaction.finish()
            return
        }
        guard let store, store.isSignedIn else {
            await transaction.finish()  // the plan follows the account; it's sent once signed in
            return
        }
        if await store.sendTransaction(result.jwsRepresentation) {
            await transaction.finish()
        }
    }

    /// The newest current Jarvis Plus entitlement, so askeden.com's plan matches Apple's.
    func sendNewestEntitlement() async {
        guard let store, store.isSignedIn else { return }
        var newest: (date: Date, jws: String)?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, Self.productIDs.contains(transaction.productID) else { continue }
            if newest == nil || transaction.purchaseDate > newest!.date {
                newest = (transaction.purchaseDate, result.jwsRepresentation)
            }
        }
        if let newest { await store.sendTransaction(newest.jws) }
    }

    /// Restore Purchases: asks the App Store, then tells askeden.com.
    func restore() async throws {
        try await AppStore.sync()
        await sendNewestEntitlement()
        await store?.refresh()
    }
}
