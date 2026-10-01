import SwiftUI
import UIKit

/// "Show Jarvis": take a photo and ask about it. The photo goes to the Mac only when you
/// send it (POST /api/photo), as a silent request there; the reply shows here (and is
/// spoken, when spoken replies are on).
struct ShowJarvisView: View {
    @Environment(AppModel.self) private var model
    @State private var photo: UIImage?
    @State private var question = ""
    @State private var showCamera = false
    @State private var phase: Phase = .idle
    @FocusState private var asking: Bool

    enum Phase: Equatable {
        case idle
        case sending
        case answered(String)
        case note(String)
        case failed(String)
    }

    private var hasCamera: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                if let photo {
                    Image(uiImage: photo)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.75))
                        .accessibilityLabel("Your photo")
                    askRow
                } else {
                    placeholder
                }
                result
            }
            .padding(.horizontal, Space.m + 4)
            .padding(.vertical, Space.m)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
        .navigationTitle("Show Jarvis")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if photo != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Retake") { showCamera = true }
                        .disabled(phase == .sending)
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                photo = image
                phase = .idle
            }
            .ignoresSafeArea()
        }
    }

    private var placeholder: some View {
        VStack(spacing: Space.m) {
            Image(systemName: "camera.viewfinder")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(Palette.ice)
            Text(hasCamera ? "Take a photo, then ask Jarvis about it." : "This device has no camera.")
                .font(.system(.title3, design: .serif).weight(.medium))
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(.center)
            Text("A label, a plant, a sign in another language, the back of a device. The photo goes to your Mac only when you send it.")
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
            Button {
                showCamera = true
            } label: {
                Label("Take a photo", systemImage: "camera.fill")
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!hasCamera)
            .padding(.top, Space.xs)
        }
        .padding(Space.l)
        .glassCard(cornerRadius: Radius.card)
    }

    private var askRow: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            TextField("", text: $question, prompt: Text("What is this?").foregroundStyle(Palette.muted), axis: .vertical)
                .lineLimit(1...4)
                .focused($asking)
                .foregroundStyle(Palette.ink)
                .padding(Space.m)
                .glassCard(cornerRadius: 16, tint: asking ? Palette.cyan : .white, strength: asking ? 0.6 : 1)
                .accessibilityLabel("Your question about the photo")
            Button {
                asking = false
                Task { await send() }
            } label: {
                HStack(spacing: Space.xs) {
                    if phase == .sending { ProgressView().tint(Palette.onAction) }
                    Text(phase == .sending ? "Asking…" : "Ask Jarvis")
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(phase == .sending)
        }
    }

    @ViewBuilder
    private var result: some View {
        switch phase {
        case .answered(let reply):
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: 7) {
                    OrbMark(size: 9)
                    Eyebrow("Jarvis", color: Palette.ice.opacity(0.9))
                }
                Text(TranscriptRow.markdown(reply))
                    .font(.voice)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(4)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.m)
            .glassCard(cornerRadius: 18)
        case .note(let text):
            Label(text, systemImage: "clock")
                .font(.subheadline)
                .foregroundStyle(Palette.champagne)
        case .failed(let message):
            ErrorCallout(title: "Not sent", message: message)
        case .idle, .sending:
            EmptyView()
        }
    }

    private func send() async {
        guard let photo else { return }
        if model.answersOnPhone {
            return await sendToPhone(photo)
        }
        guard let api = model.pairing?.api else { return }
        guard let jpeg = PhotoPrep.jpeg(from: photo) else {
            phase = .failed("Couldn’t prepare that photo.")
            return
        }
        phase = .sending
        do {
            let result = try await api.photo(jpeg: jpeg, question: question.trimmed.isEmpty ? "What is this?" : question)
            if result.done, !result.reply.trimmed.isEmpty {
                phase = .answered(result.reply)
                Haptics.reply()
                if model.speakReplies { model.voice.speak(result.reply, using: api) }
            } else if !result.approvals.isEmpty {
                phase = .note("Jarvis needs your OK first. The card is on the main screen.")
                model.expectActivity()
            } else {
                phase = .note("Jarvis is still working on it. The answer will be in the conversation.")
                model.expectActivity()
            }
        } catch {
            Haptics.failure()
            if let problem = model.handle(error) {
                phase = .failed(problem.neverDelivered ? "Your Mac can’t be reached right now. Try again when it’s back." : problem.message)
            } else {
                phase = .idle
            }
        }
    }

    /// Jarvis on the iPhone looks at it (no Mac, or it can't be reached).
    private func sendToPhone(_ photo: UIImage) async {
        guard let jpeg = PhotoPrep.jpeg(from: photo, longest: 1568, maxBytes: 4 * 1024 * 1024) else {
            phase = .failed("Couldn’t prepare that photo.")
            return
        }
        phase = .sending
        let ask = question.trimmed.isEmpty ? "What is this?" : question.trimmed
        if let reply = await model.brain.ask(ask, image: jpeg, macName: model.pairing?.macLabel) {
            phase = .answered(reply)
            Haptics.reply()
            if model.speakReplies { model.voice.speakLocally(reply) }
        } else {
            Haptics.failure()
            phase = .failed(model.brain.turns.last?.text ?? "Jarvis couldn’t look at it right now.")
        }
    }
}

/// A photo as the Mac takes it: JPEG, the longest side at most 2048 px, well under 8 MB.
/// For Claude on the iPhone: at most 1568 px (what Claude reads at full detail), under 5 MB.
enum PhotoPrep {
    static let longest: CGFloat = 2048
    static let maxBytes = 8 * 1024 * 1024

    static func jpeg(from image: UIImage, longest: CGFloat = Self.longest, maxBytes: Int = Self.maxBytes) -> Data? {
        var quality: CGFloat = 0.8
        let scaled = ShareSizing.scaled(image, longest: longest) ?? image
        while quality >= 0.4 {
            if let data = scaled.jpegData(compressionQuality: quality), data.count <= maxBytes { return data }
            quality -= 0.2
        }
        return nil
    }
}

/// The system camera, for one photo.
private struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
