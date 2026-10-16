import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// Scan QR code: the camera, reading the Mac's pairing code (Eden Code › On your phone).
/// VisionKit's DataScannerViewController where the iPhone has it (it highlights the code it
/// sees), else AVFoundation's metadata reader. Hands back the first code that parses
/// (PairPayload); another QR code says what's wrong and keeps looking.
struct PairScanner: View {
    let onScan: (PairPayload) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access = CameraAccess.current
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch access {
                case .granted:
                    if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                        VisionScanner { handle($0) }.ignoresSafeArea()
                    } else {
                        MetadataScanner { handle($0) }.ignoresSafeArea()
                    }
                    ScanCorners().frame(width: 240, height: 240).accessibilityHidden(true)
                case .undetermined:
                    ProgressView().tint(.white)
                case .denied:
                    unavailable("Camera is off for Eden Code",
                                "Turn it on in Settings to scan, or type the six-digit code your Mac shows.", settings: true)
                case .unavailable:
                    unavailable("No camera here", "Type the six-digit code your Mac shows instead.", settings: false)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if access == .granted {
                    Text(problem ?? "Point at the QR code in Eden Code › On your phone on your Mac.")
                        .font(.eden(size: 15, weight: .medium))
                        .foregroundStyle(problem == nil ? EdenTheme.ink : EdenTheme.needsInk)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .frame(maxWidth: .infinity)
                        .edenCard(radius: 20)
                        .padding(.horizontal, 16).padding(.bottom, 8)
                        .animation(.easeOut(duration: 0.2), value: problem)
                }
            }
            .navigationTitle("Scan QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .task {
            if access == .undetermined { access = await CameraAccess.request() }
        }
    }

    private func handle(_ text: String) {
        switch PairPayload.parse(text) {
        case .success(let payload):
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onScan(payload)
            dismiss()
        case .failure(let why):
            if problem == nil { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
            problem = PairPayload.message(why)
        }
    }

    private func unavailable(_ title: String, _ message: String, settings: Bool) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "qrcode.viewfinder").font(.eden(size: 44, weight: .light)).foregroundStyle(.white.opacity(0.7))
            Text(title).font(.headline).foregroundStyle(.white)
            Text(message).font(.subheadline).foregroundStyle(.white.opacity(0.75)).multilineTextAlignment(.center)
            if settings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.glassProminent)
                .padding(.top, 4)
            }
        }
        .padding(32)
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

/// Four corner brackets, as the Camera app frames a code.
private struct ScanCorners: View {
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
            .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            .shadow(color: EdenTheme.accent.opacity(0.6), radius: 6)
        }
    }
}

/// VisionKit's scanner, QR codes only. Each distinct code is reported once.
private struct VisionScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        private var last: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            last = nil
            report([item])
        }

        private func report(_ items: [RecognizedItem]) {
            for item in items {
                guard case .barcode(let code) = item, let text = code.payloadStringValue, text != last else { continue }
                last = text
                onCode(text)
                return
            }
        }
    }
}

/// The fallback: AVFoundation's QR reader on the back camera.
private struct MetadataScanner: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) { context.coordinator.onCode = onCode }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) { coordinator.stop() }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }  // layerClass makes it one
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        var onCode: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "com.askeden.jarvis.edencode.qr")
        private var last: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func start(in view: PreviewView) {
            view.preview.session = session
            view.preview.videoGravity = .resizeAspectFill
            let session = session
            queue.async { [weak self] in
                guard let self, let camera = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
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
