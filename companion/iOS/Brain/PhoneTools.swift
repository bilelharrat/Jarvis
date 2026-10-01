import Contacts
import CoreLocation
import EventKit
import Foundation
import HomeKit
import MapKit
import MediaPlayer
import UserNotifications

/// Something Jarvis prepared that the owner finishes with a tap: a text or email to send,
/// a call to place. Jarvis never sends or calls by itself.
enum PhoneAction: Identifiable, Equatable, Sendable {
    case message(recipients: [String], body: String)
    case email(recipients: [String], subject: String, body: String)
    case call(number: String, name: String)
    case open(URL)

    var id: String {
        switch self {
        case .message(let to, let body): "m:\(to):\(body.hashValue)"
        case .email(let to, let subject, _): "e:\(to):\(subject)"
        case .call(let number, _): "c:\(number)"
        case .open(let url): "o:\(url)"
        }
    }
}

/// What Jarvis can do on the iPhone itself, as Claude tools: Calendar, Reminders, Contacts,
/// weather, Maps, timers, Music, Home, Health, its own memory, and (when paired) the Mac.
/// Each tool runs here and answers with a short text result for Claude.
@MainActor
final class PhoneTools {
    /// Prepared during the current turn, shown to the owner when it ends.
    private(set) var actions: [PhoneAction] = []
    /// Reaches the Mac for what only the Mac can do; nil when there's no Mac.
    var mac: JarvisAPI?

    private let events = EKEventStore()
    private let locator = Locator()
    private lazy var home = HomeLink()

    func startTurn() {
        actions = []
    }

    // MARK: - The tool list

    func definitions() -> [JSONValue] {
        var tools: [JSONValue] = [
            tool("calendar_events", "Lists events in the owner's calendars. Use for anything about their schedule.", [
                "start": prop("string", "First day, YYYY-MM-DD. Defaults to today."),
                "days": prop("integer", "How many days from start, 1-31. Defaults to 1."),
            ]),
            tool("add_calendar_event", "Adds an event to the owner's default calendar.", [
                "title": prop("string", "What the event is."),
                "start": prop("string", "Local start, YYYY-MM-DDTHH:MM."),
                "end": prop("string", "Local end, YYYY-MM-DDTHH:MM. Defaults to an hour after start."),
                "location": prop("string", "Where, if known."),
                "notes": prop("string", "Notes, if any."),
            ], required: ["title", "start"]),
            tool("reminders", "Lists the owner's open reminders.", [:]),
            tool("add_reminder", "Adds a reminder, optionally due at a time (it alerts then).", [
                "title": prop("string", "The reminder."),
                "due": prop("string", "Local due time, YYYY-MM-DDTHH:MM, if any."),
            ], required: ["title"]),
            tool("complete_reminder", "Marks a reminder done, by the id from reminders.", [
                "id": prop("string", "The reminder's id."),
            ], required: ["id"]),
            tool("find_contact", "Looks someone up in the owner's contacts: phone numbers and emails.", [
                "name": prop("string", "Who."),
            ], required: ["name"]),
            tool("weather", "Current weather and the next three days, here or in a named place.", [
                "place": prop("string", "A city or place. Defaults to where the owner is."),
            ]),
            tool("where_am_i", "The owner's current location, as a place name.", [:]),
            tool("travel_time", "How long it takes to get somewhere from here right now.", [
                "destination": prop("string", "An address or place name."),
                "mode": prop("string", "driving, walking or transit. Defaults to driving."),
            ], required: ["destination"]),
            tool("find_places", "Searches Maps for places near the owner (restaurants, shops, addresses).", [
                "query": prop("string", "What to look for."),
            ], required: ["query"]),
            tool("set_timer", "Starts a timer on the iPhone that alerts when it ends.", [
                "minutes": prop("number", "Length in minutes (fractions allowed)."),
                "label": prop("string", "What it's for."),
            ], required: ["minutes"]),
            tool("timers", "Lists running timers.", [:]),
            tool("cancel_timer", "Cancels a running timer by id, or all of them with id \"all\".", [
                "id": prop("string", "The timer's id, or all."),
            ], required: ["id"]),
            tool("music", "Controls music on the iPhone: play something from the owner's library, pause, resume, skip, or say what's playing.", [
                "action": prop("string", "play, pause, resume, next, previous or now_playing."),
                "query": prop("string", "For play: a song, artist, album or playlist name. Empty plays everything shuffled."),
            ], required: ["action"]),
            tool("home", "The owner's Apple Home: list accessories and scenes, run a scene, or turn an accessory on or off.", [
                "action": prop("string", "list, run_scene or set_power."),
                "name": prop("string", "The scene or accessory's name (for run_scene and set_power)."),
                "on": prop("boolean", "For set_power: on (true) or off (false)."),
            ], required: ["action"]),
            tool("health_today", "The owner's activity from Apple Health: today so far and yesterday (steps, sleep, resting heart rate, workouts).", [:]),
            tool("remember", "Saves a fact about the owner to remember in later conversations.", [
                "fact": prop("string", "The fact, in a short sentence."),
            ], required: ["fact"]),
            tool("forget", "Forgets a remembered fact, by the words in it.", [
                "words": prop("string", "Words from the fact."),
            ], required: ["words"]),
            tool("draft_text", "Prepares a text message for the owner to send with one tap. Never says it was sent.", [
                "to": prop("string", "A phone number, email or the contact's name."),
                "body": prop("string", "The message."),
            ], required: ["to", "body"]),
            tool("draft_email", "Prepares an email for the owner to send with one tap. Never says it was sent.", [
                "to": prop("string", "An email address or the contact's name."),
                "subject": prop("string", "The subject."),
                "body": prop("string", "The message."),
            ], required: ["to", "subject", "body"]),
            tool("call", "Offers to call someone (the owner taps to place it).", [
                "to": prop("string", "A phone number or the contact's name."),
            ], required: ["to"]),
            tool("open_link", "Offers the owner a web page or app link to open.", [
                "url": prop("string", "The https URL."),
            ], required: ["url"]),
        ]
        if mac != nil {
            tools.append(tool("ask_mac", "Hands a request to Jarvis on the owner's Mac, which has their files, mail, iMessage, browser, Jarvis Code, notes and everything on the Mac. Use it for anything that needs the Mac.", [
                "request": prop("string", "The request, in the owner's words."),
            ], required: ["request"]))
        }
        // Anthropic's own, run on their side.
        tools.append(["type": "web_search_20260209", "name": "web_search", "max_uses": 5])
        tools.append(["type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 3])
        return tools
    }

    private func tool(_ name: String, _ description: String, _ properties: [String: JSONValue], required: [String] = []) -> JSONValue {
        [
            "name": .string(name),
            "description": .string(description),
            "eager_input_streaming": true,
            "input_schema": [
                "type": "object",
                "properties": .object(properties),
                "required": .array(required.map { .string($0) }),
            ],
        ]
    }

    private func prop(_ type: String, _ description: String) -> JSONValue {
        ["type": .string(type), "description": .string(description)]
    }

    // MARK: - Running a tool

    struct Result {
        var text: String
        var isError = false
    }

    func run(_ name: String, input: JSONValue) async -> Result {
        do {
            return Result(text: try await perform(name, input))
        } catch let problem as ToolProblem {
            return Result(text: problem.message, isError: true)
        } catch {
            return Result(text: error.localizedDescription, isError: true)
        }
    }

    struct ToolProblem: Error {
        let message: String
    }

    private func perform(_ name: String, _ input: JSONValue) async throws -> String {
        func string(_ key: String) -> String? { input[key]?.stringValue?.trimmed.nilIfEmpty }
        func need(_ key: String) throws -> String {
            guard let value = string(key) else { throw ToolProblem(message: "Missing \(key).") }
            return value
        }
        switch name {
        case "calendar_events": return try await calendarEvents(start: string("start"), days: input["days"]?.intValue ?? 1)
        case "add_calendar_event":
            return try await addEvent(title: try need("title"), start: try need("start"), end: string("end"), location: string("location"), notes: string("notes"))
        case "reminders": return try await reminders()
        case "add_reminder": return try await addReminder(title: try need("title"), due: string("due"))
        case "complete_reminder": return try await completeReminder(id: try need("id"))
        case "find_contact": return try await findContact(try need("name"))
        case "weather": return try await weather(place: string("place"))
        case "where_am_i": return try await whereAmI()
        case "travel_time": return try await travelTime(to: try need("destination"), mode: string("mode") ?? "driving")
        case "find_places": return try await findPlaces(try need("query"))
        case "set_timer":
            guard let minutes = input["minutes"]?.doubleValue, minutes > 0 else { throw ToolProblem(message: "Give the length in minutes.") }
            return try await Timers.start(minutes: minutes, label: string("label") ?? "Timer")
        case "timers": return Timers.list()
        case "cancel_timer": return Timers.cancel(try need("id"))
        case "music": return try await music(action: try need("action"), query: string("query"))
        case "home": return try await home.perform(action: try need("action"), name: string("name"), on: input["on"]?.boolValue)
        case "health_today": return try await health()
        case "remember":
            LocalMemory.shared.add(try need("fact"))
            return "Remembered."
        case "forget":
            let removed = LocalMemory.shared.forget(matching: try need("words"))
            return removed == 0 ? "Nothing remembered matched that." : "Forgot \(removed) fact\(removed == 1 ? "" : "s")."
        case "draft_text":
            let to = try await recipient(try need("to"), wantsPhone: true)
            actions.append(.message(recipients: [to], body: try need("body")))
            return "The text is ready for the owner to look over and send. Say it's ready; it isn't sent yet."
        case "draft_email":
            let to = try await recipient(try need("to"), wantsPhone: false)
            actions.append(.email(recipients: [to], subject: try need("subject"), body: try need("body")))
            return "The email is ready for the owner to look over and send. Say it's ready; it isn't sent yet."
        case "call":
            let target = try need("to")
            let number = try await recipient(target, wantsPhone: true)
            actions.append(.call(number: number, name: target))
            return "A Call button is showing; the owner taps it to place the call."
        case "open_link":
            guard let url = URL(string: try need("url")), url.scheme == "https" else { throw ToolProblem(message: "Only https links.") }
            actions.append(.open(url))
            return "The link is showing for the owner to open."
        case "ask_mac":
            guard let mac else { throw ToolProblem(message: "No Mac is paired.") }
            let request = try need("request")
            var opened = false
            var waited: TimeInterval = 0
            while true {
                do {
                    let result = try await mac.ask(request, timeout: 90)
                    if result.done { return result.reply.isEmpty ? "The Mac did it." : result.reply }
                    return result.approvals.isEmpty
                        ? "The Mac is still working on it; its answer will show in the app."
                        : "The Mac needs the owner's OK first; the card is in the app."
                } catch let error as JarvisError where error.neverDelivered && waited < 20 {
                    // JARVIS on the Mac may have been quit: open it there, then ask again.
                    if !opened {
                        guard await mac.wake() else { throw Self.unreachable(error) }
                        opened = true
                    }
                    try await Task.sleep(for: .seconds(2))
                    waited += 2
                } catch {
                    throw Self.unreachable(error)
                }
            }
        default:
            throw ToolProblem(message: "There's no tool called \(name).")
        }
    }

    private static func unreachable(_ error: Error) -> ToolProblem {
        ToolProblem(message: "The Mac can't be reached right now (\((error as? JarvisError)?.title ?? error.localizedDescription)).")
    }

    // MARK: - Calendar and Reminders

    private func calendarAccess() async throws {
        guard try await events.requestFullAccessToEvents() else {
            throw ToolProblem(message: "Calendar access is off for J.A.R.V.I.S. (Settings › Privacy › Calendars).")
        }
    }

    private func reminderAccess() async throws {
        guard try await events.requestFullAccessToReminders() else {
            throw ToolProblem(message: "Reminders access is off for J.A.R.V.I.S. (Settings › Privacy › Reminders).")
        }
    }

    private func calendarEvents(start: String?, days: Int) async throws -> String {
        try await calendarAccess()
        let calendar = Calendar.current
        let first = start.flatMap(Self.day) ?? calendar.startOfDay(for: Date())
        let last = calendar.date(byAdding: .day, value: max(1, min(31, days)), to: first) ?? first
        let found = events.events(matching: events.predicateForEvents(withStart: first, end: last, calendars: nil))
            .sorted { $0.startDate < $1.startDate }
        guard !found.isEmpty else { return "No events." }
        return found.prefix(60).map { event in
            var line = event.isAllDay
                ? "\(event.startDate.formatted(.dateTime.weekday().month().day())), all day: \(event.title ?? "")"
                : "\(event.startDate.formatted(.dateTime.weekday().month().day().hour().minute()))–\(event.endDate.formatted(date: .omitted, time: .shortened)): \(event.title ?? "")"
            if let location = event.location?.nilIfEmpty { line += " @ \(location)" }
            return line
        }.joined(separator: "\n")
    }

    private func addEvent(title: String, start: String, end: String?, location: String?, notes: String?) async throws -> String {
        try await calendarAccess()
        guard let begins = Self.moment(start) else { throw ToolProblem(message: "Couldn't read the start time \(start).") }
        let event = EKEvent(eventStore: events)
        event.title = title
        event.startDate = begins
        event.endDate = end.flatMap(Self.moment) ?? begins.addingTimeInterval(3600)
        event.location = location
        event.notes = notes
        event.calendar = events.defaultCalendarForNewEvents
        try events.save(event, span: .thisEvent)
        return "Added \(title) on \(begins.formatted(.dateTime.weekday().month().day().hour().minute()))."
    }

    private func reminders() async throws -> String {
        try await reminderAccess()
        let predicate = events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let items: [EKReminder] = await withCheckedContinuation { continuation in
            events.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
        guard !items.isEmpty else { return "No open reminders." }
        return items.prefix(60).map { item in
            var line = "[\(item.calendarItemIdentifier)] \(item.title ?? "")"
            if let due = item.dueDateComponents?.date { line += " (due \(due.formatted(.dateTime.month().day().hour().minute())))" }
            return line
        }.joined(separator: "\n")
    }

    private func addReminder(title: String, due: String?) async throws -> String {
        try await reminderAccess()
        let reminder = EKReminder(eventStore: events)
        reminder.title = title
        reminder.calendar = events.defaultCalendarForNewReminders()
        if let due, let date = Self.moment(due) {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            reminder.addAlarm(EKAlarm(absoluteDate: date))
        }
        try events.save(reminder, commit: true)
        return "Added the reminder \(title)."
    }

    private func completeReminder(id: String) async throws -> String {
        try await reminderAccess()
        guard let reminder = events.calendarItem(withIdentifier: id) as? EKReminder else {
            throw ToolProblem(message: "No reminder with that id; list them first.")
        }
        reminder.isCompleted = true
        try events.save(reminder, commit: true)
        return "Done: \(reminder.title ?? "the reminder")."
    }

    // MARK: - Contacts

    private func contacts(named name: String) async throws -> [CNContact] {
        let store = CNContactStore()
        guard try await store.requestAccess(for: .contacts) else {
            throw ToolProblem(message: "Contacts access is off for J.A.R.V.I.S. (Settings › Privacy › Contacts).")
        }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
                    CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
        return try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)
    }

    private func findContact(_ name: String) async throws -> String {
        let found = try await contacts(named: name)
        guard !found.isEmpty else { return "No contact matches \(name)." }
        return found.prefix(5).map { contact in
            let full = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            let phones = contact.phoneNumbers.map { "\(CNLabeledValue<CNPhoneNumber>.localizedString(forLabel: $0.label ?? "")): \($0.value.stringValue)" }
            let emails = contact.emailAddresses.map { $0.value as String }
            return ([full.isEmpty ? contact.organizationName : full] + phones + emails).joined(separator: "; ")
        }.joined(separator: "\n")
    }

    /// A number or address as given, or the contact's first one.
    private func recipient(_ who: String, wantsPhone: Bool) async throws -> String {
        let digits = who.filter { $0.isNumber || $0 == "+" }
        if wantsPhone, digits.count >= 6 { return who }
        if who.contains("@") { return who }
        guard let contact = try await contacts(named: who).first else {
            throw ToolProblem(message: "No contact matches \(who). Ask the owner for the number or address.")
        }
        if wantsPhone, let phone = contact.phoneNumbers.first?.value.stringValue { return phone }
        if let email = contact.emailAddresses.first?.value as String? { return email }
        if let phone = contact.phoneNumbers.first?.value.stringValue { return phone }
        throw ToolProblem(message: "\(who) has no number or email in Contacts.")
    }

    // MARK: - Weather and Maps

    private func weather(place: String?) async throws -> String {
        let (latitude, longitude, label): (Double, Double, String)
        if let place {
            let found = try await OpenMeteo.geocode(place)
            (latitude, longitude, label) = (found.latitude, found.longitude, found.name)
        } else {
            let here = try await locator.current()
            (latitude, longitude, label) = (here.coordinate.latitude, here.coordinate.longitude, "where you are")
        }
        return try await OpenMeteo.forecast(latitude: latitude, longitude: longitude, label: label)
    }

    private func whereAmI() async throws -> String {
        let here = try await locator.current()
        let name = await locator.placeName(for: here)
        return name ?? String(format: "%.4f, %.4f", here.coordinate.latitude, here.coordinate.longitude)
    }

    private func mapItem(for query: String, near here: CLLocation?) async throws -> MKMapItem {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        if let here { request.region = MKCoordinateRegion(center: here.coordinate, latitudinalMeters: 50_000, longitudinalMeters: 50_000) }
        guard let item = try await MKLocalSearch(request: request).start().mapItems.first else {
            throw ToolProblem(message: "Maps couldn't find \(query).")
        }
        return item
    }

    private func travelTime(to destination: String, mode: String) async throws -> String {
        let here = try await locator.current()
        let target = try await mapItem(for: destination, near: here)
        let request = MKDirections.Request()
        request.source = MKMapItem.forCurrentLocation()
        request.destination = target
        request.departureDate = Date()
        request.transportType = switch mode.lowercased() {
        case "walking": .walking
        case "transit": .transit
        default: .automobile
        }
        let eta = try await MKDirections(request: request).calculateETA()
        let minutes = Int((eta.expectedTravelTime / 60).rounded())
        let distance = Measurement(value: eta.distance, unit: UnitLength.meters).formatted(.measurement(width: .abbreviated, usage: .road))
        return "\(target.name ?? destination): about \(minutes) min by \(mode) (\(distance)), arriving \(eta.expectedArrivalDate.formatted(date: .omitted, time: .shortened))."
    }

    private func findPlaces(_ query: String) async throws -> String {
        let here = try? await locator.current()
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        if let here { request.region = MKCoordinateRegion(center: here.coordinate, latitudinalMeters: 8000, longitudinalMeters: 8000) }
        let items = try await MKLocalSearch(request: request).start().mapItems
        guard !items.isEmpty else { return "Nothing found for \(query)." }
        return items.prefix(8).map { item in
            var line = item.name ?? query
            if let address = item.address?.shortAddress { line += " — \(address)" }
            if let here, let location = item.location as CLLocation? {
                line += String(format: " (%.1f km)", location.distance(from: here) / 1000)
            }
            if let phone = item.phoneNumber { line += ", \(phone)" }
            return line
        }.joined(separator: "\n")
    }

    // MARK: - Music

    private func music(action: String, query: String?) async throws -> String {
        let player = MPMusicPlayerController.systemMusicPlayer
        switch action.lowercased() {
        case "pause":
            player.pause()
            return "Paused."
        case "resume":
            player.play()
            return "Playing."
        case "next":
            player.skipToNextItem()
            return "Skipped."
        case "previous":
            player.skipToPreviousItem()
            return "Back one."
        case "now_playing":
            guard let item = player.nowPlayingItem else { return "Nothing is playing." }
            return [item.title, item.artist, item.albumTitle].compactMap { $0 }.joined(separator: " — ")
        case "play":
            let status = await withCheckedContinuation { continuation in
                MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard status == .authorized else { throw ToolProblem(message: "Music library access is off for J.A.R.V.I.S.") }
            guard let query else {
                player.setQueue(with: MPMediaQuery.songs())
                player.shuffleMode = .songs
                player.play()
                return "Playing your library, shuffled."
            }
            for (make, property, kind) in [
                (MPMediaQuery.playlists, MPMediaPlaylistPropertyName, "playlist"),
                (MPMediaQuery.artists, MPMediaItemPropertyArtist, "artist"),
                (MPMediaQuery.albums, MPMediaItemPropertyAlbumTitle, "album"),
                (MPMediaQuery.songs, MPMediaItemPropertyTitle, "song"),
            ] {
                let search = make()
                search.addFilterPredicate(MPMediaPropertyPredicate(value: query, forProperty: property, comparisonType: .contains))
                if let items = search.items, !items.isEmpty {
                    player.setQueue(with: MPMediaItemCollection(items: items))
                    player.shuffleMode = kind == "song" || kind == "album" ? .off : .songs
                    player.play()
                    return "Playing the \(kind) \(items.first.flatMap { kind == "artist" ? $0.artist : kind == "album" ? $0.albumTitle : $0.title } ?? query)."
                }
            }
            return "Nothing in the library matches \(query)."
        default:
            throw ToolProblem(message: "Unknown music action \(action).")
        }
    }

    // MARK: - Health

    private func health() async throws -> String {
        let service = HealthService.shared
        guard service.available else { return "Apple Health isn't available on this device." }
        guard service.enabled else {
            return "The Health summary is off. The owner can turn it on in J.A.R.V.I.S. Settings › Sensors."
        }
        let now = Date()
        let calendar = Calendar.current
        var lines: [String] = []
        for (label, day) in [("Today so far", now), ("Yesterday", calendar.date(byAdding: .day, value: -1, to: now) ?? now)] {
            let summary = await service.summary(for: day, now: now)
            var parts: [String] = []
            if let steps = summary.steps { parts.append("\(steps) steps") }
            if let sleep = summary.sleepHours { parts.append(String(format: "%.1f h sleep", sleep)) }
            if let heart = summary.restingHeartRate { parts.append("resting heart rate \(heart)") }
            if let workouts = summary.workouts, !workouts.isEmpty {
                parts.append(workouts.map { "\($0.kind) \($0.minutes) min" }.joined(separator: ", "))
            }
            lines.append("\(label): \(parts.isEmpty ? "nothing recorded" : parts.joined(separator: ", ")).")
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Dates

    nonisolated static func day(_ text: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: text)
    }

    nonisolated static func moment(_ text: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        for format in ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            formatter.dateFormat = format
            if let date = formatter.date(from: text) { return date }
        }
        return ISO8601DateFormatter().date(from: text)
    }
}

// MARK: - Location

/// One fix, when Jarvis needs to know where the owner is.
@MainActor
final class Locator {
    private var session: CLServiceSession?

    func current() async throws -> CLLocation {
        session = session ?? CLServiceSession(authorization: .whenInUse)
        let deadline = Date().addingTimeInterval(12)
        for try await update in CLLocationUpdate.liveUpdates() {
            if let location = update.location { return location }
            if update.authorizationDenied || update.authorizationDeniedGlobally {
                throw PhoneTools.ToolProblem(message: "Location is off for J.A.R.V.I.S. (Settings › Privacy › Location Services).")
            }
            if Date() > deadline { break }
        }
        throw PhoneTools.ToolProblem(message: "Couldn't get a location fix.")
    }

    func placeName(for location: CLLocation) async -> String? {
        guard let request = MKReverseGeocodingRequest(location: location),
              let item = try? await request.mapItems.first else { return nil }
        return item.address?.shortAddress ?? item.name
    }
}

// MARK: - Weather (Open-Meteo: no key, no account)

enum OpenMeteo {
    struct Place {
        var name: String
        var latitude: Double
        var longitude: Double
    }

    static func geocode(_ name: String) async throws -> Place {
        var components = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        components.queryItems = [.init(name: "name", value: name), .init(name: "count", value: "1")]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let first = json["results"]?.arrayValue?.first,
              let latitude = first["latitude"]?.doubleValue, let longitude = first["longitude"]?.doubleValue else {
            throw PhoneTools.ToolProblem(message: "Couldn't find a place called \(name).")
        }
        let label = [first["name"]?.stringValue, first["admin1"]?.stringValue, first["country"]?.stringValue].compactMap { $0 }.joined(separator: ", ")
        return Place(name: label, latitude: latitude, longitude: longitude)
    }

    static func forecast(latitude: Double, longitude: Double, label: String) async throws -> String {
        let fahrenheit = Locale.current.measurementSystem == .us
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            .init(name: "latitude", value: String(latitude)),
            .init(name: "longitude", value: String(longitude)),
            .init(name: "current", value: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m"),
            .init(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
            .init(name: "timezone", value: "auto"),
            .init(name: "forecast_days", value: "4"),
            .init(name: "temperature_unit", value: fahrenheit ? "fahrenheit" : "celsius"),
            .init(name: "wind_speed_unit", value: fahrenheit ? "mph" : "kmh"),
        ]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        let unit = fahrenheit ? "°F" : "°C"
        let current = json["current"]
        var lines: [String] = []
        if let temperature = current?["temperature_2m"]?.doubleValue {
            let feels = current?["apparent_temperature"]?.doubleValue.map { ", feels like \(Int($0.rounded()))\(unit)" } ?? ""
            let sky = describe(current?["weather_code"]?.intValue)
            let wind = current?["wind_speed_10m"]?.doubleValue.map { ", wind \(Int($0.rounded())) \(fahrenheit ? "mph" : "km/h")" } ?? ""
            lines.append("Now in \(label): \(Int(temperature.rounded()))\(unit), \(sky)\(feels)\(wind).")
        }
        let daily = json["daily"]
        let days = daily?["time"]?.arrayValue ?? []
        for (index, day) in days.enumerated() {
            let high = daily?["temperature_2m_max"]?.arrayValue?[safe: index]?.doubleValue
            let low = daily?["temperature_2m_min"]?.arrayValue?[safe: index]?.doubleValue
            let rain = daily?["precipitation_probability_max"]?.arrayValue?[safe: index]?.intValue
            let sky = describe(daily?["weather_code"]?.arrayValue?[safe: index]?.intValue)
            let name = index == 0 ? "Today" : (day.stringValue.flatMap(PhoneTools.day)?.formatted(.dateTime.weekday(.wide)) ?? "")
            var line = "\(name): \(sky)"
            if let high, let low { line += ", \(Int(high.rounded()))/\(Int(low.rounded()))\(unit)" }
            if let rain { line += ", \(rain)% chance of rain" }
            lines.append(line + ".")
        }
        return lines.joined(separator: "\n")
    }

    /// Now and today's range, as the Today screen shows the Mac's weather.
    static func current(latitude: Double, longitude: Double) async throws -> Weather {
        let fahrenheit = Locale.current.measurementSystem == .us
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            .init(name: "latitude", value: String(latitude)),
            .init(name: "longitude", value: String(longitude)),
            .init(name: "current", value: "temperature_2m,weather_code"),
            .init(name: "daily", value: "temperature_2m_max,temperature_2m_min"),
            .init(name: "timezone", value: "auto"),
            .init(name: "forecast_days", value: "1"),
            .init(name: "temperature_unit", value: fahrenheit ? "fahrenheit" : "celsius"),
        ]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        var weather = Weather()
        weather.unit = "°"
        weather.temp = json["current"]?["temperature_2m"]?.doubleValue
        weather.code = json["current"]?["weather_code"]?.intValue
        weather.summary = describe(weather.code)
        weather.high = json["daily"]?["temperature_2m_max"]?.arrayValue?.first?.doubleValue
        weather.low = json["daily"]?["temperature_2m_min"]?.arrayValue?.first?.doubleValue
        return weather
    }

    /// WMO weather codes in words.
    static func describe(_ code: Int?) -> String {
        switch code ?? -1 {
        case 0: "clear"
        case 1: "mostly clear"
        case 2: "partly cloudy"
        case 3: "overcast"
        case 45, 48: "foggy"
        case 51, 53, 55, 56, 57: "drizzle"
        case 61, 63, 66: "rain"
        case 65, 67: "heavy rain"
        case 71, 73, 77: "snow"
        case 75: "heavy snow"
        case 80, 81: "showers"
        case 82: "heavy showers"
        case 85, 86: "snow showers"
        case 95: "thunderstorms"
        case 96, 99: "thunderstorms with hail"
        default: "unknown conditions"
        }
    }
}

// MARK: - Timers (time-sensitive notifications)

enum Timers {
    struct Running: Codable {
        var id: String
        var label: String
        var endsAt: Date
    }

    private static let key = "brain.timers"

    static func running() -> [Running] {
        let all = (UserDefaults.standard.data(forKey: key)).flatMap { try? JSONDecoder().decode([Running].self, from: $0) } ?? []
        return all.filter { $0.endsAt > Date() }
    }

    private static func save(_ timers: [Running]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(timers), forKey: key)
    }

    static func start(minutes: Double, label: String) async throws -> String {
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
        let seconds = max(1, minutes * 60)
        let id = "timer.\(UUID().uuidString.prefix(8))"
        let content = UNMutableNotificationContent()
        content.title = label
        content.body = "Your \(Self.length(seconds)) timer is done."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)))
        save(running() + [Running(id: id, label: label, endsAt: Date().addingTimeInterval(seconds))])
        return "Timer \(id) set for \(Self.length(seconds)), ending at \(Date().addingTimeInterval(seconds).formatted(date: .omitted, time: .shortened))."
    }

    static func list() -> String {
        let timers = running()
        guard !timers.isEmpty else { return "No timers running." }
        return timers.map { timer in
            "[\(timer.id)] \(timer.label): \(Self.length(timer.endsAt.timeIntervalSinceNow)) left"
        }.joined(separator: "\n")
    }

    static func cancel(_ id: String) -> String {
        let timers = running()
        let gone = id == "all" ? timers : timers.filter { $0.id == id }
        guard !gone.isEmpty else { return "No timer with that id." }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: gone.map(\.id))
        save(timers.filter { timer in !gone.contains { $0.id == timer.id } })
        return gone.count == 1 ? "Cancelled \(gone[0].label)." : "Cancelled \(gone.count) timers."
    }

    static func length(_ seconds: TimeInterval) -> String {
        Duration.seconds(max(0, seconds.rounded())).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide, maximumUnitCount: 2))
    }
}

// MARK: - Apple Home

@MainActor
final class HomeLink: NSObject, HMHomeManagerDelegate {
    private let manager = HMHomeManager()
    private var ready = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
    }

    nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        Task { @MainActor in
            self.ready = true
            self.waiting.forEach { $0.resume() }
            self.waiting = []
        }
    }

    private func homes() async -> [HMHome] {
        if !ready {
            await withCheckedContinuation { continuation in
                waiting.append(continuation)
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(6))
                    if let index = self.waiting.firstIndex(where: { _ in true }), !self.ready {
                        self.waiting.remove(at: index).resume()
                    }
                }
            }
        }
        return manager.homes
    }

    func perform(action: String, name: String?, on: Bool?) async throws -> String {
        let homes = await homes()
        guard !homes.isEmpty else {
            throw PhoneTools.ToolProblem(message: "No Apple Home is set up, or Home access is off for J.A.R.V.I.S.")
        }
        switch action {
        case "list":
            return homes.map { home in
                let accessories = home.accessories.map { accessory in
                    let power = powerState(of: accessory).map { $0 ? " (on)" : " (off)" } ?? ""
                    return "\(accessory.name)\(accessory.room.map { " in \($0.name)" } ?? "")\(power)"
                }
                let scenes = home.actionSets.map(\.name)
                return "\(home.name): accessories — \(accessories.joined(separator: ", ")); scenes — \(scenes.joined(separator: ", "))"
            }.joined(separator: "\n")
        case "run_scene":
            guard let name else { throw PhoneTools.ToolProblem(message: "Which scene?") }
            for home in homes {
                if let scene = home.actionSets.first(where: { $0.name.localizedCaseInsensitiveContains(name) }) {
                    try await home.executeActionSet(scene)
                    return "Ran \(scene.name)."
                }
            }
            throw PhoneTools.ToolProblem(message: "No scene called \(name).")
        case "set_power":
            guard let name, let on else { throw PhoneTools.ToolProblem(message: "Which accessory, and on or off?") }
            for home in homes {
                if let accessory = home.accessories.first(where: { $0.name.localizedCaseInsensitiveContains(name) }),
                   let power = accessory.services.flatMap(\.characteristics).first(where: { $0.characteristicType == HMCharacteristicTypePowerState }) {
                    try await power.writeValue(on)
                    return "Turned \(accessory.name) \(on ? "on" : "off")."
                }
            }
            throw PhoneTools.ToolProblem(message: "No accessory called \(name) that can be switched.")
        default:
            throw PhoneTools.ToolProblem(message: "Unknown Home action \(action).")
        }
    }

    private func powerState(of accessory: HMAccessory) -> Bool? {
        accessory.services.flatMap(\.characteristics)
            .first { $0.characteristicType == HMCharacteristicTypePowerState }?
            .value as? Bool
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
