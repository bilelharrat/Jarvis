import Foundation
import WidgetKit

/// Keeps the widget snapshot current and tells WidgetKit only when what the widgets show
/// changed (reloads are budgeted by the system).
@MainActor
final class SnapshotPublisher {
    static let shared = SnapshotPublisher(store: .shared)

    private let store: SnapshotStore
    private var last: WidgetSnapshot?
    private var lastWrite = Date.distantPast
    /// A new snapshot was written that looks different (the iPhone passes it to the Watch).
    var onChange: ((WidgetSnapshot) -> Void)?

    init(store: SnapshotStore) {
        self.store = store
        last = store.read()
    }

    /// The Mac answered with this state.
    func publish(_ remote: RemoteState, macName: String, now: Date = Date()) {
        let snapshot = WidgetSnapshot.from(remote, macName: macName, at: now)
        let changed = !snapshot.looksTheSame(as: last)
        // Unchanged, it's still worth writing now and then, so "last heard" stays true.
        guard changed || now.timeIntervalSince(lastWrite) > 5 * 60 else { return }
        write(snapshot, changed: changed, now: now)
    }

    /// The Mac didn't answer: the widgets say so.
    func markOffline(now: Date = Date()) {
        guard let current = last ?? store.read(), current.online else { return }
        write(current.offline(), changed: true, now: now)
    }

    /// Unpaired: the widgets ask to pair again.
    func clear() {
        store.clear()
        last = nil
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// A snapshot from elsewhere (the iPhone, on the Watch).
    func adopt(_ snapshot: WidgetSnapshot, now: Date = Date()) {
        write(snapshot, changed: !snapshot.looksTheSame(as: last), now: now)
    }

    private func write(_ snapshot: WidgetSnapshot, changed: Bool, now: Date) {
        store.write(snapshot)
        last = snapshot
        lastWrite = now
        if changed {
            WidgetCenter.shared.reloadAllTimelines()
            onChange?(snapshot)
        }
    }
}
