import SwiftUI

/// The Mac's features the phone has a screen for, as /api/state lists them in `features`.
enum MacFeature: String, CaseIterable, Identifiable, Hashable, Sendable {
    case memory, goals, timers, reminders, markets, tasks, music, shortcuts, switches, journal, meetings, research, invoices

    var id: String { rawValue }

    var title: String {
        switch self {
        case .memory: "Memory"
        case .goals: "Goals"
        case .timers: "Timers"
        case .reminders: "Reminders"
        case .markets: "Markets"
        case .tasks: "Background Tasks"
        case .music: "Music"
        case .shortcuts: "Shortcuts & Home"
        case .switches: "Mac Controls"
        case .journal: "Journal"
        case .meetings: "Meeting Notes"
        case .research: "Research"
        case .invoices: "Invoices"
        }
    }

    var symbol: String {
        switch self {
        case .memory: "brain.head.profile"
        case .goals: "target"
        case .timers: "timer"
        case .reminders: "checklist"
        case .markets: "chart.line.uptrend.xyaxis"
        case .tasks: "gearshape.2.fill"
        case .music: "music.note"
        case .shortcuts: "square.stack.3d.up.fill"
        case .switches: "switch.2"
        case .journal: "book.closed.fill"
        case .meetings: "note.text"
        case .research: "doc.text.magnifyingglass"
        case .invoices: "doc.plaintext.fill"
        }
    }

    var tint: Color {
        switch self {
        case .memory: .pink
        case .goals: .red
        case .timers: .orange
        case .reminders: .blue
        case .markets: .green
        case .tasks: .gray
        case .music: .pink
        case .shortcuts: .indigo
        case .switches: .gray
        case .journal: .brown
        case .meetings: .yellow
        case .research: .cyan
        case .invoices: .mint
        }
    }
}
