import SwiftUI
import UIKit

/// A session's project files, from the iPhone: searchable, each readable (the Mac refuses
/// ones that hold credentials, and binaries).
struct CodeFilesView: View {
    let sessionID: Int

    @Environment(AppModel.self) private var model
    @State private var files: [String]?
    @State private var query = ""

    var body: some View {
        Group {
            if let files {
                let shown = query.trimmed.isEmpty ? files : files.filter { $0.localizedCaseInsensitiveContains(query.trimmed) }
                List(shown.prefix(400), id: \.self) { path in
                    NavigationLink {
                        CodeFileView(sessionID: sessionID, path: path)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text((path as NSString).lastPathComponent).font(.body.monospaced())
                            Text((path as NSString).deletingLastPathComponent)
                                .font(.caption2.monospaced())
                                .foregroundStyle(Palette.muted)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a file")
                .overlay {
                    if shown.isEmpty { ContentUnavailableView.search(text: query) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let result = try await api.codeAction("files", session: sessionID, timeout: 25)
            files = (result["project_files"]?["files"]?.arrayValue ?? []).compactMap(\.stringValue).sorted()
        } catch {
            files = []
            if let problem = model.handle(error) { model.show(problem.message, style: .problem) }
        }
    }
}

/// One file's text, monospaced, scrolling both ways, with Copy.
struct CodeFileView: View {
    let sessionID: Int
    let path: String

    @Environment(AppModel.self) private var model
    @State private var text: String?
    @State private var problem: String?
    @State private var truncated = false

    var body: some View {
        Group {
            if let text {
                ScrollView([.vertical, .horizontal]) {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Palette.ink)
                        .textSelection(.enabled)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .safeAreaInset(edge: .bottom) {
                    if truncated {
                        Text("Only the start of a long file is shown.").font(.caption).foregroundStyle(Palette.muted).padding(.bottom, 4)
                    }
                }
            } else if let problem {
                ContentUnavailableView("Can’t Show It", systemImage: "doc.questionmark", description: Text(problem))
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let text {
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = text
                        Haptics.tap()
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.pairing?.api else { return }
        do {
            let result = try await api.codeAction("file", session: sessionID, ["path": .string(path)], timeout: 20)
            let content = result["file_content"]
            if let error = content?["error"]?.stringValue, !error.isEmpty {
                problem = error
            } else {
                text = content?["text"]?.stringValue ?? ""
                truncated = content?["truncated"]?.boolValue ?? false
            }
        } catch {
            problem = model.handle(error)?.message ?? error.localizedDescription
        }
    }
}
