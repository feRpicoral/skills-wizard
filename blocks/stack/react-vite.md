---
title: React and Vite
summary: Declarative React state derivation, minimal useEffect and centralized Vite env
group: stack
scopes: [project]
defaults: []
---

## React and Vite

- Keep React components focused and declarative; compute derived values during render instead of synchronizing state with `useEffect`.
- Reserve `useEffect` for synchronizing with external systems (browser subscriptions, timers, or non-React widgets), never for data fetching or state cascades.
- Co-locate feature components, hooks, and tests, and read `import.meta.env.VITE_*` variables only in a centralized environment module rather than across UI components.
