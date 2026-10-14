---
title: Environment variables
summary: Fail-fast env validation and every boot path that needs it
group: engineering
scopes: [global, project]
defaults: [global, project]
---

## Environment variables

- Access and validate environment variables through a dedicated service that fails fast at boot. Avoid scattered direct `process.env` reads.
- When adding an environment variable, update `.env.example` and every boot path that would fail without it, including CI, test setup, e2e setup and deploy configuration.
