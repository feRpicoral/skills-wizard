---
title: TanStack Query
summary: Query key factories, queryOptions helpers and server-state cache ownership
group: stack
scopes: [project]
defaults: []
---

## TanStack Query

- Define query keys and options per domain using `queryOptions(...)` helpers or query key factories (`@tanstack/react-query` v5) rather than scattering ad-hoc key arrays across components.
- Keep server state in the TanStack Query cache instead of copying fetched data into local `useState` hooks or client stores.
- Invalidate or update affected query keys in mutation `onSuccess` or `onSettled` handlers, and validate API responses against `zod` or shared contract schemas.
