---
name: parallelize
description: "When finished creating the plan in plan mode, run /parallelize so Claude dispatches one planning agent to transform the current approach into a plan to orchestrate waves of parallel sub-agents."
context: load
---

## Sub-agent contract
/contract

Dispatch a planning sub-agent to transform the current plan into a dependency-aware orchestration plan for waves of parallel sub-agents. Preserve the original goal, infer the necessary decomposition, identify sequential vs parallelizable work, embed TDD into implementation lanes, and avoid unsafe or redundant parallelization. Return an orchestration-ready revised plan. Ensure plan specifies to run tests.
