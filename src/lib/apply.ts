import type { SupabaseClient } from '@supabase/supabase-js';
import { OWNER_ID } from './db';
import type { LetterRow } from './types';

export function manualAppliedPatch(): Record<string, unknown> {
  return { status: 'sent', manual: true, sent_at: new Date().toISOString(), error: null };
}

export async function latestLetter(db: SupabaseClient, vacancyId: string): Promise<LetterRow | null> {
  const { data } = await db
    .from('letters')
    .select('*')
    .eq('vacancy_id', vacancyId)
    .eq('user_id', OWNER_ID)
    .order('version', { ascending: false })
    .limit(1);
  return (data?.[0] as LetterRow | undefined) ?? null;
}
