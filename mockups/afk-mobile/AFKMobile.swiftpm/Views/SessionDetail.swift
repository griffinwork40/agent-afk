import SwiftUI

// The chat⇄IDE-hybrid transcript. Pinned glass status header + bottom composer
// (both participate in scroll-edge effects). Composer becomes an answer affordance
// when the session is `asking`. Floating jump-to-latest when scrolled up.
struct SessionDetailView: View {
    @Bindable var model: AppModel
    @State private var composerText = ""
    @State private var awayFromBottom = false

    var body: some View {
        Group {
            if let session = model.selectedSession {
                transcript(for: session)
            } else {
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func transcript(for session: Session) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(session.messages) { message in
                        MessageView(message: message).id(message.id)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.hard, for: .bottom)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentSize.height - (geo.contentOffset.y + geo.containerSize.height) > 140
            } action: { _, away in
                awayFromBottom = away
            }
            .safeAreaBar(edge: .top) {
                StatusHeaderBar(session: session)
            }
            .safeAreaBar(edge: .bottom) {
                bottomBar(for: session)
            }
            .overlay(alignment: .bottomTrailing) {
                if awayFromBottom {
                    JumpToLatestButton {
                        withAnimation { proxy.scrollTo(session.messages.last?.id, anchor: .bottom) }
                    }
                    .padding(.trailing, 16)
                    .padding(.bottom, 8)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .onChange(of: session.messages.count) {
                withAnimation { proxy.scrollTo(session.messages.last?.id, anchor: .bottom) }
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Fork session", systemImage: "arrow.triangle.branch") {}
                    Button("Clear context", systemImage: "eraser") {}
                    Button("Copy session id", systemImage: "doc.on.doc") {}
                    Divider()
                    Button("Abort", systemImage: "stop.circle", role: .destructive) {}
                } label: {
                    Image(systemName: "ellipsis")
                }
                .buttonStyle(.glass)
            }
        }
    }

    @ViewBuilder
    private func bottomBar(for session: Session) -> some View {
        if let elicitation = session.pendingElicitation, session.surface != .daemon {
            ElicitationComposer(elicitation: elicitation) { answer in
                model.answerElicitation(answer, for: session.id)
            }
        } else if session.surface == .daemon {
            HStack(spacing: 8) {
                Image(systemName: "moon.fill").foregroundStyle(Theme.faint)
                Text("headless · running on the daemon")
                    .font(Theme.mono(.caption)).foregroundStyle(Theme.faint)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .glassEffect(.regular, in: .rect(cornerRadius: 0))
        } else {
            ComposerBar(text: $composerText, placeholder: "Message…") { text in
                model.sendUserMessage(text, to: session.id)
                composerText = ""
            }
        }
    }
}

struct StatusHeaderBar: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            StatusBadge(status: session.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.command.name)
                    .font(Theme.mono(.subheadline, weight: .semibold))
                    .foregroundStyle(Theme.text)
                HStack(spacing: 5) {
                    Text(session.status.label).foregroundStyle(session.status.color)
                    Text("·")
                    Text(session.model)
                    Text("·")
                    Text("\(session.turns) turns")
                    Text("·")
                    Text(session.elapsed)
                }
                .font(Theme.mono(.caption2))
                .foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 1) {
                TokenSparkline(values: session.tokenSeries)
                Text("\(session.tokens / 1000)k tok")
                    .font(Theme.mono(.caption2))
                    .foregroundStyle(Theme.faint)
            }
            Image(systemName: session.surface.symbol)
                .font(.caption)
                .foregroundStyle(Theme.faint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 0))
        .accessibilityElement(children: .combine)
    }
}

#Preview("Detail") {
    NavigationStack {
        SessionDetailView(model: .demo())
    }
    .preferredColorScheme(.dark)
}
