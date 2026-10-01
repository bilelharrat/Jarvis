import Foundation

/// Something the Mac asks of this iPhone ("phone_asks" in /api/state): a name to look up in
/// its contacts, or "send the calendar now". Offered only while the owner has that sensor on.
struct PhoneAsk: Equatable, Hashable, Sendable, Decodable {
    enum Kind: String, Sendable {
        case contact, calendar, unknown
    }

    var id: String
    var kind: Kind
    var name: String

    init(id: String, kind: Kind, name: String = "") {
        self.id = id
        self.kind = kind
        self.name = name
    }

    private enum Key: String, CodingKey { case id, kind, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        id = c.text(.id) ?? ""
        kind = Kind(rawValue: c.text(.kind) ?? "") ?? .unknown
        name = c.text(.name) ?? ""
    }
}

/// One person found for a "who is" (POST /api/contacts/answer): only what that question
/// needs. Never the address, birthday, notes or picture.
struct ContactCard: Equatable, Sendable {
    struct Detail: Equatable, Sendable {
        var label: String
        var value: String
    }

    static let most = 5  // people in one answer, and numbers or emails per person

    var name: String
    var organization: String = ""
    var jobTitle: String = ""
    var phones: [Detail] = []
    var emails: [Detail] = []

    var body: JSONValue {
        func details(_ list: [Detail]) -> JSONValue? {
            list.isEmpty ? nil : .array(list.prefix(Self.most).map { ["label": .string($0.label), "value": .string($0.value)] })
        }
        return .object(dropping: [
            "name": .string(name),
            "organization": organization.isEmpty ? nil : .string(organization),
            "job_title": jobTitle.isEmpty ? nil : .string(jobTitle),
            "phones": details(phones),
            "emails": details(emails),
        ])
    }
}

/// One event of the phone's next two weeks (POST /api/calendar): when, what, where, and
/// which calendar. Never its notes, attendees or links.
struct PhoneEvent: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String = ""
    var calendar: String = ""

    var body: JSONValue {
        .object(dropping: [
            "title": .string(title),
            "start": .string(start.formatted(.iso8601)),
            "end": .string(end.formatted(.iso8601)),
            "all_day": .bool(allDay),
            "location": location.isEmpty ? nil : .string(location),
            "calendar": calendar.isEmpty ? nil : .string(calendar),
        ])
    }
}
