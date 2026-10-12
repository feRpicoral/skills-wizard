---
name: markdown-link-checker
description: Audits local and relative Markdown links in documentation trees, detects broken anchors or missing target files, and rewrites moved paths. Use when the user asks to check broken links in docs/, verify heading anchors in README.md or docs/*.md, or update relative links after moving files. Don't use for external HTTP uptime monitoring or HTML scraping.
---

# Markdown Link Checker

## Workflow

1. Scan Markdown files for `[label](target)` links.
2. Verify relative file targets and `#heading-slug` anchors exist.
3. Report broken links with file path, line number, and suggested fix.
