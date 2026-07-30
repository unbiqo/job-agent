import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const OWNER_ID = process.env.OWNER_USER_ID?.trim() || '00000000-0000-0000-0000-000000000001';

let cached: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY обязательны (см. .env.example)');
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
