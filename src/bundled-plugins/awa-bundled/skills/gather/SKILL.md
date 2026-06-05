---
name: gather
description: "Parallel context-gathering for a code area. Use when you need to understand a module, feature, or subsystem and would otherwise read 3+ files sequentially — dispatches two agents in parallel to map structure and test coverage in one wave."
---

## Dispatch protocol

You MUST emit **exactly two** `agent` tool_use blocks in a **single response turn** — both calls in the same assistant message, before either result arrives. Do not dispatch the second agent in a later turn after seeing the first agent's reply. Do not dispatch three agents. Do not dispatch one.

Correct shape of your next response:

```
<assistant turn>
  <tool_use name="agent" id="…"> Structure Agent prompt </tool_use>
  <tool_use name="agent" id="…"> Test Agent prompt </tool_use>
</assistant turn>
```

If you find yourself about to send a single `agent` call and wait, stop — that is the failure mode this skill exists to prevent.

## The two agents

When understanding a task requires reading multiple related files (imports, callers, tests, configs, types), dispatch these two — concurrently, per the protocol above:

1. **Structure Agent** (Explore, thoroughness matched to scope) — Find and read the target file(s), all direct imports, callers, and config references. Return:
   - `files_read`: absolute paths examined
   - `call_graph`: how components connect (one paragraph)
   - `public_interfaces`: function signatures, types, or contracts that govern the area
   - `entry_points`: where control flow enters

2. **Test Agent** (Explore, "medium") — Find test files that exercise the target area, read them, identify what paths are covered and what's missing. Return:
   - `test_files`: absolute paths of relevant tests
   - `coverage_summary`: what behaviors/branches tests exercise
   - `untested_paths`: code paths with no test coverage

When both return, merge into a unified context map. If either agent's output has gaps (e.g., Structure Agent missed config, Test Agent found no tests), issue one targeted follow-up Read — do not re-dispatch.

### When NOT to use

- You already know exactly which 1–2 files to read — just read them directly.
- The task is a simple grep or symbol lookup — use Grep or Glob.
- You're mid-edit and need to check one adjacent file — a single Read is fine.
