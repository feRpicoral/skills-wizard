---
name: supabase-prisma
description: Configures Supabase Postgres projects with Prisma ORM, dual connection pooler URLs (DATABASE_TRANSACTION_POOLING_URL on port 6543 and DATABASE_SESSION_POOLING_URL on port 5432), publishable and secret Supabase API keys, and initial 0_init baseline migrations. Use when connecting Prisma to Supabase, setting up prisma.config.ts and @prisma/adapter-pg with Supavisor pooling, fixing prisma migrate dev drift or reset errors against a Supabase database, migrating from legacy anon or service_role keys to publishable and secret keys, or onboarding a new Supabase project that needs feRpicoral/supabase-heartbeat. Don't use for writing NestJS controllers or services (use nestjs-module) or generic non-Supabase SQL queries.
license: MIT
compatibility: Requires Node.js, Prisma CLI, and a Supabase Postgres project
---

# Supabase with Prisma

Configure Prisma 7 and Supabase with separate transaction and session pooler URLs, current Supabase API key names, and non-destructive `0_init` baseline migrations.

## Start here

1. **Inspect existing database and environment files**:
   - Check `prisma/schema.prisma`, `prisma.config.ts`, `prisma/migrations/`, `.env.example`, `package.json`, and the runtime Prisma client module (such as `src/db.ts` or `src/prisma.service.ts`).
   - Identify whether the task sets up a new Supabase + Prisma integration, creates or repairs the initial baseline migration, or fixes legacy environment variable names and pooler ports.
2. **Enforce the four core invariants**:
   - **Runtime queries** use `DATABASE_TRANSACTION_POOLING_URL` (Supavisor transaction mode on port `6543`, with `?pgbouncer=true`) passed to `PrismaPg` from `@prisma/adapter-pg`.
   - **Prisma CLI and `prisma.config.ts`** use `DATABASE_SESSION_POOLING_URL` (Supavisor session mode on port `5432`) because DDL migrations and schema introspection require session-level features.
   - **Supabase API keys** use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_PUBLISHABLE_KEY` on backend-only services, `sb_publishable_...`) and `SUPABASE_SECRET_KEY` (`sb_secret_...`), never legacy `anon` (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY`) or `service_role` (`SUPABASE_SERVICE_ROLE_KEY`).
   - **Free-tier keep-alive**: whenever an implementation creates or onboards a new Supabase project, remind the user to register the project in `feRpicoral/supabase-heartbeat` so the database does not pause after inactivity.

## Workflow

### 1. Configure environment variables (`.env.example` and config validation)

Define both pooler URLs and the publishable/secret keys in `.env.example` and in the application's `zod` environment schema:

```dotenv
DATABASE_TRANSACTION_POOLING_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true"
DATABASE_SESSION_POOLING_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
NEXT_PUBLIC_SUPABASE_URL="https://<project-ref>.supabase.co"
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
SUPABASE_SECRET_KEY="sb_secret_..."
```

For backend-only services (no Next.js frontend), use `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` alongside `SUPABASE_SECRET_KEY`.

### 2. Wire `prisma.config.ts` and the runtime `@prisma/adapter-pg` client

- **`prisma.config.ts`**: point `datasource.url` to `DATABASE_SESSION_POOLING_URL` (port `5432`):

  ```ts
  import 'dotenv/config';
  import { defineConfig, env } from 'prisma/config';

  export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
      path: 'prisma/migrations',
    },
    datasource: {
      url: env('DATABASE_SESSION_POOLING_URL'),
    },
  });
  ```

- **Runtime client (`src/db.ts` or `src/prisma.service.ts`)**: instantiate `PrismaPg` with `DATABASE_TRANSACTION_POOLING_URL` (port `6543`):

  ```ts
  import { PrismaPg } from '@prisma/adapter-pg';
  import { PrismaClient } from './generated/prisma/client.ts';

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_TRANSACTION_POOLING_URL,
  });

  export const prisma = new PrismaClient({ adapter });
  ```

### 3. Baseline the initial migration (`0_init`)

Supabase databases contain managed schemas (`auth`, `storage`, `realtime`, `extensions`), so `prisma migrate reset` is destructive and forbidden, and `prisma migrate dev` fails on schema drift if no baseline exists.

Create and mark the `0_init` baseline migration:

```bash
mkdir -p prisma/migrations/0_init
yarn prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script \
  > prisma/migrations/0_init/migration.sql
yarn prisma migrate resolve --applied 0_init
yarn prisma migrate deploy
```

See [references/pooling-and-baseline.md](references/pooling-and-baseline.md) for subsequent migration workflows, `schema.prisma` conventions, and troubleshooting drift errors.

## References

- Read [references/pooling-and-baseline.md](references/pooling-and-baseline.md) for complete `prisma.config.ts`, `schema.prisma`, runtime adapter examples, baseline scripts, and the `feRpicoral/supabase-heartbeat` reminder checklist.

## Non-negotiables

- Never run `prisma migrate reset` or `prisma db push --force-reset` against a Supabase database.
- Never use `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY`; always use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`.
- Never point runtime `PrismaPg` at port `5432` or point `prisma.config.ts` migrations at port `6543`: runtime uses `DATABASE_TRANSACTION_POOLING_URL` (`:6543`) and migrations use `DATABASE_SESSION_POOLING_URL` (`:5432`).
- Always remind the user to add new Supabase projects to `feRpicoral/supabase-heartbeat`.
