---
title: Security and secrets
summary: Never expose secrets or weaken security controls
group: core
scopes: [global, project]
defaults: [global, project]
---

## Security and secrets

- Never print, expose, or commit secrets, tokens, private keys, `.env` values, or credentials.
- If secrets appear in command output, stop and warn instead of repeating them.
- Do not weaken authentication, authorization, validation, rate limits, or encryption unless explicitly requested.
