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
    @State private var showLive = false
    @AppStorage(SensorSettings.liveCameraKey) private var liveCamera = false
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
        .fullScreenCover(isPresented: $showLive) {
            LiveCameraView()
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
            if liveCamera, hasCamera {
                Button {
                    showLive = true
                } label: {
                    Label("Point and ask", systemImage: "camera.viewfinder")
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 48)
                }
                .buttonStyle(GlassButtonStyle(tint: Palette.cyan))
                .accessibilityHint("Shows the camera live; one frame goes to Jarvis each time you ask.")
            }
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
        phase = .sending
        phase = await PhotoQuestion.ask(about: photo, question, model: model)
    }
}

/// One picture asked about, from Show Jarvis or its live view: Jarvis on the Mac looks at
/// it (POST /api/photo), or Jarvis on the iPhone when it's the one answering (no Mac, or it
/// can't be reached). The answer is spoken when spoken replies are on.
@MainActor
enum PhotoQuestion {
    nonisolated static let fallback = "What is this?"

    static func ask(about photo: UIImage, _ question: String, model: AppModel) async -> ShowJarvisView.Phase {
        let question = question.trimmed.isEmpty ? fallback : question.trimmed
        if model.answersOnPhone {
            return await askPhone(about: photo, question, model: model)
        }
        guard let api = model.pairing?.api else { return .failed("Pair your Mac in Settings first.") }
        guard let jpeg = PhotoPrep.jpeg(from: photo) else { return .failed("Couldn’t prepare that photo.") }
        do {
            let result = try await api.photo(jpeg: jpeg, question: question)
            if result.done, !result.reply.trimmed.isEmpty {
                Haptics.reply()
                if model.speakReplies { model.voice.speak(result.reply, using: api) }
                return .answered(result.reply)
            }
            model.expectActivity()
            if !result.approvals.isEmpty { return .note("Jarvis needs your OK first. The card is on the main screen.") }
            return .note("Jarvis is still working on it. The answer will be in the conversation.")
        } catch {
            Haptics.failure()
            guard let problem = model.handle(error) else { return .idle }
            return .failed(problem.neverDelivered ? "Your Mac can’t be reached right now. Try again when it’s back." : problem.message)
        }
    }

    /// Jarvis on the iPhone looks at it.
    private static func askPhone(about photo: UIImage, _ question: String, model: AppModel) async -> ShowJarvisView.Phase {
        guard let jpeg = PhotoPrep.jpeg(from: photo, longest: 1568, maxBytes: 4 * 1024 * 1024) else {
            return .failed("Couldn’t prepare that photo.")
        }
        if let reply = await model.brain.ask(question, image: jpeg, macName: model.pairing?.macLabel) {
            Haptics.reply()
            if model.speakReplies { model.voice.speakLocally(reply) }
            return .answered(reply)
        }
        Haptics.failure()
        return .failed(model.brain.turns.last?.text ?? "Jarvis couldn’t look at it right now.")
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
