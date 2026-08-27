# Shared Agent State — Research Brief

*Generated 2026-08-18 from ChatGPT transcript + parallel research wave + adversarial review*

## The Problem

AFK's agents can exchange results through parent orchestration and DAG dependencies, but do not inhabit a persistent shared working state. Knowledge remains bound to individual contexts. Findings must be copied, compressed, rediscovered, or manually routed between agents.

AFK has **message passing and directed dataflow**. It does not have **environment-mediated cognition**.

The parent session is the wormhole — and it's a bad one: lossy, token-expensive, and serial. Compose's DAG executor is smarter (upstream outputs flow directly to downstream nodes), but even compose can't do shared mutable state that multiple agents read and write concurrently.

## The North Star

> "The parent is no longer the brain. AFK itself becomes the cognitive substrate. The agents are transient processes inside it."

This is a product identity claim, not an architecture proposal. AFK earns it incrementally — by building a shared workspace that starts simple and grows toward a persistent computational environment only if usage pulls it there.

---

## External Landscape: What's Real

Every project referenced in the original conversation is **confirmed real**. Nothing was hallucinated.

### Tier 1: Directly Relevant, Operational

| Project | Status | Key Insight for AFK |
|---------|--------|---------------------|
| **[ActiveGraph](https://github.com/yoheinakajima/activegraph)** | ✅ Production (v1.10.0, Apache-2.0, ~573 ⭐, ~6.8K monthly downloads) | Closest operational embodiment of the "world as substrate" thesis. Yohei Nakajima (BabyAGI). Append-only event log → graph as deterministic projection. Fork-at-any-event + diff working. [arXiv:2605.21997](https://arxiv.org/abs/2605.21997). Small community; BabyAGI was viral demo not production system — same risk applies here. |
| **[A2A v1.0](https://a2a-protocol.org)** | ✅ Production (~25.3K ⭐, 150+ orgs, Linux Foundation) | Inter-agent interop protocol. **Orthogonal, not opposed** — A2A governs between-systems protocol; a workspace governs within-system state. Different layers. Not relevant to the shared-workspace problem unless AFK becomes multi-tenant. |
| **[MCP July 2026 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28/)** | ✅ Production (400M+ monthly SDK downloads) | Stateless core + Tasks extension (SEP-2663). Structureless by design — leaves the epistemic layer as an open problem AFK could fill. |

### Tier 2: Research Papers, High Signal

| Paper | Status | Key Insight for AFK |
|-------|--------|---------------------|
| **[MemIR](https://arxiv.org/abs/2605.25869)** (May 2026) | ✅ arXiv preprint, no public code | Coins "provenance-role collapse" — the failure mode where evidence, inference, and claims are merged without authorization. Three atom types: evidence, retrieval cues, truth-bearing claims. Supplies the epistemic type system. |
| **[MAP-Graph](https://arxiv.org/abs/2608.10509)** (Aug 11, 2026) | ✅ arXiv preprint, no public code | Trust/authorization layer for typed execution graphs. Permission filtering + trust propagation through ancestor traversal. Shows shared state needs authorization from day one. 94.96% task success / 2,700 synthetic tasks. |

### Tier 3: Supporting Context

| Concept | Reality Check |
|---------|---------------|
| **Blackboard architecture** | Classic (Erman 1976 / Hayes-Roth BB1 1985). The canonical answer to multi-expert coordination. Modern LLM revival via ChatDev, MetaGPT. Key insight: the **scheduler** (control shell) is what makes blackboards work, not just the shared state. |
| **Stigmergy in LLM agents** | Real research cluster. SodaMem, SEEM, MAGMA, ESR (2025-2026). Message-passing scales O(N²) in tokens; environment-mediated coordination scales O(N). |
| **Event-sourced agent graphs** | Active research cluster. No dominant runtime beyond ActiveGraph. |

### On "Convergence"

The original conversation and first draft of this brief called this "convergence from multiple angles." That overstates it. ActiveGraph, MemIR, MAP-Graph, and blackboard research are solving **different problems** that happen to use similar graph structures. A better claim:

> Several neighboring research areas have independently developed mechanisms that could **compose** into the architecture AFK needs.

That's a synthesis opportunity, not a convergent movement.

---

## AFK's Current Architecture

### What AFK Has Today

| System | Relevant Capability | Gap to Shared Workspace |
|--------|---------------------|-------------------------|
| **Witness Trace** (`src/agent/trace/`) | Append-only JSONL, 13 typed events, monotonic seq, Zod-validated. Has `claim` event with source/evidence/confidence/dissent. | Designed for forensics ("what happened?"), not state management ("what do we believe?"). No causal links between events, no queryable index. **Not automatically the substrate** — a forensic log and an operational state are different workloads. |
| **Compose DAG** (`src/agent/dag.ts`) | Kahn's algorithm, upstream outputs flow to downstream inputs. | Scheduling layer, not causal graph. Edges encode order-dependency, not semantic causation. No provenance on outputs. |
| **Memory** (SQLite FTS5) | 4 categories, evidence column (opt-in gate), supersede chain, confidence field (exists but always 1.0). | Flat facts, no inter-fact relationships, no temporal validity, no source-agent tracking. |
| **SubagentManager** (`src/agent/subagent.ts`) | Per-fork ID, parentId, resolvedAgentType, systemPromptHash. One-hop lineage via forkedFrom. | No persistent cross-session agent identity, no performance history, no trust. |
| **Farm** (`src/cli/commands/farm.ts`) | N parallel worktrees, scoring, winner selection, memory write-back. | No hypothesis variation, no cross-branch learning, no semantic comparison. |
| **Hooks** (`src/agent/hooks.ts`) | Lifecycle events (SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse). Block/inject-context. | Fires on lifecycle, not state changes. Not stigmergy. |
| **AbortGraph** (`src/agent/abort-graph.ts`) | Lifecycle propagation tree. Parent abort cascades down; child abort notifies up. | Purely lifecycle. Cannot carry semantic content without violating its invariants. |

### Architecture Distance

```
Closest ────────────────────────────────────── Farthest

Witness Trace > Memory > Farm > DAG > Subagent ID > Hooks > AbortGraph
```

The witness trace has the most relevant structural properties but **is not automatically the substrate**. Building a world-state database on top of a forensic log because both have timestamps is architecture-by-convenience.

---

## What "Wormholes" Actually Are

The original conversation used "wormhole" as a metaphor for nonlocal information shortcuts. The first draft of this brief dismissed it as "attention routing, a solved engineering problem." That was too fast.

Ordinary retrieval:
```
query → similar chunks → context
```

What's being described:
```
failing test → affected function → decision that created function →
claim supporting decision → evidence behind claim → later contradictory evidence
```

That's **retrieval through causal topology** — not "find text similar to this" but "find information structurally relevant to why the present state exists."

This is genuinely unsolved. RAG over static corpora is solved. Dynamic causal retrieval is not.

**Naming convention:** "Wormhole" = what it feels like. **Causal context routing** (or **provenance-aware retrieval**) = what the code does.

---

## What's Novel vs. Known

| Idea | Novel? | Prior Art |
|------|--------|-----------|
| Event log as source of truth | No | ActiveGraph, event sourcing (Greg Young 2005+) |
| Typed epistemic objects | No | MemIR, epistemology of testimony |
| Trust propagation through derivation chains | No | MAP-Graph, PKI, web-of-trust |
| Causal context routing | **Partially** — the mechanism exists in knowledge graphs; applying it to agent dispatch context is less explored | Knowledge graphs + RAG, but not topology-aware agent context construction |
| Fork-at-any-event + diff futures | No | ActiveGraph, git |
| Shared typed workspace for LLM agents | **No** — blackboard architecture (1976), ChatDev, MetaGPT | But no one has done it inside a full agent harness at AFK's level |
| Combining all of these | **Yes** — the synthesis is novel | No existing system combines workspace + harness + causal routing |

---

## Recommended Reading

Before writing any code:

1. **ActiveGraph paper** — [arXiv:2605.21997](https://arxiv.org/abs/2605.21997). Runtime section: fork-at-any-event + diff.
2. **MAP-Graph paper** — [arXiv:2608.10509](https://arxiv.org/abs/2608.10509). Trust propagation section: shared state needs authorization from day one.
3. **MemIR paper** — [arXiv:2605.25869](https://arxiv.org/abs/2605.25869). "Provenance-role collapse" section: the failure mode AFK's flat memory currently risks.

---

*This document is the evidence base. The proposal lives in `shared-agent-workspace-rfc.md`.*
