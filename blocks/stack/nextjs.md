---
title: Next.js App Router
summary: Next.js 16 App Router, Server Components, typed Server Actions and proxy.ts
group: stack
scopes: [project]
defaults: []
skills: [vercel-react-best-practices, vercel-composition-patterns, web-design-guidelines]
---

## Next.js App Router

- Target Next.js 16 App Router (`app/` or `src/app/`) and consult `node_modules/next/dist/docs` when installed for version-accurate API details.
- Default to React Server Components and place `'use client'` only at interactive leaf components that require browser APIs, state hooks, or event handlers. Organize routes with route groups (`(marketing)`, `(app)`, `(auth)`) and use `proxy.ts` (rather than legacy middleware conventions) where Next.js 16 request proxying applies.
- Validate route `params`, `searchParams`, Route Handler payloads, and Server Action inputs with `zod` schemas, and have Server Actions return a typed discriminated union (`{ ok: true, data } | { ok: false, error }`).
- Keep secrets, database clients, and privileged keys strictly on the server (`server-only`), never exposing non-`NEXT_PUBLIC_*` variables to client bundles.
