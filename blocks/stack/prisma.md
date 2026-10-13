---
title: Prisma ORM
summary: Schema conventions, reviewed migrations, transactions and repository isolation
group: stack
scopes: [project]
defaults: []
---

## Prisma ORM

- Keep `prisma/schema.prisma` as the single source of truth for database models, using `@map` and `@@map` when camelCase TypeScript fields map to `snake_case` database columns and tables.
- Generate and review SQL migration files before applying them, and never modify a migration file that has already been committed.
- Wrap multi-step database writes in `prisma.$transaction(...)`, select only the fields and relations required by the caller to prevent N+1 queries, and isolate `prisma.*` calls inside repository or data-access modules.
