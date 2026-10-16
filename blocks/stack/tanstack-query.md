---
title: TanStack Query
summary: Server-state ownership, as-const query key factories and per-resource hooks modules
group: stack
scopes: [project]
defaults: []
skills: [tanstack-query-expert]
---

## TanStack Query

- Keep server state exclusively in the TanStack Query cache (`@tanstack/react-query` v5); never mirror or copy server query data into Zustand, React Context, or local `useState` hooks.
- Define query-key factories returning `as const` tuples (along with `queryOptions(...)` helpers) rather than scattering ad-hoc key arrays across components.
- Group queries and mutations into one hooks module per resource (`use-<resource>.ts`), invalidating affected query keys in mutation `onSuccess` or `onSettled` callbacks.
