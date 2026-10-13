---
title: NestJS
summary: Domain modules, controller/service/repository layering, nestjs-zod DTOs and Jest
group: stack
scopes: [project]
defaults: []
---

## NestJS

- Organize backend features as one module per domain (`<domain>.module.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `<domain>.repository.ts`, `<domain>.dto.ts`) with strict `controller -> service -> repository` layering: controllers handle HTTP only, services own business logic, and `PrismaService` is injected only inside repositories.
- Define request and response DTOs from `zod` schemas using `nestjs-zod` (`createZodDto`, `ZodValidationPipe`, and `@ZodResponse`), never `class-validator` or `class-transformer` decorators.
- Validate environment configuration at startup through a `zod`-backed config service that fails fast at boot and lists all validation issues.
- Run unit tests with Jest and `@swc/jest` in co-located `*.spec.ts` files, and use Testcontainers for database integration tests. Use the `nestjs-module` skill when scaffolding or refactoring a module.
