import AVFoundation
import SwiftUI

/// Scan the pairing code the Mac shows in Jarvis Settings › iPhone & Watch. The code
/// carries the Mac's address, a one-time code and its certificate fingerprint.
struct ScanPairingSheet: View {
    let onScan: (PairingLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access = CameraAccess.current
    @State private var notJarvis = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch access {
                case .granted:
                    QRCameraView { text in handle(text) }
                        .ignoresSafeArea()
                    Viewfinder()
                        .frame(width: 250, height: 250)
                        .accessibilityHidden(true)
                case .undetermined:
                    ProgressView().tint(Palette.ink2)
                case .denied:
                    unavailable(
                        "Camera is off for J.A.R.V.I.S.",
                        "Turn it on in Settings to scan the code, or pair by typing the Mac’s address and code.",
                        settings: true
                    )
                case .unavailable:
                    unavailable("No camera here", "Pair by typing the Mac’s address and the code it shows.", settings: false)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if access == .granted {
                    VStack(spacing: Space.xs) {
                        Text(notJarvis ? "That isn’t a Jarvis pairing code." : "Point at the code in Jarvis Settings › iPhone & Watch on your Mac.")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(notJarvis ? Palette.amber : Palette.ink)
                            .multilineTextAlignment(.center)
                            .contentTransition(.opacity)
                    }
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.m)
                    .frame(maxWidth: .infinity)
                    .glassCard(cornerRadius: 20)
                    .padding(.horizontal, Space.m)
                    .padding(.bottom, Space.s)
                    .animation(.easeOut(duration: 0.2), value: notJarvis)
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task {
            if access == .undetermined {
                access = await CameraAccess.request()
            }
        }
    }

    private func handle(_ text: String) {
        guard let link = PairingLink(text) else {
            if !notJarvis { Haptics.failure() }
            notJarvis = true
            return
        }
        Haptics.answered(negative: false)
        onScan(link)
        dismiss()
    }

    private func unavailable(_ title: String, _ message: String, settings: Bool) -> some View {
        VStack(spacing: Space.m) {
            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Palette.muted)
            Text(title)
                .font(.headline)
                .foregroundStyle(Palette.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
            if settings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.top, Space.xs)
            }
        }
        .padding(Space.xl)
    }
}

enum CameraAccess: Equatable {
    case granted, denied, undetermined, unavailable

    static var current: CameraAccess {
        guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .granted
        case .notDetermined: return .undetermined
        default: return .denied
        }
    }

    static func request() async -> CameraAccess {
        guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
        return await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
    }
}

/// Four corner brackets, like the Camera app's code scanner.
private struct Viewfinder: View {
    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let arm: CGFloat = 34
            Path { path in
                for (x, y, dx, dy) in [(0.0, 0.0, 1.0, 1.0), (size.width, 0, -1, 1), (0, size.height, 1, -1), (size.width, size.height, -1, -1)] {
                    path.move(to: CGPoint(x: x, y: y + dy * arm))
                    path.addLine(to: CGPoint(x: x, y: y))
                    path.addLine(to: CGPoint(x: x + dx * arm, y: y))
                }
            }
            .stroke(Palette.ice, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            .shadow(color: Palette.cyan.opacity(0.6), radius: 6)
        }
    }
}

/// The camera, reading QR codes. Each distinct code is reported once.
private struct QRCameraView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }  // layerClass makes it one
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "com.bshventures.jarvis.qr")
        private var last: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func start(in view: PreviewView) {
            view.preview.session = session
            view.preview.videoGravity = .resizeAspectFill
            let session = session
            queue.async { [weak self] in
                guard let self,
                      let camera = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: camera),
                      session.canAddInput(input) else { return }
                session.beginConfiguration()
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                if session.canAddOutput(output) {
                    session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main)
                    if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
                }
                session.commitConfiguration()
                session.startRunning()
            }
        }

        func stop() {
            let session = session
            queue.async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first,
                  code != last else { return }
            last = code
            onCode(code)
        }
    }
}
