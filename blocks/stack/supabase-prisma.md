---
title: Supabase with Prisma
summary: Supabase keys, pooling URLs and baseline migrations
group: stack
scopes: [global, project]
defaults: [global]
---

## Supabase with Prisma

- Use the new API key style (publishable key + secret key), not the legacy `anon` key.
- Connection URLs: set `DATABASE_TRANSACTION_POOLING_URL` to the transaction pooler and `DATABASE_SESSION_POOLING_URL` to the session pooler, where applicable.
- When an implementation creates or implies a new Supabase project, suggest adding it to `feRpicoral/supabase-heartbeat` to prevent pausing.
- The database cannot be reset because of other Supabase-managed tables, and the first migration won't generate due to drift. Baseline it instead:

      mkdir -p prisma/migrations/0_init
      yarn prisma migrate diff \
        --from-empty \
        --to-schema prisma/schema.prisma \
        --script \
        > prisma/migrations/0_init/migration.sql
      yarn prisma migrate deploy
