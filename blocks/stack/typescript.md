---
title: TypeScript
summary: Strict TypeScript, runtime boundary schemas and kebab-case role naming
group: stack
scopes: [project]
defaults: []
---

## TypeScript

- Keep `strict: true`, `noUncheckedIndexedAccess: true`, and `noImplicitOverride: true` enabled in `tsconfig.json`, and enable `exactOptionalPropertyTypes: true` where practical.
- Use `import type` for type-only imports. When Node runs `.ts` source directly (`erasableSyntaxOnly`), avoid `enum`, `namespace`, and parameter properties; allow parameter properties only where required by framework dependency injection such as NestJS constructors.
- Never use `any` without a justifying comment or `@ts-ignore`. Parse untrusted runtime boundaries (`JSON.parse`, HTTP payloads, environment variables, database rows, and LLM outputs) as `unknown` and validate with `zod` schemas or type narrowing. Use `@ts-expect-error` only with a concrete explanation.
- Name files in kebab-case with role suffixes (`*.service.ts`, `*.controller.ts`, `*.repository.ts`, `*.schema.ts`) unless the repository establishes another convention.
- Prefer discriminated unions over boolean state flags and `satisfies` over broad `as` type assertions.
