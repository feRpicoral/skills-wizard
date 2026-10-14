---
title: Pull request reviews
summary: Pre-PR subagent review loop and review criteria
group: git
scopes: [global, project]
defaults: [global, project]
---

## Pull request reviews

- Before opening a PR, spawn a subagent to meticulously review the full branch diff against the repository conventions (`AGENTS.md`), installed instructions and applicable skills, engineering best practices, code quality, readability, maintainability, security, performance, AI tells, and bugs.
- Address all feedback from the reviewing subagent, re-run verification checks, and repeat the review loop until the subagent marks the PR as good to go. Only then open the PR.
- When reviewing a PR directly, always review thoroughly. Prioritize code quality, readability, maintainability, bugs, security, AI tells, code and render performance, and whether the change follows the repo's agent instructions and applicable skills.
