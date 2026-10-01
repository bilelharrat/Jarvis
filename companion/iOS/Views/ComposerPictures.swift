import PhotosUI
import SwiftUI
import UIKit

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
