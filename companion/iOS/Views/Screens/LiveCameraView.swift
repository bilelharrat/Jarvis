import AVFoundation
import SwiftUI
import UIKit

/// "Point and ask", Show Jarvis's live view (Settings › Sensors › Camera, off until turned
/// on): the camera shows on this screen only, and each question takes one still frame and
/// sends it as Show Jarvis sends a photo. Never a video stream; the camera stops when the
/// view closes or the app leaves the screen.
struct LiveCameraView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var camera = LiveCamera()
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var phase: ShowJarvisView.Phase = .idle
    @State private var asking = ""
    @State private var question = ""
    @State private var sent: UIImage?
    @FocusState private var typing: Bool

    /// The questions a tap asks.
    static let quick = ["What’s this?", "Read this", "Translate this"]

    private var canShow: Bool { LiveCamera.available && access == .authorized }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if canShow {
                CameraPreview(session: camera.session)
                    .ignoresSafeArea()
                    .accessibilityLabel("Camera view")
                    .accessibilityHint("Nothing is sent until you ask.")
            } else {
                unavailable
            }
            VStack(spacing: Space.s) {
                topBar
                Spacer(minLength: 0)
                result
                if canShow { controls }
            }
            .padding(.horizontal, Space.m)
            .padding(.bottom, Space.s)
        }
        .environment(\.colorScheme, .dark)
        .task { await begin() }
        .onDisappear { camera.stop() }
        .onChange(of: scenePhase) { _, now in
            if now == .active, canShow { camera.start() } else if now != .active { camera.stop() }
        }
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack(spacing: Space.s) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(CircleGlassButtonStyle())
            .accessibilityLabel("Close")
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Image(systemName: "lock.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Palette.ring)
                HUDText("Sent only when you ask", color: .white.opacity(0.85))
            }
            .padding(.horizontal, Space.s)
            .padding(.vertical, 6)
            .glassCard(cornerRadius: 14)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("One frame goes to Jarvis only when you ask")
        }
        .padding(.top, Space.xs)
    }

    private var unavailable: some View {
        VStack(spacing: Space.m) {
            Image(systemName: "camera.fill")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.white.opacity(0.8))
            Text(LiveCamera.available ? "The camera is off for J.A.R.V.I.S." : "This device has no camera.")
                .font(.title3.weight(.medium))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            if LiveCamera.available, access == .denied || access == .restricted {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, Space.xl)
            }
        }
        .padding(Space.l)
    }

    @ViewBuilder
    private var result: some View {
        switch phase {
        case .answered(let reply):
            HStack(alignment: .top, spacing: Space.s) {
                if let sent {
                    Image(uiImage: sent)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityHidden(true)
                }
                ScrollView {
                    Text(TranscriptRow.markdown(reply))
                        .font(.body)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(Space.m)
            .glassCard(cornerRadius: 18)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Jarvis: \(reply)")
        case .note(let text):
            Label(text, systemImage: "clock")
                .font(.subheadline)
                .foregroundStyle(.white)
                .padding(Space.s)
                .glassCard(cornerRadius: 14)
        case .failed(let message):
            ErrorCallout(title: "Not sent", message: message)
        case .idle, .sending:
            EmptyView()
        }
    }

    private var controls: some View {
        VStack(spacing: Space.s) {
            HStack(spacing: Space.xs) {
                ForEach(Self.quick, id: \.self) { text in
                    Button {
                        Task { await ask(text) }
                    } label: {
                        HStack(spacing: 6) {
                            if asking == text, phase == .sending { ProgressView().controlSize(.small) }
                            Text(text).lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, Space.s)
                        .frame(minHeight: 40)
                    }
                    .buttonStyle(GlassButtonStyle())
                    .disabled(phase == .sending)
                }
            }
            HStack(spacing: Space.xs) {
                TextField("", text: $question, prompt: Text("Ask about what you see").foregroundStyle(.white.opacity(0.6)))
                    .focused($typing)
                    .submitLabel(.send)
                    .onSubmit { send() }
                    .foregroundStyle(.white)
                    .padding(.horizontal, Space.m)
                    .frame(minHeight: 46)
                    .glassCard(cornerRadius: 23)
                    .accessibilityLabel("Your question about what the camera sees")
                Button(action: send) {
                    Group {
                        if phase == .sending, !Self.quick.contains(asking) {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 17, weight: .bold))
                        }
                    }
                    .frame(width: 46, height: 46)
                }
                .buttonStyle(CircleGlassButtonStyle(tint: Palette.cyan))
                .disabled(phase == .sending || question.trimmed.isEmpty)
                .accessibilityLabel("Ask Jarvis")
            }
        }
    }

    // MARK: - Doing

    private func begin() async {
        guard LiveCamera.available else { return }
        if access == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
            access = AVCaptureDevice.authorizationStatus(for: .video)
        }
        if access == .authorized { camera.start() }
    }

    private func send() {
        let text = question.trimmed
        guard !text.isEmpty else { return }
        typing = false
        question = ""
        Task { await ask(text) }
    }

    /// One frame, taken now, asked about.
    private func ask(_ text: String) async {
        guard phase != .sending else { return }
        asking = text
        phase = .sending
        guard let frame = await camera.capture() else {
            Haptics.failure()
            phase = .failed("Couldn’t take the picture. Try again.")
            return
        }
        sent = frame
        phase = await PhotoQuestion.ask(about: frame, text, model: model)
    }
}

/// The capture session behind "Point and ask": the back camera's picture for the preview,
/// and a still photo only when one is asked for.
final class LiveCamera: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "com.bshventures.jarvis.live-camera")
    private var configured = false
    private var waiting: CheckedContinuation<UIImage?, Never>?  // touched on `queue` only

    static var available: Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    }

    func start() {
        queue.async { [self] in
            if !configured { configure() }
            if configured, !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.beginConfiguration()
        session.sessionPreset = .photo
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        configured = session.inputs.contains(input) && session.outputs.contains(output)
    }

    /// One still frame; nil when the camera isn't running or one is being taken.
    func capture() async -> UIImage? {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                guard session.isRunning, waiting == nil else { return continuation.resume(returning: nil) }
                waiting = continuation
                output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let image = error == nil ? photo.fileDataRepresentation().flatMap(UIImage.init(data:)) : nil
        queue.async { [self] in
            let continuation = waiting
            waiting = nil
            continuation?.resume(returning: image)
        }
    }
}

/// The camera's live picture, drawn by AVFoundation on this screen.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        if let preview = view.layer as? AVCaptureVideoPreviewLayer {
            preview.session = session
            preview.videoGravity = .resizeAspectFill
        }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
