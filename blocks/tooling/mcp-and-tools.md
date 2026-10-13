---
title: MCP and tool usage
summary: Opt-in tool use and fallbacks on failure
group: tooling
scopes: [global, project]
defaults: [global]
---

## MCP and tool usage

- Tools are opt-in by task, not opt-out by rule. Don't fan out across every available MCP for routine questions.
- On failure: if a tool returns nothing useful after 2 attempts, proceed with available knowledge and flag the gap. Don't loop retries.
- When an MCP built for a specific site is available (for example, one for Reddit), use it for that site's URLs rather than generic fetch.
- If the built-in web fetch tool fails on a domain, try a browser-automation MCP once as a fallback if one is available, then give up.
