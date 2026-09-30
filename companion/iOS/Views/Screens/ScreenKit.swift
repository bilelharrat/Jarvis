import SwiftUI

/// What a screen shows while it fetches from the Mac.
enum Loadable<Value> {
    case loading
    case loaded(Value)
    case failed(JarvisError)

    var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    static func from(_ error: Error) -> Loadable {
        .failed((error as? JarvisError) ?? .unreachable(error.localizedDescription))
    }
}

/// The screen before its first answer: a quiet spinner, or what went wrong and a Retry.
struct LoadStateView<Value>: View {
    let state: Loadable<Value>
    let retry: () async -> Void

    var body: some View {
        switch state {
        case .loading:
            ProgressView()
                .tint(Palette.ink2)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let error):
            ContentUnavailableView {
                Label(error.title, systemImage: error == .unsupported ? "arrow.down.circle" : "wifi.exclamationmark")
            } description: {
                Text(error.message)
            } actions: {
                Button("Try again") { Task { await retry() } }
                    .buttonStyle(GlassButtonStyle())
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.xs)
            }
        case .loaded:
            EmptyView()
        }
    }
}

/// A small status capsule: a dot or glyph and a word, tinted by what it means.
struct StatusPill: View {
    let text: String
    var symbol: String?
    var tint: Color = Palette.ink2

    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.caption2.weight(.bold))
            } else {
                Circle().fill(tint).frame(width: 6, height: 6)
            }
            Text(text)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(tint.opacity(0.14)))
        .overlay(Capsule().strokeBorder(tint.opacity(0.28), lineWidth: 0.5))
    }
}

extension CodeStatus {
    var tint: Color {
        switch self {
        case .working: Palette.cyan
        case .needsYou: Palette.champagne
        case .done: Palette.online
        case .failed: Palette.amber
        case .idle, .resting, .unknown: Palette.muted
        }
    }
}

enum Money {
    /// "$46.50", in the item's own currency.
    static func text(_ amount: Double, currency: String) -> String {
        amount.formatted(.currency(code: currency.isEmpty ? "USD" : currency).precision(.fractionLength(2)))
    }

    /// A limit: "$200", with cents only when it has them.
    static func limit(_ amount: Double, currency: String) -> String {
        amount.formatted(.currency(code: currency.isEmpty ? "USD" : currency).precision(.fractionLength(amount.rounded() == amount ? 0 : 2)))
    }
}

/// A glyph and a few words, tight together (a List row's Label pads its icon to the row's
/// icon column).
struct InlineLabel: View {
    let text: String
    let symbol: String

    init(_ text: String, systemImage symbol: String) {
        self.text = text
        self.symbol = symbol
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: symbol)
                .imageScale(.small)
            Text(text)
        }
    }
}

extension Date {
    /// "2 min ago", "Yesterday".
    var ago: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 45 { return "Just now" }
        return formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
