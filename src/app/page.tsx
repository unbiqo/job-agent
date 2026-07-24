import { getDb, OWNER_ID } from '@/lib/db';
import { formatSalary, publishedLabel } from '@/lib/telegram';
import type { ApplicationRow, EvaluationRow, LetterRow, RunStats, VacancyRow } from '@/lib/types';
import { chunk } from '@/lib/util';

export const dynamic = 'force-dynamic';

interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  stats: Partial<RunStats> | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

async function loadData() {
  const db = getDb();

  const { count: found } = await db.from('vacancies').select('*', { count: 'exact', head: true });
  const { count: excluded } = await db
    .from('evaluations')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .like('prefilter', 'excluded%');
  const { count: scored } = await db
    .from('evaluations')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .not('score', 'is', null);
  const { count: lettered } = await db
    .from('letters')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', OWNER_ID)
    .eq('version', 1);

  const { data: appsData } = await db.from('applications').select('*').eq('user_id', OWNER_ID);
  const apps = (appsData ?? []) as ApplicationRow[];

  const ids = apps.map((a) => a.vacancy_id);
  const vacById = new Map<string, VacancyRow>();
  const evByVac = new Map<string, EvaluationRow>();
  const letterByVac = new Map<string, LetterRow>();
  for (const part of chunk(ids, 200)) {
    const { data: vs } = await db.from('vacancies').select('*').in('id', part);
    for (const v of (vs ?? []) as VacancyRow[]) vacById.set(v.id, v);
    const { data: es } = await db.from('evaluations').select('*').eq('user_id', OWNER_ID).in('vacancy_id', part);
    for (const e of (es ?? []) as EvaluationRow[]) evByVac.set(e.vacancy_id, e);
    const { data: ls } = await db
      .from('letters')
      .select('*')
      .eq('user_id', OWNER_ID)
      .in('vacancy_id', part)
      .order('version', { ascending: true });
    for (const l of (ls ?? []) as LetterRow[]) letterByVac.set(l.vacancy_id, l); // последняя версия перезапишет
  }

  const { data: runsData } = await db
    .from('runs')
    .select('*')
    .eq('user_id', OWNER_ID)
    .order('started_at', { ascending: false })
    .limit(10);

  return {
    counts: { found: found ?? 0, excluded: excluded ?? 0, scored: scored ?? 0, lettered: lettered ?? 0 },
    apps,
    vacById,
    evByVac,
    letterByVac,
    runs: (runsData ?? []) as RunRow[],
  };
}

function statusCounts(apps: ApplicationRow[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const a of apps) c[a.status] = (c[a.status] ?? 0) + 1;
  return c;
}

function Card({
  app,
  v,
  ev,
  letter,
}: {
  app: ApplicationRow;
  v: VacancyRow | undefined;
  ev: EvaluationRow | undefined;
  letter: LetterRow | undefined;
}) {
  if (!v) return null;
  return (
    <div className="card">
      <div className="head">
        <div>
          <div className="title">
            <span className="score">{ev?.score ?? '—'}/10</span> · {v.title} ·{' '}
            <a href={`https://hh.ru/vacancy/${v.id}`} target="_blank" rel="noreferrer">
              {v.employer ?? 'hh.ru'}
            </a>
          </div>
          <div className="meta">
            {formatSalary(v.salary)} · {v.area ?? ''} · {publishedLabel(v.published_at)}
          </div>
        </div>
        <span className={`badge ${app.status}`}>{app.status}</span>
      </div>
      {ev?.reasons?.length ? <p className="reasons">Почему подходит: {ev.reasons.join('; ')}</p> : null}
      {app.error ? <p className="reasons">⚠ {app.error}</p> : null}
      {letter ? (
        <details>
          <summary>Письмо (v{letter.version})</summary>
          <pre>{letter.text}</pre>
        </details>
      ) : null}
    </div>
  );
}

export default async function Home() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return (
      <main className="wrap">
        <h1>
          <span className="brand">Job</span>Agent
        </h1>
        <p className="sub">Задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (см. .env.example и README).</p>
      </main>
    );
  }

  const { counts, apps, vacById, evByVac, letterByVac, runs } = await loadData();
  const sc = statusCounts(apps);
  const queue = apps
    .filter((a) => a.status === 'queued')
    .sort((a, b) => (evByVac.get(b.vacancy_id)?.score ?? 0) - (evByVac.get(a.vacancy_id)?.score ?? 0));
  const recent = apps
    .filter((a) => a.status !== 'queued')
    .sort((a, b) => Date.parse(b.sent_at ?? b.queued_at ?? '0') - Date.parse(a.sent_at ?? a.queued_at ?? '0'))
    .slice(0, 30);

  const funnel: [string, number][] = [
    ['found', counts.found],
    ['excluded', counts.excluded],
    ['scored', counts.scored],
    ['lettered', counts.lettered],
    ['queued', sc.queued ?? 0],
    ['sent', (sc.sent ?? 0) + (sc.viewed ?? 0) + (sc.invited ?? 0) + (sc.rejected ?? 0)],
    ['viewed', sc.viewed ?? 0],
    ['invited', sc.invited ?? 0],
    ['rejected', sc.rejected ?? 0],
    ['failed', sc.failed ?? 0],
  ];

  return (
    <main className="wrap">
      <h1>
        <span className="brand">Job</span>Agent
      </h1>
      <p className="sub">Очередь откликов · single-user v0</p>

      <h2>Воронка</h2>
      <table>
        <thead>
          <tr>
            {funnel.map(([k]) => (
              <th key={k}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {funnel.map(([k, n]) => (
              <td key={k} className="num">
                {n}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <h2>Очередь ({queue.length})</h2>
      {queue.length === 0 ? (
        <div className="empty">Очередь пуста — всё отправлено или ждём следующего прогона.</div>
      ) : (
        queue.map((a) => (
          <Card
            key={a.vacancy_id}
            app={a}
            v={vacById.get(a.vacancy_id)}
            ev={evByVac.get(a.vacancy_id)}
            letter={letterByVac.get(a.vacancy_id)}
          />
        ))
      )}

      <h2>Последние отклики</h2>
      {recent.length === 0 ? (
        <div className="empty">Откликов ещё не было.</div>
      ) : (
        recent.map((a) => (
          <Card
            key={a.vacancy_id}
            app={a}
            v={vacById.get(a.vacancy_id)}
            ev={evByVac.get(a.vacancy_id)}
            letter={letterByVac.get(a.vacancy_id)}
          />
        ))
      )}

      <h2>Прогоны</h2>
      {runs.length === 0 ? (
        <div className="empty">Прогонов ещё не было — запустите npm run pipeline.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Старт (UTC)</th>
              <th>Собрано</th>
              <th>Новых</th>
              <th>Оценено</th>
              <th>Писем</th>
              <th>Отправлено</th>
              <th>Токены in/out</th>
              <th>$</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="num">{new Date(r.started_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td className="num">{r.stats?.collected ?? '—'}</td>
                <td className="num">{r.stats?.new ?? '—'}</td>
                <td className="num">{r.stats?.scored ?? '—'}</td>
                <td className="num">{r.stats?.lettered ?? '—'}</td>
                <td className="num">{r.stats?.sent ?? '—'}</td>
                <td className="num">
                  {r.tokens_in}/{r.tokens_out}
                </td>
                <td className="num">{Number(r.cost_usd).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
