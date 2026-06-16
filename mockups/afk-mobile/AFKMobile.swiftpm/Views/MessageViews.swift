import SwiftUI

// Renders one transcript item by kind. Content surfaces are solid (never glass).
struct MessageView: View {
    let message: Message
    var body: some View {
        Group {
            switch message.kind {
            case .user(let t): UserBubble(text: t)
            case .agentText(let t): AgentText(text: t, streaming: false)
            case .agentStreaming(let t): AgentText(text: t, streaming: true)
            case .thinking(let t): ReasoningCard(text: t)
            case .toolCall(let tc): ToolCallCard(tool: tc)
            case .toolDiff(let d): DiffView(diff: d)
            case .subagents(let s): SubagentTree(subs: s)
            case .compose(let n): ComposePipelineView(nodes: n)
            case .panel(let p): PanelCard(panel: p)
            case .paused(let at, let auto): PausedBanner(resetsAt: at, autoResume: auto)
            case .terminal(let ts): TerminalStateBanner(state: ts)
            }
        }
    }
}

struct UserBubble: View {
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("you")
                .font(Theme.mono(.caption2, weight: .bold))
                .foregroundStyle(Theme.accentSoft)
                .padding(.top, 2)
            MarkdownText(text: text)
                .font(.subheadline)
                .foregroundStyle(Theme.text)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.border, lineWidth: 1))
    }
}

struct AgentText: View {
    let text: String
    let streaming: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("agent")
                .font(Theme.mono(.caption2, weight: .bold))
                .foregroundStyle(Theme.accent)
            if streaming {
                StreamingText(full: text)
            } else {
                MarkdownText(text: text)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct ReasoningCard: View {
    let text: String
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.caption2)
                    Text("reasoning").font(Theme.mono(.caption2, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer()
                }
                .foregroundStyle(Theme.faint)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text(text)
                    .font(Theme.mono(.caption))
                    .italic()
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(Theme.bgElev, in: RoundedRectangle(cornerRadius: Theme.r))
    }
}

struct ToolCallCard: View {
    let tool: ToolCall
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { open.toggle() } } label: { header }
                .buttonStyle(.plain)
            if open {
                Divider().overlay(Theme.border)
                codeBlock(label: "input", text: tool.input)
                if !tool.output.isEmpty {
                    Divider().overlay(Theme.border)
                    codeBlock(label: "output", text: tool.output)
                }
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.border, lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: open ? "chevron.down" : "chevron.right")
                .font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.faint)
            Image(systemName: tool.symbol).font(.caption).foregroundStyle(Theme.accentSoft)
            Text(tool.name).font(Theme.mono(.caption, weight: .bold)).foregroundStyle(Theme.text)
            Text(tool.arg).font(Theme.mono(.caption)).foregroundStyle(Theme.muted).lineLimit(1)
            Spacer(minLength: 4)
            if tool.truncated { Chip(text: "truncated", color: Theme.amber) }
            Image(systemName: tool.status.symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(tool.status.color)
                .symbolEffect(.variableColor.iterative, isActive: tool.status == .running)
            if tool.durationMs > 0 {
                Text("\(tool.durationMs)ms").font(Theme.mono(.caption2)).foregroundStyle(Theme.faint)
            }
        }
        .padding(10)
        .contentShape(Rectangle())
    }

    private func codeBlock(label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Theme.mono(.caption2, weight: .bold)).foregroundStyle(Theme.faint)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(Theme.mono(.caption))
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Theme.bg)
    }
}

// Unified diff: gutter line numbers, colored left-border accent (not a full-bg fill),
// horizontal scroll for long lines.
struct DiffView: View {
    let diff: FileDiff
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "plus.forwardslash.minus").font(.caption2).foregroundStyle(Theme.faint)
                Text(diff.path).font(Theme.mono(.caption, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 4)
                Text("+\(diff.added)").font(Theme.mono(.caption2)).foregroundStyle(Theme.success)
                Text("−\(diff.removed)").font(Theme.mono(.caption2)).foregroundStyle(Theme.danger)
            }
            .padding(10)
            Divider().overlay(Theme.border)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(diff.lines) { line in
                        HStack(spacing: 0) {
                            Text(line.oldNum.map(String.init) ?? "")
                                .frame(width: 28, alignment: .trailing).foregroundStyle(Theme.faint)
                            Text(line.newNum.map(String.init) ?? "")
                                .frame(width: 28, alignment: .trailing).foregroundStyle(Theme.faint)
                                .padding(.trailing, 6)
                            Rectangle().fill(line.kind.color).frame(width: 2)
                            Text(line.kind.sign + " " + line.text)
                                .foregroundStyle(line.kind == .context ? Theme.muted : Theme.text)
                                .padding(.leading, 6)
                        }
                        .font(Theme.mono(.caption))
                        .padding(.vertical, 1)
                        .background(bg(line.kind))
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.border, lineWidth: 1))
    }

    private func bg(_ kind: DiffKind) -> Color {
        switch kind {
        case .add: Theme.success.opacity(0.08)
        case .remove: Theme.danger.opacity(0.08)
        case .context: .clear
        }
    }
}

struct SubagentTree: View {
    let subs: [SubagentRef]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(Theme.accent)
                Text("dispatched \(subs.count) subagents")
                    .font(Theme.mono(.caption, weight: .semibold)).foregroundStyle(Theme.text)
            }
            ForEach(subs) { sub in
                HStack(spacing: 10) {
                    Image(systemName: sub.status.symbol)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(sub.status.color)
                        .symbolEffect(.variableColor.iterative, isActive: sub.status == .running)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sub.label).font(Theme.mono(.caption, weight: .medium)).foregroundStyle(Theme.text)
                        Text(sub.summary).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if sub.status == .running {
                        HStack(spacing: 6) {
                            Text("\(sub.turns)t").font(Theme.mono(.caption2)).foregroundStyle(Theme.muted)
                            ProgressView(value: sub.completion).frame(width: 48).tint(Theme.accent)
                        }
                    } else {
                        Text("\(sub.turns)t").font(Theme.mono(.caption2)).foregroundStyle(Theme.faint)
                    }
                }
                .padding(.leading, 4)
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.border, lineWidth: 1))
    }
}

struct ComposePipelineView: View {
    let nodes: [ComposeNode]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.caption).foregroundStyle(Theme.accent)
                Text("compose · DAG").font(Theme.mono(.caption, weight: .semibold)).foregroundStyle(Theme.text)
            }
            HStack(spacing: 6) {
                ForEach(Array(nodes.enumerated()), id: \.element.id) { idx, node in
                    nodeChip(node)
                    if idx < nodes.count - 1 {
                        Image(systemName: "arrow.right").font(.system(size: 10)).foregroundStyle(Theme.faint)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.border, lineWidth: 1))
    }

    private func nodeChip(_ node: ComposeNode) -> some View {
        HStack(spacing: 5) {
            Image(systemName: node.status.symbol)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(node.status.color)
                .symbolEffect(.variableColor.iterative, isActive: node.status == .running)
            Text(node.label).font(Theme.mono(.caption2, weight: .medium)).foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(node.status.color.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(node.status.color.opacity(0.4), lineWidth: 1))
    }
}

struct PanelCard: View {
    let panel: Panel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "square.text.square.fill").foregroundStyle(Theme.accent)
                Text(panel.title).font(Theme.mono(.caption, weight: .bold)).foregroundStyle(Theme.text)
                Spacer(minLength: 4)
                Chip(text: panel.badge, color: Theme.accentSoft)
            }
            ForEach(panel.lines, id: \.self) { line in
                HStack(alignment: .top, spacing: 6) {
                    Text("›").foregroundStyle(Theme.accent)
                    Text(line).font(.caption).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .background(Theme.elev, in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.accent.opacity(0.3), lineWidth: 1))
    }
}

struct PausedBanner: View {
    let resetsAt: String
    let autoResume: Bool
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "hourglass").foregroundStyle(Theme.amber)
            VStack(alignment: .leading, spacing: 2) {
                Text("Usage limit reached").font(.caption.weight(.semibold)).foregroundStyle(Theme.text)
                Text(autoResume ? "Auto-resuming at \(resetsAt)" : "Resend to continue · resets \(resetsAt)")
                    .font(.caption2).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 4)
            if autoResume { ProgressView().controlSize(.small).tint(Theme.amber) }
        }
        .padding(12)
        .background(Theme.amber.opacity(0.1), in: RoundedRectangle(cornerRadius: Theme.r))
        .overlay(RoundedRectangle(cornerRadius: Theme.r).stroke(Theme.amber.opacity(0.4), lineWidth: 1))
    }
}

// End-of-turn terminal state — the prominent banner that closes a turn.
struct TerminalStateBanner: View {
    let state: TerminalState
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: state.kind.symbol).foregroundStyle(state.kind.color)
                Text(state.kind.rawValue)
                    .font(Theme.mono(.subheadline, weight: .heavy))
                    .foregroundStyle(state.kind.color)
                Spacer(minLength: 0)
            }
            ForEach(state.fields) { field in
                VStack(alignment: .leading, spacing: 1) {
                    Text(field.label)
                        .font(Theme.mono(.caption2, weight: .bold))
                        .foregroundStyle(Theme.faint)
                    Text(field.value)
                        .font(.caption)
                        .foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(state.kind.color.opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.rLg))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(state.kind.color.opacity(0.45), lineWidth: 1.5))
    }
}

#Preview("Message kinds") {
    ScrollView {
        VStack(spacing: 14) {
            MessageView(message: Message(kind: .user("fix the flaky test")))
            MessageView(message: Message(kind: .agentText("On it — **reproducing** first.")))
            MessageView(message: Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "vitest --run", input: "pnpm test", output: "✓ 40 passed", status: .ok, durationMs: 1200))))
            MessageView(message: Message(kind: .terminal(TerminalState(kind: .done, fields: [
                TerminalField(label: "What was done", value: "Fixed the race."),
                TerminalField(label: "Evidence", value: "40/40 pass."),
            ]))))
        }
        .padding()
    }
    .background(Theme.bg)
    .preferredColorScheme(.dark)
}
