import Foundation
import PDFKit

/// Projects for Jarvis on the iPhone, as the Claude, ChatGPT and Gemini apps have them: chats
/// kept together, with instructions and files that go with every request in them. Kept on the
/// iPhone (the App Group container). The Mac's own projects are managed from Chats › Your Mac.
struct PhoneProject: Codable, Identifiable, Equatable {
    struct File: Codable, Equatable, Identifiable {
        var name: String
        var text: String
        var added: Date
        var id: String { name }
    }

    var id: UUID
    var name: String
    var instructions: String
    var files: [File]
    var created: Date

    static let maxFiles = 20
    static let fileCharacters = 100_000
    static let noteCharacters = 150_000

    /// What the brain's system prompt carries for a chat in this project.
    var note: String {
        var parts = ["This chat is in the owner's project “\(name)”."]
        if !instructions.trimmed.isEmpty {
            parts.append("The owner's instructions for this project:\n\(instructions)")
        }
        var room = Self.noteCharacters
        for file in files where room > 0 {
            let text = String(file.text.prefix(room))
            parts.append("Project file “\(file.name)”:\n<file>\n\(text)\n</file>")
            room -= text.count
        }
        return parts.joined(separator: "\n\n")
    }

    /// A picked file's text (a PDF read with PDFKit); nil when there's none to keep.
    static func text(of document: PickedDocument) -> String? {
        let text = document.text ?? PDFDocument(data: document.data)?.string
        guard let text, !text.trimmed.isEmpty else { return nil }
        return String(text.prefix(fileCharacters))
    }
}

@MainActor
@Observable
final class ProjectStore {
    static let shared = ProjectStore()

    /// Newest first.
    private(set) var projects: [PhoneProject] = []
    @ObservationIgnored private let url: URL

    init(folder: URL = AppGroup.directory) {
        url = folder.appendingPathComponent("phone-projects.json")
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([PhoneProject].self, from: data) {
            projects = saved
        }
    }

    func project(_ id: UUID?) -> PhoneProject? {
        guard let id else { return nil }
        return projects.first { $0.id == id }
    }

    /// A new project (nil without a name).
    @discardableResult
    func create(name: String, instructions: String = "") -> PhoneProject? {
        let name = String(name.trimmed.prefix(60))
        guard !name.isEmpty else { return nil }
        let project = PhoneProject(id: UUID(), name: name, instructions: String(instructions.prefix(8000)), files: [], created: Date())
        projects.insert(project, at: 0)
        save()
        return project
    }

    func update(_ id: UUID, name: String? = nil, instructions: String? = nil) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        if let name, !name.trimmed.isEmpty { projects[index].name = String(name.trimmed.prefix(60)) }
        if let instructions { projects[index].instructions = String(instructions.prefix(8000)) }
        save()
    }

    /// Adds (or replaces, by name) a file; why not, when it isn't added.
    func addFile(_ id: UUID, name: String, text: String) -> String? {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return "No such project." }
        let text = String(text.prefix(PhoneProject.fileCharacters))
        guard !text.trimmed.isEmpty else { return "There’s no text in \(name) to keep." }
        projects[index].files.removeAll { $0.name == name }
        guard projects[index].files.count < PhoneProject.maxFiles else { return "A project holds \(PhoneProject.maxFiles) files at most." }
        projects[index].files.append(PhoneProject.File(name: name, text: text, added: Date()))
        save()
        return nil
    }

    func removeFile(_ id: UUID, name: String) {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        projects[index].files.removeAll { $0.name == name }
        save()
    }

    /// The project goes; its chats stay, in no project.
    func delete(_ id: UUID) {
        projects.removeAll { $0.id == id }
        save()
        ChatStore.shared.unfileAll(from: id)
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(projects).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
