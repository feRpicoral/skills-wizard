---
title: NestJS
summary: Domain modules, controller/service/repository layering and nestjs-zod DTOs
group: stack
scopes: [project]
defaults: []
---

## NestJS

- Organize backend features by domain module (`<domain>.module.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `<domain>.repository.ts`, `<domain>.dto.ts`, and `<domain>.service.spec.ts`).
- Keep layer boundaries strict: controllers handle HTTP routing, status codes, guards, and DTO bindings only; services own business logic and domain exceptions; repositories encapsulate all `PrismaService` queries and persistence.
- Define request and response DTOs from `zod` schemas with `nestjs-zod` (`createZodDto`, `ZodValidationPipe`, `@ZodResponse`) instead of `class-validator` and `class-transformer` decorators unless the repository already requires them.
- Use the `nestjs-module` skill when scaffolding, extending, or refactoring a NestJS domain module.
