import SwiftUI

/// Run one of the Mac's routines now.
struct RoutinesSheet: View {
    let routines: [Routine]
    let onRun: (Routine) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if routines.isEmpty {
                    ContentUnavailableView {
                        Label("No routines yet", systemImage: "bolt.slash")
                    } description: {
                        Text("Routines you set up in Jarvis on your Mac show up here, ready to run.")
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text("Runs on your Mac, right away.")
                                .font(.footnote)
                                .foregroundStyle(Palette.muted)
                                .padding(.horizontal, Space.m)
                            VStack(spacing: 0) {
                                ForEach(routines) { routine in
                                    row(routine)
                                    if routine.id != routines.last?.id {
                                        Rectangle()
                                            .fill(Palette.hairline)
                                            .frame(height: 0.5)
                                            .padding(.leading, 60)
                                    }
                                }
                            }
                            .glassCard(cornerRadius: 20)
                        }
                        .padding(.horizontal, Space.m + 4)
                        .padding(.top, Space.xs)
                        .padding(.bottom, Space.l)
                    }
                }
            }
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: -0.1)))
            .navigationTitle("Routines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Radius.sheet + 4)
    }

    private func row(_ routine: Routine) -> some View {
        Button {
            onRun(routine)
            dismiss()
        } label: {
            HStack(spacing: Space.s + 2) {
                IconTile(symbol: "bolt.fill")
                Text(routine.name)
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: Space.xs)
                Image(systemName: "play.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Palette.onAction)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Palette.action))
                    .overlay(Circle().strokeBorder(.white.opacity(0.45), lineWidth: 0.5))
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityLabel("Run \(routine.name)")
    }
}

/// A row that lights up while pressed, like a Settings cell.
private struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color.white.opacity(configuration.isPressed ? 0.06 : 0))
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}
