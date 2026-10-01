import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A picture waiting in the composer (a photo, a screenshot, something pasted), sent with
/// the next question.
struct Attachment: Identifiable, Equatable {
    /// Pictures in one question: what the Mac takes at once.
    static let limit = 4

    let id = UUID()
    let image: UIImage
    /// A small JPEG for the composer and the conversation.
    let thumbnail: Data

    init?(image: UIImage) {
        guard let small = ShareSizing.scaled(image, longest: 240)?.jpegData(compressionQuality: 0.7) else { return nil }
        self.image = image
        thumbnail = small
    }

    static func == (a: Attachment, b: Attachment) -> Bool { a.id == b.id }

    /// The pictures picked in Photos, as images (the ones that could be read).
    static func load(_ items: [PhotosPickerItem]) async -> [UIImage] {
        var images: [UIImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                images.append(image)
            }
        }
        return images
    }
}

/// The pictures about to go, above the text field: each with a button to take it out.
struct AttachmentStrip: View {
    @Binding var attachments: [Attachment]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.s) {
                ForEach(attachments) { attachment in
                    Thumbnail(data: attachment.thumbnail, side: 64)
                        .overlay(alignment: .topTrailing) {
                            Button {
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                    attachments.removeAll { $0.id == attachment.id }
                                }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .offset(x: 6, y: -6)
                            .accessibilityLabel("Remove this picture")
                        }
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.top, 8)
            .padding(.horizontal, 4)
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(attachments.count) picture\(attachments.count == 1 ? "" : "s") to send")
    }
}

/// The pictures sent with a question, in its bubble.
struct SentPictures: View {
    let pictures: [Data]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(pictures.indices, id: \.self) { index in
                Thumbnail(data: pictures[index], side: pictures.count == 1 ? 150 : 72)
            }
        }
    }
}

/// One small picture, rounded the way the bubbles are.
struct Thumbnail: View {
    let data: Data
    let side: CGFloat

    var body: some View {
        Group {
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.75))
        .accessibilityHidden(true)
    }
}

/// A document waiting in the composer: a PDF (read as a PDF, pages and all) or a text file
/// (plain text, Markdown, CSV, JSON, HTML, RTF: read as its text).
struct PickedDocument: Identifiable, Equatable {
    static let limit = 5
    /// What Claude takes per PDF; the Mac's share takes 25 MB.
    static let maxBytes = 20 * 1024 * 1024
    static let maxCharacters = 200_000

    let id = UUID()
    let name: String
    let data: Data
    /// Its text, for anything that isn't a PDF (nil for a PDF).
    let text: String?

    static func == (a: PickedDocument, b: PickedDocument) -> Bool { a.id == b.id }

    var isPDF: Bool { text == nil }

    /// The question when only documents were sent.
    static func fallback(count: Int) -> String {
        count > 1 ? "What are these documents about?" : "What is this document about?"
    }

    /// A picked file, read; nil (with why) when it can't be used.
    struct Problem: Error { let message: String }

    static func read(_ url: URL) -> Result<PickedDocument, Problem> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return .failure(Problem(message: "Couldn’t read \(url.lastPathComponent).")) }
        guard data.count <= maxBytes else { return .failure(Problem(message: "\(url.lastPathComponent) is over 20 MB.")) }
        let name = url.lastPathComponent
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        if type.conforms(to: .pdf) { return .success(PickedDocument(name: name, data: data, text: nil)) }
        if type.conforms(to: .rtf),
           let rich = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
            return .success(PickedDocument(name: name, data: data, text: String(rich.string.prefix(maxCharacters))))
        }
        guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1), !text.contains("\0") else {
            return .failure(Problem(message: "\(name) isn’t a PDF or a text file Jarvis can read."))
        }
        return .success(PickedDocument(name: name, data: data, text: String(text.prefix(maxCharacters))))
    }

    /// The document as the brain sends it: Claude's document block for a PDF, else its text.
    var block: JSONValue? {
        if let text {
            return ["type": "text", "text": .string("The document \(name):\n\n\(text)")]
        }
        return ["type": "document", "title": .string(name),
                "source": ["type": "base64", "media_type": "application/pdf", "data": .string(data.base64EncodedString())]]
    }
}

/// A document about to go, as a chip with a button to take it out.
struct DocumentChip: View {
    let name: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: name.lowercased().hasSuffix(".pdf") ? "doc.richtext" : "doc.text")
                .foregroundStyle(Palette.ice)
            Text(name)
                .font(.footnote)
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(Palette.ink)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.5))
                }
                .accessibilityLabel("Remove \(name)")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: 220)
        .glassCard(cornerRadius: 14)
    }
}
