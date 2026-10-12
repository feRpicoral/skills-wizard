---
title: Testing
summary: When to add tests and how to structure them
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Testing

- Tests for non-trivial logic and public API surfaces. Skip tests for trivial wrappers and type-only code.
- Add or update tests when behavior changes. Prefer focused tests near the changed code.
- Do not snapshot large outputs unless the project already uses that pattern.
- Never delete or weaken tests to make a change pass.
- Structure tests as arrange/act/assert. Separate the three phases with a single empty line. Do not label them with comments (no `// arrange`, `// act`, `// assert`).
