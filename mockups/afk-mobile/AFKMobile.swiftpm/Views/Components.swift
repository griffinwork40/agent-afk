import SwiftUI
import Charts

// MARK: - Status badge (color + animated symbol)

struct StatusBadge: View {
    let status: SessionStatus
    var size: CGFloat = 13
    var body: some View {
        Image(systemName: status.symbol)
            .font(.system(size: size, weight: .bold))
            .foregroundStyle(status.color)
            .symbolEffect(.variableColor.iterative, isActive: status.isLive)
            .contentTransition(.symbolEffect(.replace))
    }
}

// MARK: - Small capsule chip

struct Chip: View {
    let text: String
    var color: Color = Theme.faint
    var mono: Bool = true
    var body: some View {
        Text(text)
            .font(mono ? Theme.mono(.caption2, weight: .semibold) : .caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }
}

// MARK: - Markdown (uses SwiftUI's built-in attributed-string markdown)

struct MarkdownText: View {
    let text: String
    var body: some View {
        if let attr = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attr)
        } else {
            Text(text)
        }
    }
}

// MARK: - Streaming text (progressive reveal + blinking caret)

struct StreamingText: View {
    let full: String
    @State private var shown = ""
    @State private var done = false
    @State private var caretOn = true

    var body: some View {
        HStack(alignment: .bottom, spacing: 1) {
            MarkdownText(text: shown)
                .font(.subheadline)
                .foregroundStyle(Theme.text)
            if !done {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Theme.accent)
                    .frame(width: 7, height: 15)
                    .opacity(caretOn ? 1 : 0.15)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                            caretOn.toggle()
                        }
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: full) { await reveal() }
    }

    private func reveal() async {
        shown = ""
        done = false
        for ch in full {
            shown.append(ch)
            try? await Task.sleep(nanoseconds: 16_000_000)
        }
        done = true
    }
}

// MARK: - Token sparkline (Swift Charts)

struct TokenSparkline: View {
    let values: [Double]
    var body: some View {
        Chart(Array(values.enumerated()), id: \.offset) { idx, v in
            LineMark(x: .value("i", idx), y: .value("tokens", v))
                .interpolationMethod(.catmullRom)
                .foregroundStyle(Theme.accent)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .frame(width: 56, height: 20)
        .accessibilityHidden(true)
    }
}

// MARK: - Filter segment (glass container, accent pill for selection)

struct FilterSegment: View {
    @Bindable var model: AppModel
    var body: some View {
        GlassEffectContainer(spacing: 4) {
            HStack(spacing: 4) {
                ForEach(SessionFilter.allCases) { f in
                    let selected = model.filter == f
                    HStack(spacing: 4) {
                        Text(f.rawValue).lineLimit(1)
                        if f == .needsYou && model.needsYouCount > 0 {
                            Text("\(model.needsYouCount)")
                                .font(.caption2.bold())
                                .foregroundStyle(selected ? Theme.bg : Theme.amber)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(selected ? Theme.bg : Theme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background { if selected { Capsule().fill(Theme.accent) } }
                    .contentShape(Capsule())
                    .onTapGesture { withAnimation(.snappy) { model.filter = f } }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel("\(f.rawValue) filter")
                }
            }
            .padding(4)
        }
        .glassEffect(.regular, in: .capsule)
    }
}

// MARK: - Jump-to-latest (floating glass capsule)

struct JumpToLatestButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.down")
                Text("Latest").font(.caption.weight(.semibold))
            }
        }
        .buttonStyle(.glass)
        .foregroundStyle(Theme.accentSoft)
        .accessibilityLabel("Jump to latest message")
    }
}

#Preview("Components") {
    VStack(spacing: 16) {
        HStack(spacing: 12) {
            ForEach(SessionStatus.allCases, id: \.self) { StatusBadge(status: $0) }
        }
        TokenSparkline(values: [2, 5, 4, 8, 12, 9, 15, 22, 30])
        Chip(text: "needs you", color: Theme.amber)
        JumpToLatestButton {}
    }
    .padding()
    .background(Theme.bg)
}
