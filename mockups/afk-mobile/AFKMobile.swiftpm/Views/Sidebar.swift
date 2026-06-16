import SwiftUI

// The headline UI: sessions grouped by the slash command that spawned them.
// Collapsible per-command sections; live status; "needs you" filtering; search;
// and a glass "+" that opens the new-session command palette.
struct SidebarView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 10) {
            header
            sessionList
        }
        .background(Theme.bg)
        .navigationTitle(" ")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $model.search,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search sessions"
        )
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.showNewSession = true } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.glass)
                .accessibilityLabel("New session")
            }
        }
        .sheet(isPresented: $model.showNewSession) {
            NewSessionSheet(model: model)
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                liveDot
                Text("afk")
                    .font(Theme.mono(.title3, weight: .bold))
                    .foregroundStyle(Theme.text)
                Spacer()
                Text("\(model.runningCount) running")
                    .font(Theme.mono(.caption, weight: .medium))
                    .foregroundStyle(Theme.muted)
                if model.needsYouCount > 0 {
                    Text("\(model.needsYouCount) need you")
                        .font(Theme.mono(.caption, weight: .medium))
                        .foregroundStyle(Theme.amber)
                }
            }
            FilterSegment(model: model)
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
    }

    private var liveDot: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 7))
            .foregroundStyle(model.runningCount > 0 ? Theme.accent : Theme.faint)
            .symbolEffect(.variableColor.iterative, isActive: model.runningCount > 0)
    }

    private var sessionList: some View {
        List(selection: $model.selectedSessionID) {
            ForEach(model.groups, id: \.command.id) { group in
                Section {
                    if model.isExpanded(group.command.name) {
                        ForEach(group.sessions) { session in
                            SessionRowView(session: session)
                                .tag(session.id)
                                .listRowBackground(
                                    model.selectedSessionID == session.id
                                        ? Theme.accent.opacity(0.12) : Color.clear
                                )
                                .listRowSeparatorTint(Theme.border)
                        }
                    }
                } header: {
                    CommandGroupHeader(
                        command: group.command,
                        count: group.sessions.count,
                        expanded: model.isExpanded(group.command.name)
                    ) {
                        withAnimation(.snappy) { model.toggle(group.command.name) }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
    }
}

struct CommandGroupHeader: View {
    let command: SlashCommand
    let count: Int
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                Image(systemName: command.symbol)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 16)
                Text(command.name)
                    .font(Theme.mono(.subheadline, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("\(count)")
                    .font(Theme.mono(.caption2, weight: .medium))
                    .foregroundStyle(Theme.faint)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Theme.elev, in: Capsule())
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.faint)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
    }
}

struct SessionRowView: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            StatusBadge(status: session.status).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(session.model)
                    Text("·")
                    Text(session.elapsed)
                    if session.surface == .daemon {
                        Image(systemName: "moon.fill").font(.system(size: 8))
                    }
                }
                .font(Theme.mono(.caption2))
                .foregroundStyle(Theme.faint)
            }
            Spacer(minLength: 4)
            if session.status.needsYou {
                Chip(text: "needs you", color: session.status.color, mono: false)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.title), \(session.status.label)")
    }
}

// New-session command palette — bottom sheet with detents + search.
struct NewSessionSheet: View {
    @Bindable var model: AppModel
    @State private var query = ""

    private var filtered: [SlashCommand] {
        query.isEmpty
            ? SlashCommand.all
            : SlashCommand.all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered) { cmd in
                    Button { model.newSession(command: cmd) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: cmd.symbol)
                                .foregroundStyle(Theme.accent).frame(width: 22)
                            Text(cmd.name)
                                .font(Theme.mono(.body, weight: .medium))
                                .foregroundStyle(Theme.text)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption).foregroundStyle(Theme.faint)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgElev)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Filter slash commands")
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.bgElev)
        .tint(Theme.accent)
    }
}

#Preview("Sidebar") {
    NavigationSplitView {
        SidebarView(model: .demo())
    } detail: {
        Color(Theme.bg)
    }
    .preferredColorScheme(.dark)
}
