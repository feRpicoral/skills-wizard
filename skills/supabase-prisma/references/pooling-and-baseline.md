# Supabase Pooling, Keys, and Baseline Migration Reference

## Connection Pooler Architecture

Supabase provides two Supavisor connection modes that map to distinct environment variables:

| Variable                           | Port   | Query parameter   | Consumer                                                     | Why                                                                                       |
| ---------------------------------- | ------ | ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `DATABASE_TRANSACTION_POOLING_URL` | `6543` | `?pgbouncer=true` | Runtime `PrismaClient` via `PrismaPg` (`@prisma/adapter-pg`) | Scales across serverless and container instances by releasing connections per transaction |
| `DATABASE_SESSION_POOLING_URL`     | `5432` | none              | `prisma.config.ts` (`datasource.url`) and `prisma migrate`   | Supports advisory locks and session-scoped statements required by Prisma Migrate          |

## Canonical `prisma/schema.prisma` and Prisma 7 Packages

Pin `prisma@^7`, `@prisma/client@^7`, and `@prisma/adapter-pg@^7` in `package.json`. In Prisma 7, connection URLs live in `prisma.config.ts` rather than inside `datasource db` in `prisma/schema.prisma`, and UUIDv7 primary keys use `@id @default(uuid(7)) @db.Uuid`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model Organization {
  id        String   @id @default(uuid(7)) @db.Uuid
  name      String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("organizations")
}
```

## Baseline Migration Procedure (`0_init`) and Row Level Security (RLS)

Why baselining and RLS are required on Supabase:

- Every Supabase database includes pre-populated schemas (`auth`, `storage`, `realtime`, `supabase_migrations`, `extensions`).
- Running `prisma migrate dev` on a fresh Prisma setup detects drift against those managed schemas and offers to reset the database, which would fail or destroy Supabase internals.
- Supabase exposes every table in the `public` schema through the Data API (PostgREST) by default. Any table Prisma creates in `public` without Row Level Security enabled is readable and writable with the publishable key until RLS is enabled. Always append `ALTER TABLE "public"."<table>" ENABLE ROW LEVEL SECURITY;` to `0_init/migration.sql` (and every subsequent migration that creates a table in `public`).

### 1. Existing database (tables in `prisma/schema.prisma` already exist in Supabase)

Generate `0_init/migration.sql`, append RLS statements for every table in `public`, mark `0_init` as already applied with `prisma migrate resolve --applied 0_init`, and run `prisma migrate deploy`:

```bash
#!/usr/bin/env bash
set -euo pipefail

mkdir -p prisma/migrations/0_init

yarn prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script \
  > prisma/migrations/0_init/migration.sql

# Ensure Row Level Security is enabled on every public table
sed -nE 's/^CREATE TABLE ("[^"]+"\.)?"([^"]+)".*/ALTER TABLE \1"\2" ENABLE ROW LEVEL SECURITY;/p' \
  prisma/migrations/0_init/migration.sql \
  >> prisma/migrations/0_init/migration.sql

yarn prisma migrate status || true
yarn prisma migrate resolve --applied 0_init
yarn prisma migrate deploy
```

### 2. Brand-new / empty Supabase database (application tables do not exist yet)

Generate `0_init/migration.sql`, append the `ENABLE ROW LEVEL SECURITY` statements, and run `yarn prisma migrate deploy` directly — do **not** run `yarn prisma migrate resolve --applied 0_init` first, because marking `0_init` as applied before `migrate deploy` causes Prisma to skip `0_init/migration.sql` and leaves the database empty:

```bash
mkdir -p prisma/migrations/0_init
yarn prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script \
  > prisma/migrations/0_init/migration.sql

sed -nE 's/^CREATE TABLE ("[^"]+"\.)?"([^"]+)".*/ALTER TABLE \1"\2" ENABLE ROW LEVEL SECURITY;/p' \
  prisma/migrations/0_init/migration.sql \
  >> prisma/migrations/0_init/migration.sql

yarn prisma migrate deploy
```

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

## Free Plan Pausing

Supabase pauses Free plan projects after a period of inactivity (one week at the time of writing; check the Supabase pricing and docs for the current policy). When setting up a new Free plan project, mention this and suggest [supabase-heartbeat](https://github.com/feRpicoral/supabase-heartbeat), an open-source project that keeps Supabase projects active with scheduled Postgres heartbeats. Adding the project to it, upgrading the plan, or restoring the project from the dashboard when it pauses are all valid choices.
