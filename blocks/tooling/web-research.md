---
title: Web research
summary: When to search and how to fetch docs
group: tooling
scopes: [global, project]
defaults: [global]
---

## Web research

- Use web search only when the question involves current state, specific recent versions, third-party services, or my confidence is low.
- For current-state questions, prefer results from the last 3 months.
- For stable technical topics, prefer canonical sources even if older: official docs, specs, RFCs, source code, changelogs, and maintainer discussions.
- Fetching a page to read its content (outside GitHub): try its Markdown variant first instead of judging whether the site supports one. Build the `.md` URL from the page URL by dropping any trailing slash, query, and fragment, then appending `.md` — e.g. `https://docs.mapbox.com/api/navigation/map-matching/` becomes `https://docs.mapbox.com/api/navigation/map-matching.md`. Pass that straight to WebFetch; do not fetch the HTML first to check. Fall back to the original URL only if the `.md` returns 404 or HTML. This applies to direct fetches and to links returned by WebSearch.
- Also try `llms.txt` (and `llms-full.txt`) at the docs site root for a machine-readable index. When a `.md` or `llms.txt` source exists, treat it as the source of truth over the rendered page.
- If search results are stale, conflicting, or irrelevant, say so directly.
