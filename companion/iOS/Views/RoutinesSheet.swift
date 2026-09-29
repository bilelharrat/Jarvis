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
                        VStack(spacing: 10) {
                            ForEach(routines) { routine in
                                Button {
                                    onRun(routine)
                                    dismiss()
                                } label: {
                                    HStack(spacing: 14) {
                                        Image(systemName: "bolt.fill")
                                            .foregroundStyle(Palette.cyan)
                                            .frame(width: 28)
                                        Text(routine.name)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(Palette.ink)
                                            .multilineTextAlignment(.leading)
                                        Spacer()
                                        Image(systemName: "play.fill")
                                            .font(.footnote)
                                            .foregroundStyle(Palette.space)
                                            .frame(width: 30, height: 30)
                                            .background(Circle().fill(Palette.action))
                                    }
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 12)
                                }
                                .buttonStyle(GlassButtonStyle(cornerRadius: 16))
                                .accessibilityLabel("Run \(routine.name)")
                            }
                        }
                        .padding(20)
                    }
                }
            }
            .background(SpaceBackground(glow: UnitPoint(x: 0.5, y: 0)))
            .navigationTitle("Routines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
