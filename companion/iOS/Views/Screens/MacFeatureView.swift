import SwiftUI

/// One of the Mac's features as a list: memory, goals, timers, reminders, markets, background
/// tasks, music, Shortcuts, switches, journal, meeting notes, research, invoices. Rows come
/// from the feature's endpoint, read leniently; each feature adds the actions it has (add,
/// complete, stop, run, play, forget).
struct MacFeatureView: View {
    let feature: MacFeature
    @Environment(AppModel.self) private var model
    @State private var state: Loadable<JSONValue> = .loading
    @State private var search = ""
    @State private var adding = ""
    @State private var working: String?
    @State private var opened: JSONValue?

    var body: some View {
        Group {
            if let value = state.value {
                list(value)
            } else {
                LoadStateView(state: state, retry: load)
            }
        }
        .navigationTitle(feature.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: Binding(get: { opened.map(Opened.init) }, set: { opened = $0?.value })) { item in
            NavigationStack { DocumentView(feature: feature, item: item.value) }
        }
    }

    private struct Opened: Identifiable {
        let value: JSONValue
        var id: String { value["id"]?.stringValue ?? value["day"]?.stringValue ?? "" }
    }

    // MARK: - Loading

    private var path: String { "api/\(feature.rawValue)" }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            var query: [URLQueryItem] = []
            if feature == .memory, !search.trimmed.isEmpty { query = [URLQueryItem(name: "q", value: search.trimmed)] }
            let value = try await api.json(path, query: query)
            withAnimation { state = .loaded(value) }
        } catch {
            if let problem = model.handle(error) { state = .failed(problem) }
        }
    }

    private func act(_ endpoint: String, _ body: JSONValue, id: String, done: String? = nil) async {
        guard let api = model.pairing?.api else { return }
        working = id
        defer { working = nil }
        do {
            let reply = try await api.json(post: endpoint, body)
            Haptics.tap()
            if let error = reply["error"]?.stringValue {
                model.show(error, style: .problem)
            } else if let done {
                model.show(done, style: .success)
            }
            await load()
        } catch {
            if let problem = model.handle(error) { model.show(problem.errorDescription ?? problem.title, style: .problem) }
        }
    }

    // MARK: - The list

    @ViewBuilder
    private func list(_ value: JSONValue) -> some View {
        List {
            switch feature {
            case .memory:
                addRow(prompt: "Something for Jarvis to remember") { text in
                    await act("api/memory/add", ["text": .string(text)], id: "add", done: "Remembered on your Mac.")
                }
                section("Remembered", items(value["items"])) { item in
                    Button("Forget", role: .destructive) {
                        Task { await act("api/memory/forget", ["id": item["id"] ?? .null], id: id(item)) }
                    }
                }
                section("People", items(value["people"]))
                section("Promises", items(value["promises"]))
            case .reminders:
                if value["available"]?.boolValue == false {
                    Section { Label(text(value["reason"]) ?? "Reminders isn’t available on your Mac.", systemImage: "exclamationmark.triangle") }
                }
                addRow(prompt: "New reminder") { text in
                    await act("api/reminders/add", ["title": .string(text)], id: "add", done: "Added on your Mac.")
                }
                Section {
                    ForEach(items(value["items"]), id: \.self) { item in
                        Button {
                            Task { await act("api/reminders/complete", ["id": item["id"] ?? .null], id: id(item), done: "Done.") }
                        } label: {
                            HStack(spacing: Space.s) {
                                Image(systemName: working == id(item) ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(working == id(item) ? Color.accentColor : Palette.muted)
                                    .contentTransition(.symbolEffect(.replace))
                                row(item)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            case .markets:
                if let summary = value["summary"], summary != .null {
                    Section {
                        if let headline = text(summary["headline"]) {
                            Text(headline).font(.headline)
                        }
                        ForEach(items(summary["indices"]), id: \.self) { quote in
                            quoteRow(quote)
                        }
                    } footer: {
                        if let asOf = text(summary["as_of"]).flatMap(LooseDate.parse) {
                            Text("As of \(asOf.formatted(date: .omitted, time: .shortened)) on your Mac")
                        }
                    }
                }
                if !items(value["watchlist"]).isEmpty {
                    Section("Watchlist") {
                        ForEach(items(value["watchlist"]), id: \.self) { quote in
                            quoteRow(quote)
                        }
                    }
                }
                if !items(value["alerts"]).isEmpty {
                    Section("Price Alerts") {
                        ForEach(items(value["alerts"]), id: \.self) { alert in
                            LabeledContent(text(alert["symbol"]) ?? "") {
                                Text(alertText(alert))
                            }
                        }
                    }
                }
            case .tasks:
                section(nil, items(value["items"])) { item in
                    if item["status"]?.stringValue == "running" {
                        Button("Stop", role: .destructive) {
                            Task { await act("api/tasks/stop", ["id": item["id"] ?? .null], id: id(item), done: "Stopped.") }
                        }
                    }
                }
            case .timers:
                section(nil, items(value["items"])) { item in
                    Button("Cancel", role: .destructive) {
                        Task { await act("api/timers/cancel", ["id": item["id"] ?? .null], id: id(item), done: "Cancelled.") }
                    }
                }
            case .music:
                musicControls(value)
            case .shortcuts:
                Section {
                    ForEach(items(value["items"]), id: \.self) { item in
                        let name = text(item["name"]) ?? text(item) ?? ""
                        Button {
                            Task { await act("api/shortcuts/run", ["name": .string(name)], id: name, done: "Ran \(name) on your Mac.") }
                        } label: {
                            HStack {
                                Label(name, systemImage: "play.circle.fill")
                                Spacer()
                                if working == name { ProgressView() }
                            }
                        }
                    }
                } footer: {
                    Text("Your Mac’s Shortcuts, including Home scenes. Tap one to run it on your Mac.")
                }
            case .switches:
                Section {
                    ForEach(items(value["items"]), id: \.self) { item in
                        switchRow(item)
                    }
                }
            case .meetings, .research, .journal:
                Section {
                    ForEach(items(value["items"]), id: \.self) { item in
                        Button { opened = item } label: {
                            HStack {
                                row(item)
                                Spacer(minLength: Space.xs)
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            case .goals:
                section(nil, items(value["items"]))
                section("Constraints", items(value["constraints"]))
            case .invoices:
                if let stripe = text(value["stripe"]) {
                    Section { Label(stripe, systemImage: "creditcard") }
                }
                section("Clients", items(value["clients"]))
                section("Recurring", items(value["recurring"]))
            }
        }
        .overlay {
            if isEmpty(value) {
                ContentUnavailableView(emptyTitle, systemImage: feature.symbol, description: Text("Nothing here on your Mac yet."))
            }
        }
    }

    private var emptyTitle: String {
        switch feature {
        case .tasks: "Nothing Running"
        case .timers: "No Timers"
        case .reminders: "All Done"
        default: "Nothing Yet"
        }
    }

    private func isEmpty(_ value: JSONValue) -> Bool {
        guard feature != .music, feature != .markets else { return false }
        let keys = ["items", "people", "promises", "clients", "constraints"]
        return keys.allSatisfy { (value[$0]?.arrayValue ?? []).isEmpty }
    }

    // MARK: - Rows

    private func section(_ title: String?, _ rows: [JSONValue]) -> some View {
        section(title, rows) { (_: JSONValue) in EmptyView() }
    }

    @ViewBuilder
    private func section<Swipe: View>(_ title: String?, _ rows: [JSONValue], @ViewBuilder swipe: @escaping (JSONValue) -> Swipe) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.self) { item in
                    row(item).swipeActions { swipe(item) }
                }
            } header: {
                if let title { Text(title) }
            }
        }
    }

    private func row(_ item: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title(of: item))
                .foregroundStyle(Palette.ink)
                .lineLimit(4)
            if let subtitle = subtitle(of: item) {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    private func quoteRow(_ quote: JSONValue) -> some View {
        let change = quote["change_pct"]?.doubleValue
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(text(quote["symbol"]) ?? "")
                    .font(.headline)
                if let name = text(quote["name"]) {
                    Text(name).font(.footnote).foregroundStyle(Palette.muted)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let price = quote["price"]?.doubleValue {
                    Text(price.formatted(.number.precision(.fractionLength(2))))
                        .font(.body.monospacedDigit())
                }
                if let change {
                    Text(String(format: "%+.2f%%", change))
                        .font(.footnote.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 5).fill(change >= 0 ? Color.green : Color.red))
                }
            }
        }
    }

    private func switchRow(_ item: JSONValue) -> some View {
        let name = text(item["name"]) ?? ""
        let on = item["on"]?.boolValue ?? false
        return Toggle(isOn: Binding(get: { on }, set: { value in
            Task { await act("api/switches/set", ["name": .string(name), "on": .bool(value)], id: name) }
        })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(text(item["label"]) ?? name.capitalized)
                if let detail = text(item["note"]) {
                    Text(detail).font(.footnote).foregroundStyle(Palette.muted)
                }
            }
        }
        .disabled(working == name || item["settable"]?.boolValue == false)
    }

    @ViewBuilder
    private func musicControls(_ value: JSONValue) -> some View {
        let playing = value["now_playing"]
        Section {
            VStack(spacing: Space.m) {
                Image(systemName: "music.note")
                    .font(.system(size: 44))
                    .foregroundStyle(.white)
                    .frame(width: 120, height: 120)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.pink.gradient))
                VStack(spacing: 2) {
                    Text(text(playing?["title"]) ?? "Not Playing")
                        .font(.title3.weight(.semibold))
                    if let artist = text(playing?["artist"]) {
                        Text(artist).foregroundStyle(Palette.ink2)
                    }
                }
                HStack(spacing: Space.xl) {
                    musicButton("backward.fill", "previous")
                    musicButton(playing?["state"]?.stringValue == "playing" ? "pause.fill" : "play.fill",
                                playing?["state"]?.stringValue == "playing" ? "pause" : "play", large: true)
                    musicButton("forward.fill", "next")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.m)
        } footer: {
            Text("Plays on your Mac.")
        }
        let playlists = items(value["playlists"])
        if !playlists.isEmpty {
            Section("Playlists") {
                ForEach(playlists, id: \.self) { playlist in
                    let name = text(playlist["name"]) ?? text(playlist) ?? ""
                    Button {
                        Task { await act("api/music", ["action": "playlist", "name": .string(name)], id: name, done: "Playing \(name).") }
                    } label: {
                        Label(name, systemImage: "music.note.list")
                    }
                }
            }
        }
    }

    private func musicButton(_ symbol: String, _ action: String, large: Bool = false) -> some View {
        Button {
            Task { await act("api/music", ["action": .string(action)], id: action) }
        } label: {
            Image(systemName: symbol)
                .font(large ? .largeTitle : .title2)
                .foregroundStyle(Palette.ink)
                .frame(width: 56, height: 56)
        }
        .buttonStyle(.plain)
    }

    private func addRow(prompt: String, _ add: @escaping (String) async -> Void) -> some View {
        Section {
            HStack {
                TextField(prompt, text: $adding)
                    .submitLabel(.done)
                    .onSubmit { submit(add) }
                Button("Add") { submit(add) }
                    .disabled(adding.trimmed.isEmpty || working == "add")
            }
        }
    }

    private func submit(_ add: @escaping (String) async -> Void) {
        let text = adding.trimmed
        guard !text.isEmpty else { return }
        adding = ""
        Task { await add(text) }
    }

    private func alertText(_ alert: JSONValue) -> String {
        let value = alert["value"]?.doubleValue.map { $0.formatted(.number.precision(.fractionLength(0...2))) } ?? ""
        let kind = switch alert["kind"]?.stringValue {
        case "above": "Above \(value)"
        case "below": "Below \(value)"
        default: "Moves \(value)%"
        }
        return alert["fired"].flatMap { $0 == .null ? nil : $0 } != nil ? "\(kind) · Fired" : kind
    }

    // MARK: - Reading lenient JSON

    private func items(_ value: JSONValue?) -> [JSONValue] {
        value?.arrayValue ?? []
    }

    private func id(_ item: JSONValue) -> String {
        text(item["id"]) ?? title(of: item)
    }

    private func text(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let text)?: text.trimmed.nilIfEmpty
        case .int(let number)?: String(number)
        case .double(let number)?: number.formatted()
        default: nil
        }
    }

    /// The row's main line: the first field that reads like a title.
    private func title(of item: JSONValue) -> String {
        if let plain = text(item) { return plain }
        if feature == .journal, let day = text(item["day"]).flatMap(PhoneTools.day) {
            return day.formatted(.dateTime.weekday(.wide).month(.wide).day())
        }
        for key in ["title", "text", "name", "label", "summary", "goal", "symbol", "entry", "client", "number"] {
            if let value = text(item[key]) { return value }
        }
        return "Item"
    }

    /// The details under it: status, dates, amounts, previews.
    private func subtitle(of item: JSONValue) -> String? {
        var parts: [String] = []
        for key in ["when", "status", "horizon", "why", "to", "list", "outcome", "last_action", "email", "progress", "amount", "total", "note", "notes", "preview", "detail"] {
            if let value = text(item[key]), value != title(of: item) { parts.append(value) }
        }
        for key in ["due", "date", "started", "next_run"] {
            if let raw = text(item[key]), let date = LooseDate.parse(raw) {
                let label = key == "ends_at" ? "ends" : key == "next_run" ? "next" : key
                parts.append("\(label.capitalized) \(date.formatted(date: .abbreviated, time: .shortened))")
                break
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// A meeting's notes, a research report or a journal day, fetched in full.
private struct DocumentView: View {
    let feature: MacFeature
    let item: JSONValue
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var state: Loadable<JSONValue> = .loading

    var body: some View {
        Group {
            if let document = state.value {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.s) {
                        if let date = (document["date"]?.stringValue ?? document["day"]?.stringValue).flatMap(LooseDate.parse) {
                            Text(date.formatted(date: .complete, time: feature == .journal ? .omitted : .shortened))
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                        }
                        Text(TranscriptRow.markdown(document["text"]?.stringValue ?? ""))
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            } else {
                LoadStateView(state: state, retry: load)
            }
        }
        .navigationTitle(item["title"]?.stringValue ?? feature.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done", systemImage: "checkmark") { dismiss() } }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        let query = feature == .journal
            ? URLQueryItem(name: "day", value: item["day"]?.stringValue)
            : URLQueryItem(name: "id", value: item["id"]?.stringValue)
        do {
            state = .loaded(try await api.json("api/\(feature.rawValue)/item", query: [query]))
        } catch {
            if let problem = model.handle(error) { state = .failed(problem) }
        }
    }
}
