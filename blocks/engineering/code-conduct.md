---
title: Code conduct
summary: Match existing patterns, no dead code or unexplained magic values
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Code conduct

- Read before writing. Study existing patterns in the file/module before adding new code.
- Match existing patterns, naming, formatter, and linter config. Don't introduce a parallel style.
- Avoid cosmetic diffs unless the task is explicitly about formatting.
- Preserve public APIs unless the task requires changing them.
- No dead code. Don't leave unused exports, commented-out blocks, or unreachable branches.
- No unexplained magic values. Extract named constants for repeated literals, protocol values, timeouts, limits, status codes with business meaning, or values whose purpose is not obvious. Do not extract obvious one-off values just to satisfy this rule.
- Use typed, specific errors when callers branch on the error or when the domain distinction matters. Generic `Error` is acceptable for unrecoverable/invariant failures and boundary-level messages.
- Don't swallow errors silently. Preserve original error context when wrapping.
- Update nearby documentation when behavior changes.
