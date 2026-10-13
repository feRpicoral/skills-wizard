---
title: Supabase with Prisma
summary: Supabase keys, pooling URLs and baseline migrations
group: stack
scopes: [project]
defaults: []
---

## Supabase with Prisma

- Use the publishable and secret API key model (`SUPABASE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`), never the legacy `anon` or `service_role` keys.
- Use `DATABASE_TRANSACTION_POOLING_URL` (port `6543`, `?pgbouncer=true`) for runtime Prisma Client queries and `DATABASE_SESSION_POOLING_URL` (port `5432`) in `prisma.config.ts` for Prisma CLI migrations and introspection.
- Never run `prisma migrate reset` against a Supabase database because it collides with Supabase-managed schemas (`auth`, `storage`, `realtime`). Baseline initial schemas with a `0_init` migration via `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` and `prisma migrate resolve --applied 0_init`.
- When creating or onboarding a new Supabase project, remind the user to register it in `feRpicoral/supabase-heartbeat` so the free-tier instance does not pause.
- Use the `supabase-prisma` skill when configuring `prisma.config.ts`, `@prisma/adapter-pg`, `.env.example`, or baseline migrations.
