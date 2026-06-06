---
name: research
description: "Dispatches two sub-agents in parallel to gather external and local context for the current task."
context: fork
---

## Sub-agent contract
/contract

Dispatch two sub-agents in parallel using the Agent tool. Prefer `subagent_type: "research-agent"`; fall back to `subagent_type: "Explore"` with thoroughness "very thorough" if the research-agent is not available. One researches the web for external context relevant to the current task. The other inspects the local working directory for domain-relevant artifacts. Return a concise merged research brief highlighting relevant findings, conflicts, risks, and implications for the task.

**Web research agent** — always the same: search for external context, prior art, patterns, APIs, and comparable approaches relevant to the task. Domain-agnostic.

**Local inspection agent** — adapt to the domain:

| Domain | What to inspect |
|--------|----------------|
| `software` | Code, config files, package manifests, CI configs, test suites, git history, README/docs, existing patterns and conventions |
| `research` | Papers (PDF/LaTeX), notes, data files, citation databases (.bib), lab notebooks, analysis scripts, prior drafts |
| `design` | Design files (Figma exports, SVGs, mockups), brand guidelines, component libraries, user research docs, style guides |
| `business` | Financial models, strategy docs, market research, pitch decks, competitive analyses, KPI dashboards, stakeholder maps |
| *(other)* | Scan the working directory for any files relevant to the stated domain — documents, data, config, scripts — and describe what you find |

When domain is unspecified, infer it: git repo → software; PDFs/LaTeX/.bib → research; design assets → design; spreadsheets/decks → business. If ambiguous, inspect broadly and note what you found.

## Coverage reporting

Both agents must end their response with a coverage assessment:

- **Coverage confidence**: low / medium / high — how thoroughly could this domain be searched?
- **Known gaps**: what couldn't be accessed? (proprietary databases, paywalled papers, unpublished work, practitioner-only knowledge)
- **Tacit knowledge risk**: low / medium / high — is this a domain where critical knowledge is unwritten or not documented online?

When merging results, surface coverage gaps prominently. If both agents report low coverage, flag: "Low epistemic coverage — findings may be incomplete. Consider consulting domain practitioners or providing access to private sources."
