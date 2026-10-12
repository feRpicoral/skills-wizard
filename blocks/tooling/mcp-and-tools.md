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
- For Reddit URLs specifically, use the Reddit MCP directly rather than generic fetch.
- If the built-in WebFetch fails on a domain, try the fetcher MCP (Playwright-based) once as a fallback, then give up.
