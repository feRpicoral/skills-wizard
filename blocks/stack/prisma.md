---
title: Prisma ORM
summary: Prisma 7 with adapter-pg, prisma.config.ts, uuid(7) primary keys and snake_case mapping
group: stack
scopes: [project]
defaults: []
---

## Prisma ORM

- Use Prisma 7 with `prisma.config.ts` for CLI configuration and `@prisma/adapter-pg` (`PrismaPg`) for runtime database connections; never hand-edit generated Prisma client output.
- In `prisma/schema.prisma`, use `@id @default(uuid(7)) @db.Uuid` primary keys and map camelCase TypeScript fields and PascalCase models to `snake_case` database columns and tables with `@map` and `@@map`.
- Baseline existing or managed databases with an initial `0_init` migration (`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` and `prisma migrate resolve --applied 0_init`), review generated SQL migrations before applying, and never edit committed migrations in place.
- Wrap multi-step writes in `prisma.$transaction(...)` and isolate `prisma.*` calls inside repository or data-access modules.
