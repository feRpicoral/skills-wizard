---
title: React and Vite
summary: React 19 with Vite, typed router entry structure, Zod env validation and Vitest
group: stack
scopes: [project]
defaults: []
skills: [vercel-react-best-practices, web-design-guidelines]
---

## React and Vite

- Target React 19 with Vite, keeping a clean entry and typed router structure (`src/main.tsx`, `src/app.tsx`, and feature routes).
- Keep components declarative and compute derived values during render instead of syncing state with `useEffect`; reserve `useEffect` for external browser or DOM subscriptions.
- Read `import.meta.env.VITE_*` variables only in a single environment module and validate them at startup with a `zod` schema.
- Write component and hook tests with Vitest and React Testing Library (`@testing-library/react`) co-located alongside feature modules.
