import Contacts
import EventKit
import Foundation

/// The contacts and calendar sensors, each off until the owner turns it on in Settings
/// (iOS asks its permission then), and the Mac's asks of them.
///
/// Contacts: answered one name at a time when the Mac asks ("who is…" its own Contacts
/// can't answer): at most five people, with their name, job, organisation, numbers and
/// emails. The address book itself never leaves the phone.
///
/// Calendar: the next 14 days of events (title, times, place, calendar name; never notes,
/// attendees or links), sent every 30 minutes while it's on (on opening the app and on
/// background refresh) and when the Mac asks for a fresh copy.
@MainActor
final class PhoneSensors {
    static let shared = PhoneSensors()

    static let contactsKey = "sensors.contacts"
    static let calendarKey = "sensors.calendar"
    private static let calendarSentKey = "sensors.calendar.sent"
    private static let reportedKey = "sensors.reported"  // what the Mac was last told

    nonisolated static let calendarDays = 14
    nonisolated static let calendarEvery: TimeInterval = 30 * 60
    nonisolated static let mostEvents = 500

    private let events = EKEventStore()
    private var answering: Set<String> = []  // asks being answered now
    private var sendingCalendar = false

    var contactsOn: Bool {
        get { UserDefaults.standard.bool(forKey: Self.contactsKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.contactsKey) }
    }

    var calendarOn: Bool {
        get { UserDefaults.standard.bool(forKey: Self.calendarKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.calendarKey) }
    }

    var calendarSentAt: Date? {
        let at = UserDefaults.standard.double(forKey: Self.calendarSentKey)
        return at > 0 ? Date(timeIntervalSince1970: at) : nil
    }

    private var api: JarvisAPI? { PairingStore.load().flatMap { $0.isPinned ? $0.api : nil } }

    // MARK: - Turning them on and off

    /// Asks iOS for Contacts; false when it isn't allowed.
    func turnOnContacts() async -> Bool {
        let allowed = (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
        guard allowed else { return false }
        contactsOn = true
        await report()
        return true
    }

    func turnOffContacts() async {
        contactsOn = false
        await report()
    }

    /// Asks iOS for the calendars (full access: reading needs it), then sends the first copy.
    func turnOnCalendar() async -> Bool {
        let allowed = (try? await events.requestFullAccessToEvents()) ?? false
        guard allowed else { return false }
        calendarOn = true
        await report()
        await sendCalendarIfDue(force: true)
        return true
    }

    func turnOffCalendar() async {
        calendarOn = false
        UserDefaults.standard.removeObject(forKey: Self.calendarSentKey)
        await report()  // the Mac forgets its copy
    }

    /// Unpaired: both off, with nothing to tell (the Mac let this phone go, and what it kept
    /// of it with it).
    func forget() {
        contactsOn = false
        calendarOn = false
        for key in [Self.calendarSentKey, Self.reportedKey] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// Tells the Mac which are on, when that changed since it was last told (or force).
    func report(force: Bool = false) async {
        let flags = "\(contactsOn ? 1 : 0)\(calendarOn ? 1 : 0)"
        guard force || UserDefaults.standard.string(forKey: Self.reportedKey) != flags, let api else { return }
        do {
            try await api.setSensors(contacts: contactsOn, calendar: calendarOn)
            UserDefaults.standard.set(flags, forKey: Self.reportedKey)
        } catch {
            UserDefaults.standard.removeObject(forKey: Self.reportedKey)  // told again next time
        }
    }

    // MARK: - The Mac's asks

    /// From /api/state (in front, and when a silent push woke the app): each ask answered
    /// once, and only by a sensor that's on.
    func answer(_ asks: [PhoneAsk], using api: JarvisAPI) async {
        for ask in asks where !answering.contains(ask.id) {
            switch ask.kind {
            case .contact where contactsOn:
                answering.insert(ask.id)
                let people = lookUp(ask.name)
                _ = try? await api.answerContacts(id: ask.id, people: people)
                answering.remove(ask.id)
            case .calendar where calendarOn:
                answering.insert(ask.id)
                await sendCalendarIfDue(force: true, using: api)
                answering.remove(ask.id)
            default:
                continue
            }
        }
    }

    // MARK: - Contacts

    func lookUp(_ name: String) -> [ContactCard] {
        let name = name.trimmed
        let access = CNContactStore.authorizationStatus(for: .contacts)
        guard contactsOn, !name.isEmpty, access == .authorized || access == .limited else { return [] }
        let keys = [
            CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
            CNContactJobTitleKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
        ] as [CNKeyDescriptor]
        let found = (try? CNContactStore().unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)) ?? []
        return found.prefix(ContactCard.most).compactMap(Self.card)
    }

    /// Only the fields a "who is" needs; nil for a card with no name at all.
    nonisolated static func card(_ contact: CNContact) -> ContactCard? {
        let full = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
        let name = full.isEmpty ? (contact.nickname.isEmpty ? contact.organizationName : contact.nickname) : full
        guard !name.isEmpty else { return nil }
        func label(_ raw: String?) -> String {
            guard let raw, !raw.isEmpty else { return "" }
            return CNLabeledValue<NSString>.localizedString(forLabel: raw)
        }
        return ContactCard(
            name: name,
            organization: name == contact.organizationName ? "" : contact.organizationName,
            jobTitle: contact.jobTitle,
            phones: contact.phoneNumbers.prefix(ContactCard.most).map { .init(label: label($0.label), value: $0.value.stringValue) },
            emails: contact.emailAddresses.prefix(ContactCard.most).map { .init(label: label($0.label), value: $0.value as String) }
        )
    }

    // MARK: - Calendar

    /// On opening the app and on background refresh: every 30 minutes while it's on.
    func sendCalendarIfDue(force: Bool = false, now: Date = Date(), using given: JarvisAPI? = nil) async {
        guard calendarOn, EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return }
        guard force || Self.due(last: calendarSentAt, now: now), !sendingCalendar else { return }
        guard let api = given ?? api else { return }
        sendingCalendar = true
        defer { sendingCalendar = false }
        let found = upcoming(from: now)
        do {
            try await api.sendCalendar(found)
            UserDefaults.standard.set(now.timeIntervalSince1970, forKey: Self.calendarSentKey)
        } catch {
            // Tried again at the next chance; a newer copy replaces it anyway, so it isn't kept.
        }
    }

    nonisolated static func due(last: Date?, now: Date) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= calendarEvery || last > now
    }

    /// From the start of today to 14 days ahead, every calendar on the phone.
    nonisolated static func window(from now: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
        let start = calendar.startOfDay(for: now)
        return (start, calendar.date(byAdding: .day, value: calendarDays, to: start) ?? start.addingTimeInterval(Double(calendarDays) * 86400))
    }

    private func upcoming(from now: Date) -> [PhoneEvent] {
        let (start, end) = Self.window(from: now)
        let found = events.events(matching: events.predicateForEvents(withStart: start, end: end, calendars: nil))
        return Self.report(found.map { event in
            PhoneEvent(
                title: event.title ?? "",
                start: event.startDate,
                end: event.endDate ?? event.startDate,
                allDay: event.isAllDay,
                location: event.location ?? "",
                calendar: event.calendar?.title ?? ""
            )
        })
    }

    /// In time order, trimmed to what the Mac takes, at most 500.
    nonisolated static func report(_ events: [PhoneEvent]) -> [PhoneEvent] {
        events
            .filter { $0.end >= $0.start }
            .sorted { ($0.start, $0.title) < ($1.start, $1.title) }
            .prefix(mostEvents)
            .map { event in
                var event = event
                event.title = String(event.title.trimmed.prefix(200))
                event.location = String(event.location.trimmed.prefix(200))
                event.calendar = String(event.calendar.trimmed.prefix(60))
                return event
            }
    }
}
