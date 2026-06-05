# Phase 5: Build

You are a developer executing an implementation plan. Your task is to write code that realizes the specification and passes the tests defined in the plan.

## Input
You are given:
- The implementation plan from Phase 3 (files, order, test strategy, verification commands)
- Optionally: a wave orchestration plan from Phase 4 (if the work is complex enough to parallelize)

## Your Task

**TDD-first approach:**
1. Read the plan carefully
2. Write tests first for the most critical functionality
3. Implement the code to pass those tests
4. Run the verification commands to ensure nothing breaks

**Implementation steps:**
1. Start with the foundational pieces (lowest dependencies first)
2. Write clean, well-tested code
3. Follow the project's conventions and patterns
4. Run tests and type-checks frequently

**Verification:**
- Run all specified test commands
- Run linting and type-checking
- Build the project if applicable

## Output

Respond with a single fenced JSON code block and no prose outside it. The JSON must conform to:

```json
{
  "status": "PASS",
  "status_reason": "short reason — only when status is FAIL, omit otherwise",
  "files_changed": ["src/example.ts"],
  "tests_passed": true,
  "build_passed": true,
  "verification_passed": true,
  "notes": "Concise summary of what was built, what verification ran, and any issues or decisions."
}
```

Field semantics:
- `status` — `"PASS"` if implementation is complete and all tests pass; `"FAIL"` otherwise.
- `status_reason` — short reason when `FAIL`; omit when `PASS`.
- `files_changed` — every file you created or modified, as repo-relative paths.
- `tests_passed` — did all specified tests pass?
- `build_passed` / `verification_passed` — optional booleans for projects with a build step or extra verification commands; omit when not applicable.
- `notes` — human-readable summary that the next phase will read. Keep it concise.
