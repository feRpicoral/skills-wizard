# Supabase Pooling, Keys, and Baseline Migration Reference

## Connection Pooler Architecture

Supabase provides two Supavisor connection modes that map to distinct environment variables:

| Variable                           | Port   | Query parameter   | Consumer                                                     | Why                                                                                       |
| ---------------------------------- | ------ | ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `DATABASE_TRANSACTION_POOLING_URL` | `6543` | `?pgbouncer=true` | Runtime `PrismaClient` via `PrismaPg` (`@prisma/adapter-pg`) | Scales across serverless and container instances by releasing connections per transaction |
| `DATABASE_SESSION_POOLING_URL`     | `5432` | none              | `prisma.config.ts` (`datasource.url`) and `prisma migrate`   | Supports advisory locks and session-scoped statements required by Prisma Migrate          |

## Canonical `prisma/schema.prisma`

In Prisma 7, connection URLs live in `prisma.config.ts` rather than inside `datasource db` in `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model Organization {
  id        String   @id @default(uuid(7))
  name      String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("organizations")
}
```

## Baseline Migration Procedure (`0_init`)

Why baselining is required on Supabase:

- Every Supabase database includes pre-populated schemas (`auth`, `storage`, `realtime`, `supabase_migrations`, `extensions`).
- Running `prisma migrate dev` on a fresh Prisma setup detects drift against those managed schemas and offers to reset the database, which would fail or destroy Supabase internals.

Instead, generate the initial SQL script with `prisma migrate diff` and register it as applied:

```bash
#!/usr/bin/env bash
set -euo pipefail

mkdir -p prisma/migrations/0_init

yarn prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script \
  > prisma/migrations/0_init/migration.sql

yarn prisma migrate resolve --applied 0_init
yarn prisma migrate deploy
```

When the tables in `prisma/schema.prisma` do not exist in the target Supabase database yet, run `yarn prisma migrate deploy` (which executes `0_init/migration.sql`) or apply the SQL before running `yarn prisma migrate resolve --applied 0_init`. When the tables already exist in Supabase, run `yarn prisma migrate resolve --applied 0_init` first and then `yarn prisma migrate deploy`.

## Supabase API Key Naming

Supabase replaced legacy JWT `anon` and `service_role` keys with publishable (`sb_publishable_...`) and secret (`sb_secret_...`) keys:

- **Next.js / browser + server apps**:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_SECRET_KEY` (server-only)
- **Backend / API services**:
  - `SUPABASE_URL`
  - `SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_SECRET_KEY`

Remove any references to `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` from `.env.example`, config schemas, and client initialization modules.

## Free-Tier Keep-Alive (`feRpicoral/supabase-heartbeat`)

Free-tier Supabase projects pause after 7 days of inactivity. Whenever setting up a new Supabase project or adding Supabase configuration to a repository, explicitly remind the user to add the project to `feRpicoral/supabase-heartbeat`.
