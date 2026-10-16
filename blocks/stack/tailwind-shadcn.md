---
title: Tailwind CSS and shadcn/ui
summary: Tailwind CSS v4 @theme inline tokens, shadcn/ui Radix primitives and class sorting
group: stack
scopes: [project]
defaults: []
skills: [tailwind-patterns]
---

## Tailwind CSS and shadcn/ui

- Configure Tailwind CSS v4 directly in CSS (`@import "tailwindcss";` and `@theme inline`, with no legacy `tailwind.config.*` file) and use semantic CSS variables instead of hardcoded hex colors or arbitrary pixel values when a theme token exists.
- Build UI primitives with `shadcn/ui` on Radix primitives (`components/ui/`), merging class names with `cn()` (`clsx` and `tailwind-merge`) and defining variants with `class-variance-authority` (`cva`).
- Keep `components/ui/` primitives free of domain business logic, and format class lists automatically with `prettier-plugin-tailwindcss`.
