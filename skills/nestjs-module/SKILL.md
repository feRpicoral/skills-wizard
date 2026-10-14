---
name: nestjs-module
description: Scaffolds, extends, and refactors NestJS domain modules with strict controller -> service -> repository layering, Prisma isolated inside repositories, zod DTOs via createZodDto and @ZodResponse from nestjs-zod, and co-located *.spec.ts tests. Use when creating a new NestJS feature or resource module, adding endpoints or domain operations to an existing NestJS module, extracting direct PrismaService queries out of controllers or services into a repository, or replacing class-validator and class-transformer DTOs with nestjs-zod schemas. Don't use for Next.js Route Handlers or Server Actions, Express/Fastify apps without NestJS, or standalone Prisma migration setup (use supabase-prisma).
compatibility: Requires Node.js, NestJS (@nestjs/common, @nestjs/core), Prisma 7, zod ^4.0.0, and nestjs-zod ^5.0.0
---

# NestJS Domain Module

Build and maintain NestJS domain modules following the house `controller -> service -> repository` architecture with `nestjs-zod` DTOs and co-located `*.spec.ts` unit tests.

## Start here

1. **Inspect the existing workspace before writing files**:
   - Locate where domain modules live (`src/modules/<domain>/`, `src/<domain>/`, or `apps/api/src/modules/<domain>/` in an Nx monorepo), how `PrismaModule` / `PrismaService` is imported, and which relative import-specifier convention the project uses (match existing modules and `tsconfig.json`: extensionless `./invoices.service` in standard NestJS builds, or `.ts` when `allowImportingTsExtensions` is enabled).
   - Check `package.json` for `nestjs-zod` (`^5.0.0`), `zod` (`^4.0.0`, required for `z.iso.datetime()`), `@nestjs/common`, and the test runner (`jest` with `@swc/jest` or `vitest`).
   - Check `src/app.module.ts` (and `src/main.ts`) to ensure `ZodValidationPipe` (`APP_PIPE`) and `ZodSerializerInterceptor` (`APP_INTERCEPTOR`) from `nestjs-zod` are registered; without them, `createZodDto` and `@ZodResponse` are inert metadata.
   - Check whether zod schemas live inside `<domain>.dto.ts` or in a shared `<domain>.schema.ts` / workspace library.

2. **Enforce strict three-tier layering**:
   - **Controller (`<domain>.controller.ts`)**: HTTP transport only (route decorators, `@Param`, `@Query`, `@Body`, `@HttpCode`, `@ZodResponse`). Controllers inject `<Domain>Service` only, never `<Domain>Repository` or `PrismaService`.
   - **Service (`<domain>.service.ts`)**: domain rules, invariant checks, orchestration, and domain/HTTP exceptions (`NotFoundException`, `ConflictException`, `BadRequestException`). Services inject `<Domain>Repository` (and sibling services when needed), never `PrismaService`.
   - **Repository (`<domain>.repository.ts`)**: persistence boundary. Only repositories inject `PrismaService` and call `this.prisma.<model>.*` or `this.prisma.$transaction(...)`.
   - **DTOs (`<domain>.dto.ts`)**: define request and response contracts with `zod` (`z.object` / `z.strictObject`) and wrap them with `createZodDto(schema)` from `nestjs-zod`. Decorate controller methods with `@ZodResponse({ type: <ResponseDto>, status: ... })` (or `@ZodSerializerDto`). Never use `class-validator` or `class-transformer`.

## Workflow

### 1. Define schemas and DTOs (`<domain>.dto.ts`)

Write `zod` schemas first and export both the schemas and the `createZodDto` classes:

```ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
});

export const invoiceResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  amountCents: z.number().int(),
  currency: z.string().length(3),
  createdAt: z.iso.datetime(),
});

export class CreateInvoiceDto extends createZodDto(createInvoiceSchema) {}
export class InvoiceResponseDto extends createZodDto(invoiceResponseSchema) {}
```

### 2. Implement the repository (`<domain>.repository.ts`)

Inject `PrismaService` only here. Follow the house function-parameter convention: when a method takes two or more parameters of the same type or more than 3 parameters in total, accept a single destructured object typed by a named `interface` above the method or class:

```ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.ts';
import type { CreateInvoiceDto } from './invoices.dto.ts';

@Injectable()
export class InvoicesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.invoice.findUnique({ where: { id } });
  }

  create(data: CreateInvoiceDto) {
    return this.prisma.invoice.create({ data });
  }
}
```

### 3. Implement the service (`<domain>.service.ts`), controller (`<domain>.controller.ts`), and module wiring

- In `<domain>.service.ts`, inject `<Domain>Repository`, enforce domain invariants, throw NestJS exceptions when entities are missing or conflict, and map Prisma `Date` fields (`createdAt: record.createdAt.toISOString()`) to ISO strings when the response DTO uses `z.iso.datetime()` so `ZodSerializerInterceptor` validates cleanly at runtime.
- In `<domain>.controller.ts`, inject `<Domain>Service`, annotate endpoints with `@ZodResponse`, and delegate directly to the service.
- Wire `<Domain>Controller`, `<Domain>Service`, and `<Domain>Repository` in `<domain>.module.ts` (importing `PrismaModule` if it is not `@Global()`, and exporting `<Domain>Service` when other modules consume it).
- Register `<Domain>Module` in `src/app.module.ts`, and ensure `ZodValidationPipe` (`APP_PIPE`) and `ZodSerializerInterceptor` (`APP_INTERCEPTOR`) are registered in `AppModule` if not already present.

### 4. Add co-located unit tests (`<domain>.service.spec.ts`)

Place unit tests next to the source files (`<domain>.service.spec.ts`, and `<domain>.controller.spec.ts` when controller wiring is non-trivial):

- Mock `<Domain>Repository` in `<domain>.service.spec.ts` using typed `jest.fn<Repository['method']>()` mocks (never mock `PrismaService` in a service test).
- Structure every test as **arrange / act / assert** separated by a single blank line (two blank lines total per test), with **no** `// arrange`, `// act`, or `// assert` comments.

See [references/module-templates.md](references/module-templates.md) for complete templates of all six files.

## References

- Read [references/module-templates.md](references/module-templates.md) for full copy-ready templates (`<domain>.dto.ts`, `<domain>.repository.ts`, `<domain>.service.ts`, `<domain>.controller.ts`, `<domain>.module.ts`, and `<domain>.service.spec.ts`) and refactoring patterns.

## Non-negotiables

- Never inject `PrismaService` into a controller or service; all Prisma calls live in `<domain>.repository.ts`.
- Never inject `<Domain>Repository` directly into a controller.
- Never use `class-validator` (`@IsString`, `@IsInt`, etc.) or `class-transformer` (`@Type`, `@Expose`); always use `zod` with `createZodDto` and `@ZodResponse` from `nestjs-zod`.
- Use a named `interface` and parameter destructuring whenever a function or method takes 2+ parameters of the same type or >3 parameters total.
- Keep unit tests in co-located `*.spec.ts` files using 3-phase arrange/act/assert separated by single blank lines and zero phase comments.
