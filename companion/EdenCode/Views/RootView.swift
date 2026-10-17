import SwiftUI

/// The G design (the owner's choice, 2026-10-16; GChat, GDrawer, GNew, GAsk mockups): no tab
/// bar. One session fills the screen (or "What should we build?" when none is open); ☰ or a
/// swipe from the left edge slides the sessions drawer over it; the Inbox, the Queue and
/// Settings open from the drawer as sheets; pairing shows until a Mac is paired.
struct RootView: View {
    @Environment(EdenCodeStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        @Bindable var store = store
        Group {
            if store.paired {
                VStack(spacing: 0) {
                    // Above the screen, not over it: the session's glass header ignores insets.
                    if store.demo { DemoBar() }
                    GHome()
                }
                .background(EdenBackground())
            } else {
                PairingView(first: true)
            }
        }
        .sheet(isPresented: $store.showPairing) {
            NavigationStack { PairingView(first: false) }
        }
        // Font.eden scales with Dynamic Type: a new text size redraws everything with it. Past
        // AX3 the glass bars and the drawer can't hold the words, so it stops there.
        .id(typeSize)
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }
}

/// The demo's strip over every screen: it's sample data, nothing reaches a Mac, and the way out.
struct DemoBar: View {
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "play.rectangle.on.rectangle").accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Demo").font(.eden(size: 13, weight: .bold))
                Text("Sample sessions. Nothing reaches a Mac.").font(.eden(size: 12)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 6)
            Button("Exit demo") { store.endDemo() }
                .font(.eden(size: 13, weight: .semibold))
                .buttonStyle(.glass)
                .accessibilityHint("Goes back to pairing with your Mac")
        }
        .foregroundStyle(EdenTheme.ink)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(EdenTheme.orange.opacity(0.18))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Demo mode")
    }
}

/// How far the drawer is open (0 shut, 1 open): the screen under it slides 300 pt right and
/// softens, as GDrawer.dc.html draws it.
private struct DrawerProgressKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var drawerProgress: CGFloat {
        get { self[DrawerProgressKey.self] }
        set { self[DrawerProgressKey.self] = newValue }
    }
}

extension View {
    /// The screen's content (not its wallpaper) moving aside for the drawer.
    func movesForDrawer(_ progress: CGFloat) -> some View {
        offset(x: GHome.push * progress)
            .blur(radius: progress)
            .allowsHitTesting(progress == 0)
            .accessibilityHidden(progress > 0)
    }
}

/// The session (or the new one), the drawer over it, and what opens over both.
struct GHome: View {
    @Environment(EdenCodeStore.self) private var store
    /// The finger's travel while it drags the drawer open or shut.
    @State private var drag: CGFloat = 0
    /// What the finger on the screen is doing, decided once per touch: only a mostly-horizontal
    /// one moves the drawer; a vertical one is the transcript's to scroll.
    @State private var axis: Axis?

    static let drawerWidth: CGFloat = 320
    static let push: CGFloat = 300

    private var progress: CGFloat {
        min(1, max(0, (store.drawerOpen ? 1 : 0) + drag / Self.drawerWidth))
    }

    var body: some View {
        @Bindable var store = store
        let progress = progress
        ZStack(alignment: .leading) {
            EdenBackground()
            NavigationStack(path: $store.path) {
                Group {
                    if let id = store.openSession {
                        SessionScreen(id: id).id(id)
                    } else {
                        NewSessionScreen()
                    }
                }
                .navigationDestination(for: EdenCodeStore.Route.self) { route in
                    switch route {
                    case .changes(let id): ChangesScreen(id: id)
                    }
                }
            }
            .environment(\.drawerProgress, progress)

            if progress > 0 {
                Color.black.opacity(0.08 * progress)
                    .ignoresSafeArea()
                    .contentShape(.rect)
                    .onTapGesture { store.drawerOpen = false }
                    .accessibilityLabel("Close your sessions")
                    .accessibilityAddTraits(.isButton)
            }

            SessionDrawer()
                .frame(width: Self.drawerWidth)
                .offset(x: -(Self.drawerWidth + 50) * (1 - progress))
                .accessibilityHidden(progress == 0)

            if !store.drawerOpen && store.path.isEmpty {
                // The left edge: a swipe opens the drawer.
                Color.clear
                    .frame(width: 14)
                    .frame(maxHeight: .infinity)
                    .contentShape(.rect)
                    .highPriorityGesture(opening)
                    .ignoresSafeArea()
                    .accessibilityHidden(true)
            }

            ApprovalOverlay()
        }
        .animation(.spring(response: 0.36, dampingFraction: 0.88), value: store.drawerOpen)
        // A mostly-horizontal swipe anywhere on the session opens the drawer, and one to the left
        // (or a tap on the dimmed screen) shuts it; simultaneous, so the transcript still scrolls.
        .simultaneousGesture(pan)
        .onChange(of: store.drawerOpen) { _, open in
            drag = 0
            axis = nil
            if open { Keyboard.dismiss() }
        }
        .sheet(item: $store.panel) { panel in
            PanelSheet(panel: panel)
        }
    }

    private var opening: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged {
                if drag == 0 { Keyboard.dismiss() }  // (as the finger starts pulling it open)
                drag = max(0, min(Self.drawerWidth, $0.translation.width))
            }
            .onEnded { settle($0) }
    }

    /// The whole screen's swipe: follows the finger, and on release the speed decides (a flick
    /// settles the way it was thrown even from a short pull) with the same spring as the button.
    private var pan: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if axis == nil {
                    let dx = value.translation.width, dy = value.translation.height
                    // Right opens, left shuts; the other way, or anything steeper than about
                    // 27 degrees, isn't for the drawer. (No pull while a pushed page is open.)
                    let wanted = store.drawerOpen ? dx < 0 : (dx > 0 && store.path.isEmpty && store.panel == nil)
                    axis = wanted && abs(dx) > abs(dy) * 2 ? .horizontal : .vertical
                    if axis == .horizontal && !store.drawerOpen { Keyboard.dismiss() }
                }
                guard axis == .horizontal else { return }
                let dx = value.translation.width
                drag = store.drawerOpen ? max(-Self.drawerWidth, min(0, dx)) : max(0, min(Self.drawerWidth, dx))
            }
            .onEnded { value in
                defer { axis = nil }
                guard axis == .horizontal else { return }
                settle(value)
            }
    }

    private func settle(_ value: DragGesture.Value) {
        let opens = store.drawerOpen
            ? !(value.translation.width < -80 || value.predictedEndTranslation.width < -160)
            : (value.translation.width > 80 || value.predictedEndTranslation.width > 180)
        withAnimation(.spring(response: 0.36, dampingFraction: 0.88)) {
            drag = 0
            store.drawerOpen = opens
        }
    }
}

/// Puts the keyboard away, whatever has it (the input bar, a sheet's field; Gboard or Apple's).
enum Keyboard {
    @MainActor static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.windows.forEach { $0.endEditing(true) }
        }
    }
}

/// The Inbox, the Queue or Settings, opened from the drawer, with Done.
struct PanelSheet: View {
    var panel: EdenCodeStore.Panel
    @Environment(EdenCodeStore.self) private var store

    var body: some View {
        NavigationStack {
            Group {
                switch panel {
                case .inbox: InboxView()
                case .queue: QueueView()
                case .settings: SettingsView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { store.panel = nil }
                }
            }
        }
    }
}

// MARK: - The mockups' glyphs (their SVG paths, 24 pt boxes unless said)

/// ☰ with uneven lines (M4 7h16 M4 12h10 M4 17h13).
struct MenuGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        for (y, end) in [(7.0, 20.0), (12.0, 14.0), (17.0, 17.0)] {
            path.move(to: p(4, y))
            path.addLine(to: p(end, y))
        }
        return path
    }
}

/// ✎: a pen over a line (M12 20h9, M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z).
struct PencilGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(12, 20))
        path.addLine(to: p(21, 20))
        path.move(to: p(16.5, 3.5))
        path.addArc(center: p(18, 5), radius: 2.1 * s, startAngle: .degrees(225), endAngle: .degrees(45), clockwise: false)
        path.addLine(to: p(7, 19))
        path.addLine(to: p(3, 20))
        path.addLine(to: p(4, 16))
        path.closeSubpath()
        return path
    }
}

/// The diff mark of "2 files changed" (a 20 pt box: a rounded square, ± inside).
struct DiffGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 20
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path(roundedRect: CGRect(origin: p(3, 3), size: CGSize(width: 14 * s, height: 14 * s)), cornerRadius: 3 * s)
        path.move(to: p(10, 6.5)); path.addLine(to: p(10, 11.5))
        path.move(to: p(7.5, 9)); path.addLine(to: p(12.5, 9))
        path.move(to: p(7.5, 14)); path.addLine(to: p(12.5, 14))
        return path
    }
}

/// The search lens (circle r7 at 11,11; a handle to 20,20).
struct SearchGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path(ellipseIn: CGRect(origin: p(4, 4), size: CGSize(width: 14 * s, height: 14 * s)))
        path.move(to: p(20, 20)); path.addLine(to: p(16, 16))
        return path
    }
}

/// Settings: a hub and eight spokes.
struct GearGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path(ellipseIn: CGRect(origin: p(9, 9), size: CGSize(width: 6 * s, height: 6 * s)))
        for (a, b) in [((12.0, 2.0), (12.0, 5.0)), ((12, 19), (12, 22)), ((2, 12), (5, 12)), ((19, 12), (22, 12)),
                       ((4.9, 4.9), (7, 7)), ((17, 17), (19.1, 19.1)), ((4.9, 19.1), (7, 17)), ((17, 7), (19.1, 4.9))] {
            path.move(to: p(a.0, a.1))
            path.addLine(to: p(b.0, b.1))
        }
        return path
    }
}

/// A 44 pt round glass control (☰, ✎).
struct GCircleButton<Glyph: Shape>: View {
    var glyph: Glyph
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            glyph
                .stroke(EdenTheme.ink, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .frame(width: 20, height: 20)
                .frame(width: 44, height: 44)
                .contentShape(.circle)
        }
        .buttonStyle(PressScale(scale: 0.94))
        .gGlass(Circle(), interactive: true)
        .accessibilityLabel(label)
    }
}
