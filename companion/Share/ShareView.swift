import SwiftUI
import UIKit

/// The share sheet's own screen: hosted by the extension's principal class.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let model = ShareModel(providers: providers) { [weak self] done in
            guard let context = self?.extensionContext else { return }
            if done {
                context.completeRequest(returningItems: nil)
            } else {
                context.cancelRequest(withError: CocoaError(.userCancelled))
            }
        }
        let host = UIHostingController(rootView: ShareView(model: model).preferredColorScheme(.dark).tint(Palette.cyan))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

/// "Send to Jarvis": what's going, an optional line for Jarvis ("Summarize this"), Send.
struct ShareView: View {
    @Bindable var model: ShareModel
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    switch model.phase {
                    case .loading:
                        ProgressView().tint(Palette.ink2).frame(maxWidth: .infinity).padding(.top, Space.xxl)
                    case .sent(let message):
                        outcome(symbol: "checkmark.circle.fill", tint: Palette.online, title: "Sent", message: message)
                    case .kept:
                        outcome(symbol: "tray.full.fill", tint: Palette.champagne, title: "Waiting for your Mac",
                                message: "Your Mac can’t be reached right now. J.A.R.V.I.S. sends this when it’s back, within the hour.")
                    default:
                        if model.item != nil { form }
                        if case .failed(let message) = model.phase {
                            ErrorCallout(title: model.item == nil ? "Can’t send this" : "Not sent", message: message)
                        }
                    }
                }
                .padding(.horizontal, Space.m + 4)
                .padding(.vertical, Space.m)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
            .navigationTitle("Send to Jarvis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.cancel() }
                        .disabled(model.phase == .sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        noteFocused = false
                        Task { await model.send() }
                    } label: {
                        if model.phase == .sending { ProgressView() } else { Text("Send").fontWeight(.semibold) }
                    }
                    .disabled(!canSend)
                }
            }
        }
    }

    private var canSend: Bool {
        switch model.phase {
        case .ready: true
        case .failed: model.item != nil && !model.pairingMissing
        default: false
        }
    }

    @ViewBuilder
    private var form: some View {
        preview
        VStack(alignment: .leading, spacing: Space.s) {
            Eyebrow("Ask Jarvis to…")
            TextField("", text: $model.note, prompt: Text("Nothing: just keep it on my Mac").foregroundStyle(Palette.muted), axis: .vertical)
                .lineLimit(1...4)
                .focused($noteFocused)
                .foregroundStyle(Palette.ink)
                .padding(Space.m)
                .glassCard(cornerRadius: 16, tint: noteFocused ? Palette.cyan : .white, strength: noteFocused ? 0.6 : 1)
                .accessibilityLabel("What Jarvis should do with it")
            ScrollView(.horizontal) {
                HStack(spacing: Space.xs) {
                    ForEach(ShareModel.suggestions, id: \.self) { suggestion in
                        Button {
                            model.note = suggestion
                        } label: {
                            Text(suggestion)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(model.note == suggestion ? Palette.ice : Palette.ink)
                                .padding(.horizontal, Space.m - 2)
                                .frame(minHeight: 36)
                                .glass(Capsule(), tint: model.note == suggestion ? Palette.cyan : .white)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            Text("Shared things are kept in Documents › Jarvis › Inbox on your Mac. Jarvis reads them as content, never as instructions.")
                .font(.footnote)
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var preview: some View {
        HStack(alignment: .top, spacing: Space.s) {
            if let image = model.preview {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
            } else {
                IconTile(symbol: symbol)
            }
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(kindLabel)
                Text(model.title)
                    .font(model.item?.kind == .text ? .system(.callout, design: .serif) : .callout)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(4)
                if let bytes = model.item?.data?.count {
                    Text(ShareSizing.megabytes(bytes))
                        .font(.caption)
                        .foregroundStyle(Palette.muted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Space.m)
        .glassCard(cornerRadius: 18)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch model.item?.kind {
        case .url: "link"
        case .text: "text.quote"
        case .image: "photo"
        default: "doc.fill"
        }
    }

    private var kindLabel: String {
        switch model.item?.kind {
        case .url: "Link"
        case .text: "Text"
        case .image: "Photo"
        default: "File"
        }
    }

    private func outcome(symbol: String, tint: Color, title: String, message: String) -> some View {
        VStack(spacing: Space.s) {
            Image(systemName: symbol)
                .font(.system(size: 44, weight: .medium))
                .foregroundStyle(tint)
                .symbolEffect(.bounce, value: title)
            Text(title)
                .font(.system(.title3, design: .serif).weight(.medium))
                .foregroundStyle(Palette.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Space.xxl)
    }
}
