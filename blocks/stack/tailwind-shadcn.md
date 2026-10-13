---
title: Tailwind CSS and shadcn/ui
summary: Tailwind CSS v4 theme tokens, cn/cva composition and shadcn/ui primitives
group: stack
scopes: [project]
defaults: []
---

## Tailwind CSS and shadcn/ui

- Use Tailwind CSS v4 (`@import "tailwindcss";` and `@theme` tokens) and semantic CSS variables instead of hardcoded hex colors or arbitrary pixel values when a theme token exists.
- Merge conditional class names with `cn()` (`clsx` and `tailwind-merge`) and define reusable visual variants with `class-variance-authority` (`cva`).
- Keep `components/ui/` primitives accessible and free of feature business logic; build domain UI by composing `components/ui/` primitives.
