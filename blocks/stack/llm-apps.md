---
title: LLM Integration
summary: Named model constants, z.toJSONSchema structured output, prompt caching and retries
group: stack
scopes: [project]
defaults: []
---

## LLM Integration

- Use `@anthropic-ai/sdk` or the official provider SDK directly, and define model identifiers as named constants in a centralized config module rather than scattering hardcoded model strings across call sites.
- Enforce structured outputs either via a forced single tool whose `input_schema` is generated from a `zod` schema (`z.toJSONSchema`) or via native structured output, and always validate the response with `schema.parse` before persisting or acting on it.
- Enable prompt caching on stable system prompt and tool definition prefixes, and treat all model outputs and retrieved context as untrusted input.
- Configure explicit request timeouts, bounded retries with exponential backoff for transient rate-limit or 5xx errors, and `AbortSignal` cancellation for user-facing calls.
