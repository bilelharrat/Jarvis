import MessageUI
import SwiftUI

/// What Jarvis on the iPhone prepared for the owner to finish: a text or email (opened in
/// the system composer to look over and send), a call, a link. Nothing goes without a tap.
struct ActionCards: View {
    let actions: [PhoneAction]
    let onDone: (PhoneAction) -> Void
    @State private var composing: PhoneAction?
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: Space.xs) {
            ForEach(actions) { action in
                card(action)
            }
        }
        .sheet(item: $composing) { action in
            Composer(action: action) { sent in
                composing = nil
                if sent { onDone(action) }
            }
            .ignoresSafeArea()
        }
    }

    private func card(_ action: PhoneAction) -> some View {
        HStack(spacing: Space.s) {
            IconTile(symbol: symbol(action), tint: tint(action))
            VStack(alignment: .leading, spacing: 2) {
                Text(title(action))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(detail(action))
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(2)
            }
            Spacer(minLength: Space.xs)
            Button(verb(action)) { perform(action) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(tint(action))
            Button {
                onDone(action)
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.muted)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(Space.s)
        .glassCard(cornerRadius: 22)
    }

    private func perform(_ action: PhoneAction) {
        switch action {
        case .message:
            if MFMessageComposeViewController.canSendText() { composing = action } else { fallback(action) }
        case .email:
            if MFMailComposeViewController.canSendMail() { composing = action } else { fallback(action) }
        case .call(let number, _):
            let digits = number.filter { $0.isNumber || $0 == "+" }
            if let url = URL(string: "tel:\(digits)") { openURL(url) }
            onDone(action)
        case .open(let url):
            openURL(url)
            onDone(action)
        }
    }

    /// No composer on this device (Simulator, no Mail account): hand it to the system's links.
    private func fallback(_ action: PhoneAction) {
        switch action {
        case .message(let to, let body):
            var components = URLComponents()
            components.scheme = "sms"
            components.path = to.joined(separator: ",")
            components.queryItems = [URLQueryItem(name: "body", value: body)]
            if let url = components.url { openURL(url) }
        case .email(let to, let subject, let body):
            var components = URLComponents()
            components.scheme = "mailto"
            components.path = to.joined(separator: ",")
            components.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: body)]
            if let url = components.url { openURL(url) }
        default:
            break
        }
        onDone(action)
    }

    private func symbol(_ action: PhoneAction) -> String {
        switch action {
        case .message: "message.fill"
        case .email: "envelope.fill"
        case .call: "phone.fill"
        case .open: "safari.fill"
        }
    }

    private func tint(_ action: PhoneAction) -> Color {
        switch action {
        case .message, .call: .green
        case .email, .open: .blue
        }
    }

    private func title(_ action: PhoneAction) -> String {
        switch action {
        case .message(let to, _): "Text to \(to.joined(separator: ", "))"
        case .email(let to, let subject, _): subject.isEmpty ? "Email to \(to.joined(separator: ", "))" : subject
        case .call(_, let name): "Call \(name)"
        case .open(let url): url.host() ?? "Link"
        }
    }

    private func detail(_ action: PhoneAction) -> String {
        switch action {
        case .message(_, let body): body
        case .email(let to, _, let body): "To \(to.joined(separator: ", ")) · \(body)"
        case .call(let number, _): number
        case .open(let url): url.absoluteString
        }
    }

    private func verb(_ action: PhoneAction) -> String {
        switch action {
        case .message, .email: "Review"
        case .call: "Call"
        case .open: "Open"
        }
    }
}

/// The system's own Messages and Mail composers.
private struct Composer: UIViewControllerRepresentable {
    let action: PhoneAction
    let onFinish: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> UIViewController {
        switch action {
        case .message(let to, let body):
            let controller = MFMessageComposeViewController()
            controller.recipients = to
            controller.body = body
            controller.messageComposeDelegate = context.coordinator
            return controller
        case .email(let to, let subject, let body):
            let controller = MFMailComposeViewController()
            controller.setToRecipients(to)
            controller.setSubject(subject)
            controller.setMessageBody(body, isHTML: false)
            controller.mailComposeDelegate = context.coordinator
            return controller
        default:
            return UIViewController()
        }
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate, MFMailComposeViewControllerDelegate {
        let onFinish: (Bool) -> Void

        init(onFinish: @escaping (Bool) -> Void) {
            self.onFinish = onFinish
        }

        func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            onFinish(result == .sent)
        }

        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
            onFinish(result == .sent)
        }
    }
}
