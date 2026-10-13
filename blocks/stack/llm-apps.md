---
title: LLM Integration
summary: Centralized model configuration, structured output validation and bounded retries
group: stack
scopes: [project]
defaults: []
---

## LLM Integration

- Centralize model identifiers, provider clients, token limits, and prompt templates in dedicated modules rather than scattering hardcoded model strings across call sites.
- Validate structured model outputs and tool-call arguments with `zod` schemas (or Pydantic in Python), and treat all model responses and retrieved context as untrusted input.
- Configure explicit request timeouts, bounded retries with exponential backoff for transient rate-limit or 5xx errors, and `AbortSignal` cancellation or streaming for user-facing requests.
