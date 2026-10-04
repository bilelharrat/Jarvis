import SwiftUI

/// Settings › Look: Stark Glass or Obsidian, as on the Mac, each shown as it looks.
struct LookPicker: View {
    @AppStorage(Look.key) private var raw = Look.starkGlass.rawValue

    var body: some View {
        Section {
            ForEach(Look.allCases) { look in
                Button {
                    raw = look.rawValue
                } label: {
                    HStack(spacing: Space.s) {
                        LookSwatch(look: look)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(look.title)
                                .foregroundStyle(Palette.ink)
                            Text(look.summary)
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        if raw == look.rawValue {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Palette.cyan)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(raw == look.rawValue ? .isSelected : [])
            }
        } header: {
            Text("Look")
        } footer: {
            Text("The same looks as Jarvis on your Mac.")
        }
    }
}

/// A small picture of a look: its ground and its reactor, still.
private struct LookSwatch: View {
    let look: Look

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        ZStack {
            switch look {
            case .starkGlass:
                LinearGradient(colors: [Color(hex: 0x082448), Color(hex: 0x03060D)], startPoint: .top, endPoint: .bottom)
                Circle()
                    .fill(RadialGradient(colors: [Color(hex: 0xF2FBFF), Color(hex: 0x3FB8F2), Color(hex: 0x0A3D84)], center: .center, startRadius: 0, endRadius: 11))
                    .frame(width: 20, height: 20)
                    .overlay(Circle().strokeBorder(Color(hex: 0xE8C27A).opacity(0.8), lineWidth: 1).padding(-4))
            case .obsidian:
                Obsidian.bg
                SwatchDial()
                    .frame(width: 30, height: 30)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

/// Obsidian's dial at rest, small: ticks, brass quarters and the bright point.
private struct SwatchDial: View {
    var body: some View {
        Canvas { context, size in
            let r = min(size.width, size.height) / 2
            context.translateBy(x: size.width / 2, y: size.height / 2)
            var ticks = Path()
            for i in 0..<48 {
                let a = Double(i) / 48 * .pi * 2
                let long = i % 4 == 0
                ticks.move(to: CGPoint(x: cos(a) * r * 0.72, y: sin(a) * r * 0.72))
                ticks.addLine(to: CGPoint(x: cos(a) * r * (long ? 0.95 : 0.84), y: sin(a) * r * (long ? 0.95 : 0.84)))
            }
            context.stroke(ticks, with: .color(Obsidian.arc.opacity(0.75)), lineWidth: 0.7)
            var quarters = Path()
            for q in 0..<4 {
                let a = Double(q) * .pi / 2
                quarters.move(to: CGPoint(x: cos(a) * r * 0.95, y: sin(a) * r * 0.95))
                quarters.addLine(to: CGPoint(x: cos(a) * r, y: sin(a) * r))
            }
            context.stroke(quarters, with: .color(Obsidian.brass), lineWidth: 1.4)
            context.stroke(Path(ellipseIn: CGRect(x: -r * 0.22, y: -r * 0.22, width: r * 0.44, height: r * 0.44)), with: .color(Obsidian.arc), lineWidth: 0.9)
            context.fill(Path(ellipseIn: CGRect(x: -1.5, y: -1.5, width: 3, height: 3)), with: .color(Obsidian.core))
        }
    }
}
