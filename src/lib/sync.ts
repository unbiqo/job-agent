import type { SupabaseClient } from '@supabase/supabase-js';
import { OWNER_ID } from './db';
import type { HHClient } from './hh';
import type { ApplicationRow, ApplicationStatus } from './types';

/** Порядок статусов: обновляем только «вперёд», чтобы синк не откатывал приглашения. */
const RANK: Record<string, number> = {
  queued: 0,
  vetoed: 0,
  failed: 0,
  sent: 1,
  viewed: 2,
  invited: 3,
  rejected: 3,
  offer: 4,
};

/**
 * Шаг 9 пайплайна: GET /negotiations → обновить статусы своих откликов.
 * Отклики, сделанные вне агента, тоже фиксируются (guardrail 3 — защита от двойных).
 */
export async function syncNegotiations(
  db: SupabaseClient,
  hh: HHClient,
): Promise<{ updates: string[] }> {
  const updates: string[] = [];
  const { data: appsData } = await db.from('applications').select('*').eq('user_id', OWNER_ID);
  const apps = new Map<string, ApplicationRow>(
    ((appsData ?? []) as ApplicationRow[]).map((a) => [a.vacancy_id, a]),
  );

  for (let page = 0; page < 10; page++) {
    const res = await hh.getNegotiations(page);
    for (const item of res.items) {
      const vid = item.vacancy?.id;
      if (!vid) continue;
      const stateId = item.state?.id;
      const mapped: ApplicationStatus =
        stateId === 'invitation'
          ? 'invited'
          : stateId === 'discard'
            ? 'rejected'
            : item.viewed_by_opponent
              ? 'viewed'
              : 'sent';

      const existing = apps.get(vid);
      if (!existing) {
        const employer = (item.vacancy as { employer?: { name?: string } } | null)?.employer?.name ?? null;
        await db.from('vacancies').upsert(
          {
            id: vid,
            user_id: OWNER_ID,
            title: item.vacancy?.name ?? 'unknown',
            employer,
            published_at: item.vacancy?.published_at ?? null,
            raw: item.vacancy ?? {},
          },
          { onConflict: 'id', ignoreDuplicates: true },
        );
        const row = {
          vacancy_id: vid,
          user_id: OWNER_ID,
          status: mapped,
          sent_at: item.created_at ?? null,
          response_at: mapped === 'invited' || mapped === 'rejected' ? (item.updated_at ?? null) : null,
        };
        await db.from('applications').upsert(row, { onConflict: 'vacancy_id,user_id' });
        apps.set(vid, row as unknown as ApplicationRow);
        updates.push(`внешний отклик: ${item.vacancy?.name ?? vid} (${mapped})`);
      } else if ((RANK[mapped] ?? 0) > (RANK[existing.status] ?? 0)) {
        const patch: Record<string, unknown> = { status: mapped };
        if ((mapped === 'invited' || mapped === 'rejected') && !existing.response_at) {
          patch.response_at = item.updated_at ?? new Date().toISOString();
        }
        await db.from('applications').update(patch).eq('vacancy_id', vid).eq('user_id', OWNER_ID);
        updates.push(`${item.vacancy?.name ?? vid}: ${existing.status} → ${mapped}`);
        existing.status = mapped;
      }
    }
    if (page >= res.pages - 1) break;
  }
  return { updates };
}
