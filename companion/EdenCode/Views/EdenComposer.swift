import PhotosUI
import SwiftUI

/// Eden chat's input bar, as the Eden iPhone app shows it (askeden/web/chat: index.html's
/// .jc-composer, app.css + mobile.css at phone width), redrawn point for point: a 22 pt
/// rounded glass bar 8 pt in from the edges, the Eden mark in a 30 pt orb that opens the
/// drawer (+, the mode pill, the model pill), the text, Dictate, Talk while it's empty, and
/// the 32 pt send button that turns into Stop while the session works. Its controls do Eden
/// Code's things: attach pictures, Manual or Accept edits, the model, dictation, send, steer
/// (into the running step) and stop; Talk reads the last reply aloud.
struct EdenComposer: View {
    @Binding var text: String
    var working: Bool
    var modeID: String
    var modeLabel: String
    var modelLabel: String
    /// The session's model's ref ("router" while Model Router routes it): the picker's check.
    var modelRef: String = ""
    var modes: [PhoneOptions.Mode]
    var models: [PhoneOptions.Model]
    var dictating: Bool
    var talking: Bool
    var attachments: Int
    var onSend: () -> Void
    var onSteer: () -> Void
    var onStop: () -> Void
    var onDictate: () -> Void
    var onTalk: () -> Void
    var onMode: (String) -> Void
    var onModel: (PhoneOptions.Model) -> Void
    var onPictures: ([PhotosPickerItem]) -> Void

    @FocusState private var focused: Bool
    @State private var expanded = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var choosingModel = false
    @Environment(\.colorScheme) private var scheme
    /// The sessions drawer opening over the screen: the keyboard goes (it stayed up over the
    /// drawer's Inbox, Queue and Mac on TestFlight 2: UIKit's resign alone didn't take, since
    /// this focus state held on to it).
    @Environment(\.drawerProgress) private var drawerProgress

    private var dark: Bool { scheme == .dark }
    /// The pill's words: "Bypass" for Bypass permissions (app.js JC_MODES short); the menu
    /// and VoiceOver keep the full name.
    private var modeShort: String {
        modes.first(where: { $0.id == modeID })?.short ?? CodeModes.short(modeID, name: modeLabel)
    }
    private var empty: Bool { text.trimmed.isEmpty && attachments == 0 }

    var body: some View {
        VStack(spacing: 0) {
            top
            if expanded { drawer.transition(.opacity.combined(with: .offset(y: -4))) }
        }
        .padding(EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 10))
        .background(fill)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(rim)
        .background(ring)
        // The model list opens above the whole bar, pointing down at it: never over the text
        // or its buttons (it used to be a Menu that unfolded over the bar).
        .popover(isPresented: $choosingModel, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
            ModelPicker(models: models, current: ModelMenu.current(models, ref: modelRef, label: modelLabel)) { model in
                choosingModel = false
                onModel(model)
            }
            .presentationCompactAdaptation(.popover)
            .presentationBackground(.regularMaterial)
        }
        .shadow(color: .black.opacity(dark ? 0.6 : 0.2), radius: dark ? 11 : 8, y: dark ? 14 : 10)
        .animation(.spring(response: 0.3, dampingFraction: 0.86), value: expanded)
        .animation(.easeOut(duration: 0.2), value: focused)
        .padding(.horizontal, 8)
        #if DEBUG
        .onAppear {
            if EdenDebug.composerOpen { expanded = true }
            if EdenDebug.focus { focused = true }
            if EdenDebug.models {
                expanded = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { choosingModel = true }
            }
        }
        #endif
        .onChange(of: drawerProgress > 0) { _, open in
            if open { focused = false; choosingModel = false; expanded = false }
        }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            onPictures(items)
            picked = []
        }
    }

    // MARK: - The row

    private var top: some View {
        HStack(alignment: .bottom, spacing: 8) {
            orb.padding(.bottom, 1)
            TextField("", text: $text, prompt: placeholder, axis: .vertical)
                .font(.eden(size: 16))
                .foregroundStyle(ComposerInk.ink(dark))
                .tint(ComposerInk.accent(dark))
                .lineLimit(1...6)
                .padding(.vertical, 5)
                .frame(minHeight: 34)
                .focused($focused)
                .submitLabel(.send)
                .accessibilityLabel("Message Eden Code")
            if working && !text.trimmed.isEmpty {
                steer.padding(.bottom, 1)
            }
            round(label: dictating ? "Stop dictating" : "Dictate", pressed: dictating, action: onDictate) {
                MicGlyph().stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).frame(width: 15, height: 15)
            }
            .padding(.bottom, 1)
            if empty && !working {
                round(label: talking ? "Stop reading" : "Read the last reply aloud", pressed: talking, action: onTalk) {
                    TalkGlyph().stroke(style: StrokeStyle(lineWidth: 1.6, lineCap: .round)).frame(width: 15, height: 15)
                }
                .padding(.bottom, 1)
            }
            send.padding(.leading, 2).padding(.bottom, 1)
        }
    }

    private var placeholder: Text {
        Text(working ? "Steer or reply…" : "Message Eden Code…")
            .font(.eden(size: 14.5))
            .foregroundStyle(ComposerInk.subtle(dark))
    }

    private var orb: some View {
        Button {
            expanded.toggle()
        } label: {
            EdenMark()
                .stroke(style: StrokeStyle(lineWidth: 0.9, lineJoin: .round))
                .foregroundStyle(expanded ? .white : ComposerInk.ink(dark))
                .frame(width: 15, height: 15)
                .frame(width: 30, height: 30)
                .background(Circle().fill(expanded ? ComposerInk.accent(dark) : ComposerInk.accent(dark).opacity(0.13)))
                .overlay(Circle().strokeBorder(ComposerInk.accent(dark).opacity(expanded ? 0 : 0.32), lineWidth: 1))
                .shadow(color: expanded ? ComposerInk.glow(dark).opacity(0.45) : .clear, radius: 8)
        }
        .buttonStyle(PressScale(scale: 0.9))
        .accessibilityLabel("Composer options")
        .accessibilityValue(expanded ? "Open" : "Closed")
    }

    private var steer: some View {
        Button(action: onSteer) {
            HStack(spacing: 5) {
                SteerGlyph().stroke(style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round)).frame(width: 13, height: 13)
                Text("Steer").font(.eden(size: 12, weight: .semibold))
            }
            .foregroundStyle(ComposerInk.ink(dark))
            .padding(.leading, 9).padding(.trailing, 11)
            .frame(height: 30)
            .background(Capsule().fill(ComposerInk.accent(dark).opacity(0.13)))
            .overlay(Capsule().strokeBorder(ComposerInk.accent(dark).opacity(0.3), lineWidth: 0.5))
        }
        .buttonStyle(PressScale(scale: 0.94))
        .accessibilityLabel("Steer: send into the running step")
    }

    private var send: some View {
        let stop = working && empty
        return Button {
            if stop { onStop() } else { onSend() }
        } label: {
            ZStack {
                Circle().fill(stop ? ComposerInk.ink(dark) : ComposerInk.accent(dark))
                if stop {
                    RoundedRectangle(cornerRadius: 2).fill(ComposerInk.surface(dark)).frame(width: 9, height: 9)
                } else {
                    SendGlyph().fill(ComposerInk.ink(dark)).frame(width: 15, height: 15)
                }
            }
            .frame(width: 32, height: 32)
            .overlay(Circle().strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(stop ? 0 : 0.22), location: 0), .init(color: .clear, location: 0.12)],
                                                          startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: ComposerInk.accent(dark).opacity(stop ? 0 : 0.3), radius: 1, y: 1)
        }
        .buttonStyle(PressScale(scale: 0.94))
        .accessibilityLabel(stop ? "Stop" : "Send")
    }

    private func round(label: String, pressed: Bool, action: @escaping () -> Void, @ViewBuilder glyph: () -> some View) -> some View {
        Button(action: action) {
            glyph()
                .foregroundStyle(pressed ? ComposerInk.accent(dark) : ComposerInk.ink(dark))
                .frame(width: 30, height: 30)
                .background(Circle().fill(pressed ? ComposerInk.accent(dark).opacity(0.13) : .clear))
        }
        .buttonStyle(PressScale(scale: 0.94))
        .accessibilityLabel(label)
    }

    // MARK: - The drawer

    private var drawer: some View {
        HStack(spacing: 4) {
            PhotosPicker(selection: $picked, maxSelectionCount: 6, matching: .images) {
                PlusGlyph().stroke(style: StrokeStyle(lineWidth: 1.7, lineCap: .round)).frame(width: 15, height: 15)
                    .foregroundStyle(ComposerInk.ink(dark))
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(ComposerInk.ink(dark).opacity(0.11)))
                    .overlay(Circle().strokeBorder(ComposerInk.ink(dark).opacity(0.11), lineWidth: 0.5))
            }
            .accessibilityLabel(attachments > 0 ? "Add pictures, \(attachments) added" : "Add pictures")
            Menu {
                ForEach(modes) { mode in
                    Button { onMode(mode.id) } label: {
                        Label(mode.name, systemImage: mode.id == modeID ? "checkmark" : CodeModes.symbol(mode.id))
                    }
                }
                Section("Bypass permissions and Auto are set on your Mac") {}
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: CodeModes.symbol(modeID)).font(.eden(size: 12, weight: .semibold))
                    Text(modeShort).font(.eden(size: 12, weight: .semibold)).lineLimit(1).fixedSize()
                    ChevronDown().stroke(style: StrokeStyle(lineWidth: 1.6)).frame(width: 9, height: 9)
                }
                .foregroundStyle(ComposerInk.accentInk(dark))
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background(Capsule().fill(ComposerInk.accent(dark).opacity(0.15)))
                .overlay(Capsule().strokeBorder(ComposerInk.accent(dark).opacity(0.4), lineWidth: 0.5))
            }
            .accessibilityLabel("Mode, \(modeLabel)")
            Spacer(minLength: 4)
            Button {
                focused = false
                choosingModel = true
            } label: {
                HStack(spacing: 6) {
                    Circle().fill(ComposerInk.accent(dark)).frame(width: 6, height: 6)
                        .shadow(color: ComposerInk.glow(dark).opacity(0.6), radius: 2)
                    Text(modelLabel.isEmpty ? "Model" : modelLabel).font(.eden(size: 12, weight: .semibold)).lineLimit(1)
                    ChevronDown().stroke(style: StrokeStyle(lineWidth: 1.6)).frame(width: 9, height: 9)
                }
                .foregroundStyle(ComposerInk.ink2(dark))
                .padding(.horizontal, 9)
                .frame(height: 26)
                .frame(maxWidth: 170)
                .background(Capsule().fill(ComposerInk.ink(dark).opacity(0.06)))
                .overlay(Capsule().strokeBorder(ComposerInk.ink(dark).opacity(0.11), lineWidth: 0.5))
                .contentShape(.capsule)
            }
            .buttonStyle(PressScale(scale: 0.96))
            .accessibilityLabel("Model, \(modelLabel)")
        }
        .padding(.top, 10)
        .padding(.bottom, 2)
        .overlay(alignment: .top) {
            LinearGradient(colors: [.clear, ComposerInk.ink(dark).opacity(0.14), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(height: 0.5)
        }
        .padding(.top, 9)
    }

    // MARK: - Glass

    /// Unfocused: Eden's clear glass (white 34 % → 16 % over a 22 pt blur; 7.5 % → 2 % dark).
    /// Focused, on a phone: the solid surface (mobile.css: no blur while typing).
    @ViewBuilder private var fill: some View {
        if focused {
            ComposerInk.surface(dark)
        } else {
            ZStack {
                Rectangle().fill(.ultraThinMaterial).opacity(dark ? 0.55 : 0.6)
                LinearGradient(colors: [.white.opacity(dark ? 0.075 : 0.34), .white.opacity(dark ? 0.02 : 0.16)], startPoint: .top, endPoint: .bottom)
            }
        }
    }

    /// The rim: a bright top line and a hairline inside; outside, a hairline edge (or, while
    /// typing, the accent ring and its glow).
    private var rim: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(.white.opacity(dark ? 0.1 : 0.45), lineWidth: 0.5)
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(dark ? 0.16 : 0.75), location: 0), .init(color: .clear, location: 0.06)],
                                             startPoint: .top, endPoint: .bottom), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private var ring: some View {
        if focused {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(ComposerInk.accent(dark).opacity(0.42), lineWidth: 1)
                .padding(-0.5)
                .background(RoundedRectangle(cornerRadius: 26, style: .continuous).fill(ComposerInk.glow(dark).opacity(0.12)).padding(-4))
        } else {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(.black.opacity(dark ? 0.55 : 0.09), lineWidth: 0.5)
                .padding(-0.25)
        }
    }
}

/// The model list (the composer's model pill): Model Router first, then each provider under
/// its heading as the Mac's model menu has them (ModelMenu.sections), friendly names, a quiet
/// note where there is one, the session's model checked; one that needs a key on the Mac is
/// shown, dimmed, and can't be picked. A popover above the input bar, in iOS's own glass.
struct ModelPicker: View {
    var models: [PhoneOptions.Model]
    var current: PhoneOptions.Model?
    var onPick: (PhoneOptions.Model) -> Void

    private var sections: [ModelMenu.Section] { ModelMenu.sections(models) }

    /// Tall enough for the list (a row ~50 pt with its note, 44 without; a heading 30), at most 440.
    private var height: CGFloat {
        let rows = models.reduce(CGFloat(0)) { $0 + (note($1).isEmpty ? 44 : 54) }
        let heads = CGFloat(sections.filter { !$0.title.isEmpty }.count) * 32
        return min(440, max(120, rows + heads + 16))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if models.isEmpty {
                    Text("Your Mac hasn’t sent its models yet.")
                        .font(.eden(size: 14)).foregroundStyle(EdenTheme.muted).padding(16)
                }
                ForEach(sections) { section in
                    if !section.title.isEmpty {
                        Text(section.title)
                            .font(.eden(size: 12, weight: .semibold))
                            .foregroundStyle(EdenTheme.muted)
                            .padding(EdgeInsets(top: 12, leading: 16, bottom: 4, trailing: 16))
                            .accessibilityAddTraits(.isHeader)
                    }
                    ForEach(section.models) { model in row(model) }
                    if section.title.isEmpty && sections.count > 1 {
                        Divider().padding(.horizontal, 12).padding(.top, 4)
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: 300, height: height)
    }

    private func note(_ model: PhoneOptions.Model) -> String {
        if !model.note.isEmpty { return model.note }
        return model.needsKey ? "Needs a key on your Mac" : ""
    }

    private func row(_ model: PhoneOptions.Model) -> some View {
        let chosen = current?.ref == model.ref
        let note = note(model)
        return Button { onPick(model) } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.name)
                        .font(.eden(size: 16, weight: model.router ? .semibold : .regular))
                        .foregroundStyle(EdenTheme.ink)
                        .lineLimit(1)
                    if !note.isEmpty {
                        Text(note).font(.eden(size: 12)).foregroundStyle(EdenTheme.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                if chosen {
                    Image(systemName: "checkmark").font(.eden(size: 14, weight: .semibold)).foregroundStyle(EdenTheme.accent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .contentShape(.rect)
            .opacity(model.needsKey ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(model.needsKey)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([model.name, note].filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
    }
}

/// Eden chat's colour tokens (app.css :root and [data-theme=dark]).
enum ComposerInk {
    static func accent(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0x2696EA : 0x0B87D6)) }
    static func accentInk(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0x70BEF8 : 0x0468AE)) }
    static func glow(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0x40B0F0 : 0x38A8E8)) }
    static func ink(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0xF5F5F7 : 0x1D1D1F)) }
    static func ink2(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0xB2B2B8 : 0x58585E)) }
    static func subtle(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0x66666C : 0xA2A2A8)) }
    static func surface(_ dark: Bool) -> Color { Color(UIColor(hex: dark ? 0x1C1C1F : 0xFFFFFF)) }
}

struct PressScale: ButtonStyle {
    var scale: CGFloat
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - The glyphs, from the page's own SVGs

/// The Eden mark (the orb's mask: two polygons in a 43 81 410 422 box).
struct EdenMark: Shape {
    func path(in rect: CGRect) -> Path {
        let box = CGRect(x: 43, y: 81, width: 410, height: 422)
        let scale = min(rect.width / box.width, rect.height / box.height)
        let dx = rect.minX + (rect.width - box.width * scale) / 2
        let dy = rect.minY + (rect.height - box.height * scale) / 2
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: dx + (x - box.minX) * scale, y: dy + (y - box.minY) * scale) }
        var path = Path()
        for poly in [[(211, 93), (314, 90), (444, 236), (343, 353), (249, 352), (333, 251)],
                     [(252, 235), (160, 346), (282, 491), (186, 494), (52, 350), (151, 234)]] {
            path.move(to: p(CGFloat(poly[0].0), CGFloat(poly[0].1)))
            for point in poly.dropFirst() { path.addLine(to: p(CGFloat(point.0), CGFloat(point.1))) }
            path.closeSubpath()
        }
        return path
    }
}

/// In a 16 × 16 box, scaled.
private func box16(_ rect: CGRect) -> (CGFloat, CGFloat) -> CGPoint {
    let s = min(rect.width, rect.height) / 16
    return { CGPoint(x: rect.minX + $0 * s, y: rect.minY + $1 * s) }
}

struct MicGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let p = box16(rect)
        let s = min(rect.width, rect.height) / 16
        var path = Path(roundedRect: CGRect(origin: p(5.6, 1.8), size: CGSize(width: 4.8 * s, height: 8 * s)), cornerRadius: 2.4 * s)
        path.move(to: p(3.3, 7.6))
        path.addArc(center: p(8, 7.6), radius: 4.7 * s, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: true)
        path.move(to: p(8, 12.4))
        path.addLine(to: p(8, 14.4))
        return path
    }
}

struct TalkGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let p = box16(rect)
        var path = Path()
        for (x, top, bottom) in [(2.5, 6.5, 9.5), (5, 4.5, 11.5), (8, 2.5, 13.5), (11, 4.5, 11.5), (13.5, 6.5, 9.5)] {
            path.move(to: p(x, top))
            path.addLine(to: p(x, bottom))
        }
        return path
    }
}

struct SendGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let p = box16(rect)
        var path = Path()
        path.move(to: p(8, 2.5))
        path.addLine(to: p(13, 7.5))
        path.addLine(to: p(11.9, 8.6))
        path.addLine(to: p(8.8, 5.5))
        path.addLine(to: p(8.8, 13.5))
        path.addLine(to: p(7.2, 13.5))
        path.addLine(to: p(7.2, 5.5))
        path.addLine(to: p(4.1, 8.6))
        path.addLine(to: p(3, 7.5))
        path.closeSubpath()
        return path
    }
}

struct SteerGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let p = box16(rect)
        var path = Path()
        path.move(to: p(3, 13))
        path.addQuadCurve(to: p(11, 5), control: p(3, 5))
        path.move(to: p(8, 2))
        path.addLine(to: p(11, 5))
        path.addLine(to: p(8, 8))
        return path
    }
}

struct PlusGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let p = box16(rect)
        var path = Path()
        path.move(to: p(8, 3)); path.addLine(to: p(8, 13))
        path.move(to: p(3, 8)); path.addLine(to: p(13, 8))
        return path
    }
}

struct ChevronDown: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 10
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + 2.5 * s, y: rect.minY + 3.8 * s))
        path.addLine(to: CGPoint(x: rect.minX + 5 * s, y: rect.minY + 6.3 * s))
        path.addLine(to: CGPoint(x: rect.minX + 7.5 * s, y: rect.minY + 3.8 * s))
        return path
    }
}
