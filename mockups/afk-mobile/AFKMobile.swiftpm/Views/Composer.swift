import SwiftUI

// Glass composer pinned to the bottom safe-area bar. The `/` button opens a slash
// command palette that prefixes the field.
struct ComposerBar: View {
    @Binding var text: String
    let placeholder: String
    let onSend: (String) -> Void
    @State private var sendTick = 0

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                Menu {
                    ForEach(SlashCommand.all) { cmd in
                        Button(cmd.name) { text = cmd.name + " " }
                    }
                } label: {
                    Image(systemName: "slash.circle").font(.title3)
                }
                .buttonStyle(.glass)
                .foregroundStyle(Theme.accentSoft)
                .accessibilityLabel("Slash commands")

                TextField(placeholder, text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.subheadline)
                    .lineLimit(1...4)
                    .foregroundStyle(Theme.text)

                Button {
                    onSend(text)
                    sendTick += 1
                } label: {
                    Image(systemName: "arrow.up").font(.headline)
                }
                .buttonStyle(.glassProminent)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .sensoryFeedback(.success, trigger: sendTick)
    }
}

// When a session is `asking`, the composer becomes the matching answer affordance
// for the elicitation type — the killer "answer from your phone" flow.
struct ElicitationComposer: View {
    let elicitation: Elicitation
    let onAnswer: (String) -> Void

    @State private var textValue = ""
    @State private var numberValue = 0.0
    @State private var multi: Set<String> = []
    @State private var showDetails = false
    @State private var confirmingSkip = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle.fill").foregroundStyle(Theme.amber)
                Text("agent needs you").font(.caption.weight(.bold)).foregroundStyle(Theme.amber)
                Spacer(minLength: 4)
                Chip(text: elicitation.type.label, color: Theme.faint)
            }
            Text(elicitation.message).font(.subheadline).foregroundStyle(Theme.text)
            if let context = elicitation.context {
                Text(context).font(.caption2).foregroundStyle(Theme.muted)
            }
            if elicitation.assumption != nil || elicitation.followup != nil {
                DisclosureGroup(isExpanded: $showDetails) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let a = elicitation.assumption { detailRow("If unanswered", a) }
                        if let f = elicitation.followup { detailRow("Once answered", f) }
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Text("details")
                        .font(Theme.mono(.caption2, weight: .semibold))
                        .foregroundStyle(Theme.muted)
                }
                .tint(Theme.muted)
            }
            control
            if elicitation.allowSkip {
                Button("Skip") { confirmingSkip = true }
                    .font(.caption).foregroundStyle(Theme.muted)
                    .confirmationDialog("Skip this question?", isPresented: $confirmingSkip, titleVisibility: .visible) {
                        Button("Skip — use the agent's default", role: .destructive) { onAnswer("(skipped)") }
                        Button("Cancel", role: .cancel) { }
                    } message: {
                        Text("The agent will proceed with its stated assumption.")
                    }
            }
        }
        .padding(14)
        .background(Theme.elev, in: RoundedRectangle(cornerRadius: Theme.rLg))
        .overlay(RoundedRectangle(cornerRadius: Theme.rLg).stroke(Theme.amber.opacity(0.4), lineWidth: 1.5))
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .onAppear {
            textValue = elicitation.defaultText ?? ""
            numberValue = elicitation.minValue ?? 0
        }
    }

    @ViewBuilder
    private var control: some View {
        switch elicitation.type {
        case .confirm:
            HStack(spacing: 8) {
                Button { onAnswer("No") } label: {
                    Label("No", systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                Button { onAnswer("Yes") } label: {
                    Label("Yes", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
            }
        case .choice:
            VStack(spacing: 8) {
                ChoiceChips(options: elicitation.choices) { onAnswer($0) }
                if elicitation.allowCustom { customField }
            }
        case .multiChoice:
            VStack(spacing: 8) {
                ChoiceChips(options: elicitation.choices, selected: multi) { opt in
                    if multi.contains(opt) { multi.remove(opt) } else { multi.insert(opt) }
                }
                Button {
                    onAnswer(multi.sorted().joined(separator: ", "))
                } label: {
                    Text("Send \(multi.count) selected").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .disabled(multi.isEmpty)
            }
        case .number:
            HStack(spacing: 10) {
                Stepper(
                    value: $numberValue,
                    in: (elicitation.minValue ?? 0)...(elicitation.maxValue ?? 100)
                ) {
                    Text("\(Int(numberValue))")
                        .font(Theme.mono(.body, weight: .bold))
                        .foregroundStyle(Theme.text)
                }
                Button { onAnswer("\(Int(numberValue))") } label: {
                    Image(systemName: "arrow.up")
                }
                .buttonStyle(.glassProminent)
            }
        case .text:
            HStack(spacing: 8) {
                TextField("answer…", text: $textValue)
                    .textFieldStyle(.plain)
                    .foregroundStyle(Theme.text)
                Button { onAnswer(textValue) } label: {
                    Image(systemName: "arrow.up")
                }
                .buttonStyle(.glassProminent)
                .disabled(textValue.isEmpty)
            }
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(Theme.mono(.caption2, weight: .bold)).foregroundStyle(Theme.faint)
            Text(value).font(.caption2).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var customField: some View {
        HStack(spacing: 8) {
            TextField("type your own…", text: $textValue)
                .textFieldStyle(.plain)
                .font(.caption)
                .foregroundStyle(Theme.text)
            Button { onAnswer(textValue) } label: {
                Image(systemName: "arrow.up").font(.caption)
            }
            .buttonStyle(.glass)
            .disabled(textValue.isEmpty)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.surface, in: Capsule())
    }
}

// Wrapping chips via an adaptive grid (no custom Layout needed).
struct ChoiceChips: View {
    let options: [String]
    var selected: Set<String> = []
    let action: (String) -> Void

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 92), spacing: 8)],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(options, id: \.self) { opt in
                let on = selected.contains(opt)
                Button { action(opt) } label: {
                    Text(opt)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, minHeight: 22)
                        .foregroundStyle(on ? Theme.bg : Theme.text)
                }
                .buttonStyle(.glass)
                .background { if on { Capsule().fill(Theme.accent) } }
            }
        }
    }
}

#Preview("Composers") {
    VStack(spacing: 20) {
        Spacer()
        ElicitationComposer(elicitation: Elicitation(
            type: .choice,
            message: "Which retry policy for transient 529s?",
            context: "Affects worst-case latency.",
            choices: ["Exponential ×3", "Exponential ×5", "Linear ×3", "No retry"],
            allowSkip: true, allowCustom: true
        )) { _ in }
        ComposerBar(text: .constant(""), placeholder: "message s2…") { _ in }
    }
    .background(Theme.bg)
    .preferredColorScheme(.dark)
}
