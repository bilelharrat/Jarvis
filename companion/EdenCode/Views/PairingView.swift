import SwiftUI
import UIKit

/// Pair with a Mac: its address (found with Bonjour on the same Wi-Fi, or typed), the
/// certificate fingerprint to compare with the Mac's Settings, then the six-digit code from
/// Settings › iPhone & Watch › Pair a phone, as the companion pairs.
struct PairingView: View {
    var first: Bool
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var probed: (base: URL, fingerprint: String)?
    @State private var working = false
    @State private var problem: String?
    @FocusState private var codeFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                VStack(spacing: 10) {
                    EdenMark()
                        .stroke(style: StrokeStyle(lineWidth: 2.2, lineJoin: .round))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .frame(width: 84, height: 84)
                        .background(LinearGradient(colors: [Color(UIColor(hex: 0x1F3B73)), Color(UIColor(hex: 0x0F1E3D))], startPoint: .top, endPoint: .bottom), in: .rect(cornerRadius: 22))
                        .shadow(color: .black.opacity(0.2), radius: 12, y: 8)
                    Text(first ? "Eden Code" : "Pair a Mac").font(.system(size: 34, weight: .bold)).foregroundStyle(EdenTheme.ink)
                    Text("Carry on from your iPhone: your sessions, their changes and what waits on you, from Eden Code on your Mac.")
                        .font(.system(size: 15)).foregroundStyle(EdenTheme.muted).multilineTextAlignment(.center)
                }
                .padding(.top, first ? 40 : 10)

                if let problem { ProblemBanner(text: problem) }

                VStack(alignment: .leading, spacing: 12) {
                    step(1, "On your Mac, open Eden › Settings › iPhone & Watch and turn on “Let my phone connect”. In Eden Code › More › Hand off to phone, turn on Eden Code on your phone.")
                    TextField("Mac address, like my-mac.local", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.system(size: 16))
                        .padding(12)
                        .background(EdenTheme.fill, in: .rect(cornerRadius: 12))
                        .onChange(of: address) { _, _ in probed = nil }
                    if let probed {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Compare with your Mac’s Settings › iPhone & Watch:").font(.system(size: 13)).foregroundStyle(EdenTheme.muted)
                            Text(CertificatePin.short(probed.fingerprint)).font(.system(size: 17, weight: .semibold, design: .monospaced)).foregroundStyle(EdenTheme.ink)
                        }
                        step(2, "Click Pair a phone on the Mac and type its six-digit code.")
                        TextField("123456", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .font(.system(size: 28, weight: .semibold, design: .monospaced))
                            .multilineTextAlignment(.center)
                            .padding(12)
                            .background(EdenTheme.fill, in: .rect(cornerRadius: 12))
                            .focused($codeFocused)
                            .onChange(of: code) { _, new in
                                code = String(new.filter(\.isNumber).prefix(6))
                                if code.count == 6 { pair() }
                            }
                    }
                }
                .padding(16)
                .edenCard(radius: 20)

                Button {
                    probed == nil ? probe() : pair()
                } label: {
                    Group {
                        if working { ProgressView().tint(.white) } else { Text(probed == nil ? "Find my Mac" : "Pair") }
                    }
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.glassProminent)
                .disabled(working || address.trimmed.isEmpty || (probed != nil && code.count != 6))
                #if DEBUG
                if first {
                    Button("Look around with sample sessions") { store.useFixtures() }
                        .font(.system(size: 14))
                }
                #endif
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(EdenBackground())
        .toolbar {
            if !first { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear {
            #if DEBUG
            if let server = EdenDebug.server, address.isEmpty {
                address = server
                probe()
            }
            #endif
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                .frame(width: 22, height: 22).background(EdenTheme.accent, in: .circle)
            Text(text).font(.system(size: 14)).foregroundStyle(EdenTheme.ink2)
        }
    }

    private func probe() {
        working = true
        problem = nil
        Task {
            do {
                probed = try await MacStore.probe(address: address)
                working = false
                codeFocused = true
                #if DEBUG
                if let debugCode = EdenDebug.code {
                    code = debugCode
                    pair()
                }
                #endif
            } catch {
                working = false
                problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func pair() {
        guard let probed, code.count == 6, !working else { return }
        working = true
        problem = nil
        Task {
            defer { working = false }
            do {
                let pairing = try await MacStore.pair(base: probed.base, fingerprint: probed.fingerprint, code: code,
                                                      deviceName: "\(UIDevice.current.name) (Eden Code)")
                store.added(pairing)
                if !first { dismiss() }
            } catch {
                code = ""
                print("Eden Code pairing failed: \(error)")
                problem = (error as? JarvisError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
