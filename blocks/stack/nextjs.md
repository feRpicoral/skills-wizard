---
title: Next.js App Router
summary: React Server Components, server-only secrets and Zod boundary validation
group: stack
scopes: [project]
defaults: []
---

## Next.js App Router

- Default to the App Router (`app/` or `src/app/`) and React Server Components; add `'use client'` only at leaf interactive components that require browser APIs, state hooks, or event listeners.
- Keep secrets, database clients, and privileged API keys strictly on the server (using `server-only` where appropriate), and never expose non-`NEXT_PUBLIC_*` environment variables to client bundles.
- Validate route `params`, `searchParams`, Server Action inputs, and Route Handler request payloads with `zod` schemas before executing domain logic.
- Prefer Server Components for initial data reads and use either Server Actions or typed API routes with TanStack Query for client mutations and refetches according to the repository's data layer.
