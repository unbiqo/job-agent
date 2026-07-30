import { loadRuntimeConfig, type SourceFiltersCfg } from '@/lib/config';
import { getDb, OWNER_ID } from '@/lib/db';
import type { ApplicationRow, EvaluationRow, LetterRow, VacancyRow } from '@/lib/types';
import { chunk } from '@/lib/util';
import InboxClient, { type InboxItem, type InboxStats } from './inbox-client';

export const dynamic = 'force-dynamic';

interface LabelRow {
  vacancy_id: string;
  label: 'relevant' | 'irrelevant' | string;
}

async function loadInbox(): Promise<InboxItem[]> {
  const db = getDb();
  const cfg = await loadRuntimeConfig(db);
  const { data: appRows } = await db
    .from('applications')
    .select('*')
    .eq('user_id', OWNER_ID)
    .in('status', ['listed', 'queued', 'failed', 'sent', 'invited', 'vetoed'])
    .order('queued_at', { ascending: false, nullsFirst: false });

  const apps = ((appRows ?? []) as ApplicationRow[]).filter((a) => a.status !== 'vetoed');
  const ids = [...new Set(apps.map((a) => a.vacancy_id))];
  if (!ids.length) return [];

  const vacById = new Map<string, VacancyRow>();
  const evById = new Map<string, EvaluationRow>();
  const letterById = new Map<string, LetterRow>();
  const labelById = new Map<string, string>();

  for (const part of chunk(ids, 200)) {
    const { data: vacs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vacs ?? []) as VacancyRow[]) vacById.set(v.id, v);

    const { data: evals } = await db.from('evaluations').select('*').eq('user_id', OWNER_ID).in('vacancy_id', part);
    for (const ev of (evals ?? []) as EvaluationRow[]) evById.set(ev.vacancy_id, ev);

    const { data: letters } = await db
      .from('letters')
      .select('*')
      .eq('user_id', OWNER_ID)
      .in('vacancy_id', part)
      .order('version', { ascending: true });
    for (const l of (letters ?? []) as LetterRow[]) letterById.set(l.vacancy_id, l);

    const { data: labels } = await db
      .from('labels')
      .select('vacancy_id,label')
      .eq('user_id', OWNER_ID)
      .eq('kind', 'vacancy')
      .in('vacancy_id', part);
    for (const l of (labels ?? []) as LabelRow[]) labelById.set(l.vacancy_id, l.label);
  }

  return apps
    .map((app) => {
      const vacancy = vacById.get(app.vacancy_id);
      if (!vacancy) return null;
      const ev = evById.get(app.vacancy_id) ?? null;
      const letter = letterById.get(app.vacancy_id) ?? null;
      return {
        app,
        vacancy,
        evaluation: ev,
        letter,
        label: labelById.get(app.vacancy_id) ?? null,
      } satisfies InboxItem;
    })
    .filter((x): x is InboxItem => Boolean(x))
    .filter((item) => {
      if (item.app.status === 'invited') return true;
      if (item.app.status === 'sent') return true;
      if (item.label === 'relevant') return true;
      return (item.evaluation?.score ?? 0) >= cfg.scoring.threshold;
    })
    .sort((a, b) => {
      const as = a.app.status === 'invited' ? 2 : a.app.status === 'sent' ? 1 : 0;
      const bs = b.app.status === 'invited' ? 2 : b.app.status === 'sent' ? 1 : 0;
      if (as !== bs) return as - bs;
      return (b.evaluation?.score ?? 0) - (a.evaluation?.score ?? 0);
    });
}

async function loadStats(): Promise<InboxStats> {
  const db = getDb();
  const [{ data: appRows }, { data: labelRows }] = await Promise.all([
    db.from('applications').select('status').eq('user_id', OWNER_ID),
    db.from('labels').select('label').eq('user_id', OWNER_ID).eq('kind', 'vacancy'),
  ]);
  const apps = (appRows ?? []) as Pick<ApplicationRow, 'status'>[];
  const labels = (labelRows ?? []) as Pick<LabelRow, 'label'>[];
  const countStatus = (status: ApplicationRow['status']) => apps.filter((app) => app.status === status).length;

  return {
    listed: countStatus('listed'),
    liked: labels.filter((label) => label.label === 'relevant').length,
    applied: countStatus('sent') + countStatus('invited') + countStatus('rejected') + countStatus('offer'),
    invited: countStatus('invited'),
    rejected: countStatus('rejected'),
    offers: countStatus('offer'),
  };
}

export default async function Home() {
  const db = getDb();
  const [items, stats, cfg] = await Promise.all([loadInbox(), loadStats(), loadRuntimeConfig(db)]);
  return <InboxClient items={items} stats={stats} sourceFilters={(cfg.source_filters ?? {}) as SourceFiltersCfg} />;
}
