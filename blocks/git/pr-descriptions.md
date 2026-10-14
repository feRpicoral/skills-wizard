---
title: Pull request descriptions
summary: Concise PR descriptions without checklists
group: git
scopes: [global, project]
defaults: [global, project]
requires: [core/no-ai-tells]
---

## Pull request descriptions

- Concise. Default to a short summary; let the diff carry the rest. Only expand into longer prose when the change is genuinely complex and a reviewer cannot pick it up cold without it.
- No test plan, todo, checklist, or checkbox sections. If verification context matters, state what was run in one line.
- No AI tells (see "No AI tells" above). Don't over-section; don't add decorative headers; don't write "summary of summary" closers; don't lean on em-dashes as the default joiner.
