import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_TRANSACTION_POOLING_URL: z.string().url(),
  DATABASE_SESSION_POOLING_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});
