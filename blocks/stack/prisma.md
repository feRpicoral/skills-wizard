---
title: Prisma ORM
summary: Prisma 7 with adapter-pg, prisma.config.ts, uuid(7) primary keys and snake_case mapping
group: stack
scopes: [project]
defaults: []
skills: [prisma-cli, prisma-client-api, prisma-orm-setup, prisma-upgrade-v7]
---

## Prisma ORM

- Use Prisma 7 with `prisma@^7`, `@prisma/client@^7`, and `@prisma/adapter-pg@^7` (`PrismaPg`) pinned on the same major version, and configure the CLI in `prisma.config.ts`; never hand-edit generated Prisma client output.
- In `prisma/schema.prisma`, use `@id @default(uuid(7)) @db.Uuid` primary keys and map camelCase TypeScript fields and PascalCase models to `snake_case` database columns and tables with `@map` and `@@map`.
- Generate an initial `0_init` migration with `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql`: on an existing database where those tables already exist, mark it applied with `prisma migrate resolve --applied 0_init` before running `prisma migrate deploy`; on a new or empty database, run `prisma migrate deploy` directly without `migrate resolve` so the tables are created. Review generated SQL migrations before applying, and never edit committed migrations in place.
- Wrap multi-step writes in `prisma.$transaction(...)` and isolate `prisma.*` calls inside repository or data-access modules.
