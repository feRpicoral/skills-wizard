---
title: Comments
summary: Default to no comments and when one is allowed
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Comments

Default to no comment.

A comment is allowed only when it explains something the code cannot reasonably express:
- why a surprising decision exists
- a business invariant
- an edge case from an external API/runtime/library
- a security, concurrency, data-loss, or recovery constraint
- a source/citation for behavior that is not inferable from the code

Do not add or keep comments that:
- restate the next line, branch, function name, type, or test assertion
- narrate steps in order, e.g. "1. fetch", "2. validate", "3. save"
- describe common framework behavior
- explain obvious constants, defaults, or parameters
- say something only useful because names are weak; rename instead
- justify dead or future code; delete it until needed
- add JSDoc to non-public functions/types unless it documents a real contract

For tests, prefer descriptive test names and assertions over comments. Keep a test comment only when it explains a regression, historical bug, invariant, or setup that would otherwise look wrong.

Before finishing a change, audit every comment you added or touched. For each one, ask:
"Would a senior reviewer lose important context or safety information if this comment were deleted?"
If no, delete it.

For cleanup tasks, run a final search for the thing being cleaned up and inspect the remaining matches. Summarize why remaining instances were kept.
