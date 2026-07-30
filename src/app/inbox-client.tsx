'use client';

import { useMemo, useState } from 'react';
import type { JobTypeFilterKey, RegionFilterKey, SourceFilterCfg, SourceFiltersCfg, SourceId } from '@/lib/config';
import type { ApplicationRow, EvaluationRow, LetterRow, SalaryJson, VacancyRow } from '@/lib/types';
import { responseLetterRequired } from '@/lib/vacancy-letter';

export interface InboxItem {
  app: ApplicationRow;
  vacancy: VacancyRow;
  evaluation: EvaluationRow | null;
  letter: LetterRow | null;
  label: string | null;
}

export interface InboxStats {
  listed: number;
  liked: number;
  applied: number;
  invited: number;
  rejected: number;
  offers: number;
}

type ActionState = Record<string, string | null>;
type ScoreBucketId = 'strong' | 'good' | 'mid' | 'low' | 'empty';

const ARCHIVE_AFTER_DAYS = 2;
const SOURCE_LABELS: Record<SourceId, string> = { hh: 'hh', remoteok: 'Remote OK', wwr: 'WWR' };
const SOURCES: SourceId[] = ['hh', 'remoteok', 'wwr'];
const REGION_LABELS: Array<{ key: RegionFilterKey; label: string }> = [
  { key: 'worldwide', label: 'Worldwide' },
  { key: 'us', label: 'US only' },
  { key: 'canada', label: 'Canada' },
  { key: 'uk', label: 'UK' },
  { key: 'europe', label: 'EU/Europe' },
  { key: 'latin_america', label: 'LATAM' },
  { key: 'asia', label: 'Asia/APAC' },
  { key: 'unspecified', label: 'Unknown' },
];
const JOB_TYPE_LABELS: Array<{ key: JobTypeFilterKey; label: string }> = [
  { key: 'full_time', label: 'Full-time' },
  { key: 'contract', label: 'Contract' },
  { key: 'part_time', label: 'Part-time' },
  { key: 'freelance', label: 'Freelance' },
  { key: 'internship', label: 'Internship' },
  { key: 'unspecified', label: 'Unknown' },
];

const SCORE_BUCKETS: Array<{ id: ScoreBucketId; title: string; hint: string }> = [
  { id: 'strong', title: 'Strong match', hint: '8-10' },
  { id: 'good', title: 'Relevant', hint: '7' },
  { id: 'mid', title: 'Maybe', hint: '5-6' },
  { id: 'low', title: 'Low match', hint: '0-4' },
  { id: 'empty', title: 'Not scored', hint: '-/10' },
];

function defaultSourceFilter(): Required<Pick<SourceFilterCfg, 'enabled' | 'regions' | 'job_types' | 'include_terms' | 'exclude_terms'>> &
  Pick<SourceFilterCfg, 'min_salary_usd' | 'max_age_days'> {
  return {
    enabled: true,
    regions: Object.fromEntries(REGION_LABELS.map((x) => [x.key, true])) as Record<RegionFilterKey, boolean>,
    job_types: Object.fromEntries(JOB_TYPE_LABELS.map((x) => [x.key, x.key !== 'internship'])) as Record<JobTypeFilterKey, boolean>,
    include_terms: [],
    exclude_terms: [],
    min_salary_usd: 0,
    max_age_days: 14,
  };
}

function normalizeFilters(input: SourceFiltersCfg): SourceFiltersCfg {
  const out: SourceFiltersCfg = {};
  for (const source of SOURCES) {
    const defaults = defaultSourceFilter();
    const current = input[source] ?? {};
    out[source] = {
      ...defaults,
      ...current,
      regions: { ...defaults.regions, ...(current.regions ?? {}) },
      job_types: { ...defaults.job_types, ...(current.job_types ?? {}) },
      include_terms: current.include_terms ?? defaults.include_terms,
      exclude_terms: current.exclude_terms ?? defaults.exclude_terms,
    };
  }
  return out;
}

function termsText(terms: string[] | undefined): string {
  return (terms ?? []).join('\n');
}

function parseTerms(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function formatSalary(s?: SalaryJson | null): string {
  if (!s || (s.from == null && s.to == null)) return 'salary not specified';
  const cur = { RUR: 'RUB', RUB: 'RUB', USD: 'USD', EUR: 'EUR', KZT: 'KZT' }[s.currency ?? ''] ?? (s.currency ?? '');
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (s.from != null && s.to != null) return `${k(s.from)}-${k(s.to)} ${cur}`;
  if (s.from != null) return `from ${k(s.from)} ${cur}`;
  return `to ${k(s.to as number)} ${cur}`;
}

function publishedLabel(publishedAt?: string | null): string {
  if (!publishedAt) return '';
  const days = Math.floor((Date.now() - Date.parse(publishedAt)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function ageDays(publishedAt?: string | null): number {
  if (!publishedAt) return 0;
  const days = (Date.now() - Date.parse(publishedAt)) / 86_400_000;
  return Number.isFinite(days) ? days : 0;
}

function isArchived(item: InboxItem): boolean {
  if (['sent', 'invited', 'rejected', 'offer'].includes(item.app.status)) return false;
  return ageDays(item.vacancy.published_at) > ARCHIVE_AFTER_DAYS;
}

function scoreLabel(score?: number | null): string {
  return score == null ? '-/10' : `${score}/10`;
}

function scoreClass(score?: number | null): string {
  if (score == null) return 'score-empty';
  if (score >= 8) return 'score-strong';
  if (score >= 7) return 'score-good';
  if (score >= 5) return 'score-mid';
  return 'score-low';
}

function sourceInfo(vacancy: VacancyRow): { label: string; className: string } {
  const source = String(vacancy.raw?.source ?? '').toLowerCase();
  if (source === 'remoteok') return { label: 'Remote OK', className: 'source-remoteok' };
  if (source === 'wwr') return { label: 'WWR', className: 'source-wwr' };
  return { label: 'hh', className: 'source-hh' };
}

function scoreBucketId(score?: number | null): ScoreBucketId {
  if (score == null) return 'empty';
  if (score >= 8) return 'strong';
  if (score >= 7) return 'good';
  if (score >= 5) return 'mid';
  return 'low';
}

function descriptionPreview(text?: string | null): string {
  if (!text) return 'Description is not loaded yet. Open the hh link if this vacancy looks promising by title and company.';
  const paragraphs = text
    .split(/\n{2,}|\r\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const selected = paragraphs.length ? paragraphs.slice(0, 8).join('\n\n') : text.trim();
  return selected.length > 4500 ? `${selected.slice(0, 4500).trim()}...` : selected;
}

function hhUrl(id: string): string {
  return `https://hh.ru/vacancy/${id}`;
}

function vacancyUrl(vacancy: VacancyRow): string {
  const rawUrl = vacancy.raw?.url;
  return typeof rawUrl === 'string' && /^https?:\/\//.test(rawUrl) ? rawUrl : hhUrl(vacancy.id);
}

async function postAction(vacancyId: string, action: string, extra: Record<string, unknown> = {}) {
  const res = await fetch('/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vacancyId, action, ...extra }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; letter?: LetterRow | null; letterRequired?: boolean };
  if (!res.ok || !data.ok) throw new Error(data.error ?? `Action failed: ${action}`);
  return data;
}

async function loadMoreAction(excludeIds: string[]) {
  const res = await fetch('/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load_more', excludeIds, limit: 10 }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; items?: InboxItem[] };
  if (!res.ok || !data.ok) throw new Error(data.error ?? 'Load more failed');
  return data.items ?? [];
}

async function saveSettingsAction(sourceFilters: SourceFiltersCfg) {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_filters: sourceFilters }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; source_filters?: SourceFiltersCfg };
  if (!res.ok || !data.ok) throw new Error(data.error ?? 'Could not save settings');
  return data.source_filters ?? sourceFilters;
}

export default function InboxClient({
  items: initialItems,
  stats: initialStats,
  sourceFilters: initialSourceFilters,
}: {
  items: InboxItem[];
  stats: InboxStats;
  sourceFilters: SourceFiltersCfg;
}) {
  const [items, setItems] = useState(initialItems);
  const [stats, setStats] = useState(initialStats);
  const [sourceFilters, setSourceFilters] = useState<SourceFiltersCfg>(() => normalizeFilters(initialSourceFilters));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [selectedId, setSelectedId] = useState(initialItems[0]?.vacancy.id ?? '');
  const [busy, setBusy] = useState<ActionState>({});
  const [notice, setNotice] = useState<string>('');
  const [hasMore, setHasMore] = useState(true);

  const activeItems = useMemo(() => items.filter((item) => !isArchived(item)), [items]);
  const archivedItems = useMemo(() => items.filter((item) => isArchived(item)), [items]);
  const visibleItems = showArchive ? [...activeItems, ...archivedItems] : activeItems;
  const selected = useMemo(
    () => visibleItems.find((item) => item.vacancy.id === selectedId) ?? visibleItems[0] ?? null,
    [visibleItems, selectedId],
  );
  const sections = useMemo(
    () =>
      SCORE_BUCKETS.map((bucket) => ({
        ...bucket,
        items: visibleItems.filter((item) => scoreBucketId(item.evaluation?.score) === bucket.id),
      })).filter((section) => section.items.length > 0),
    [visibleItems],
  );
  const selectedNeedsLetter = selected ? responseLetterRequired(selected.vacancy) !== false : true;

  async function run(vacancyId: string, label: string, fn: () => Promise<void>) {
    setBusy((s) => ({ ...s, [vacancyId]: label }));
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((s) => ({ ...s, [vacancyId]: null }));
    }
  }

  async function approve(vacancyId: string) {
    const current = items.find((row) => row.vacancy.id === vacancyId);
    const needsLetter = current ? responseLetterRequired(current.vacancy) !== false : true;
    await run(vacancyId, needsLetter ? 'Generating...' : 'Saving...', async () => {
      const data = await postAction(vacancyId, 'approve', { force: Boolean(current?.letter) });
      setItems((rows) =>
        rows.map((row) =>
          row.vacancy.id === vacancyId
            ? { ...row, label: 'relevant', letter: data.letter ?? row.letter, app: { ...row.app, status: 'listed' } }
            : row,
        ),
      );
      setNotice(data.letter ? 'Letter generated.' : 'No cover letter required. Open the source vacancy and apply without a letter.');
    });
  }

  async function skip(vacancyId: string) {
    await run(vacancyId, 'Skipping...', async () => {
      await postAction(vacancyId, 'skip');
      setItems((rows) => rows.filter((row) => row.vacancy.id !== vacancyId));
      setSelectedId((current) => (current === vacancyId ? '' : current));
    });
  }

  async function copyAndOpen(item: InboxItem) {
    if (responseLetterRequired(item.vacancy) === false) {
      window.open(vacancyUrl(item.vacancy), '_blank', 'noopener,noreferrer');
      setNotice('Source vacancy opened. No cover letter required.');
      return;
    }
    if (!item.letter?.text) {
      setNotice('Generate the letter first.');
      return;
    }
    await navigator.clipboard.writeText(item.letter.text);
    window.open(vacancyUrl(item.vacancy), '_blank', 'noopener,noreferrer');
    setNotice('Letter copied. Source vacancy opened.');
  }

  async function markApplied(vacancyId: string) {
    await run(vacancyId, 'Saving...', async () => {
      await postAction(vacancyId, 'mark_applied');
      setItems((rows) => rows.map((row) => (row.vacancy.id === vacancyId ? { ...row, app: { ...row.app, status: 'sent' } } : row)));
      setStats((s) => ({ ...s, applied: s.applied + 1 }));
      setNotice('Marked as applied.');
    });
  }

  async function markInterview(vacancyId: string) {
    await run(vacancyId, 'Saving...', async () => {
      await postAction(vacancyId, 'mark_interview');
      setItems((rows) =>
        rows.map((row) =>
          row.vacancy.id === vacancyId ? { ...row, app: { ...row.app, status: 'invited', response_at: new Date().toISOString() } } : row,
        ),
      );
      setStats((s) => ({ ...s, invited: s.invited + 1 }));
      setNotice('Marked as interview invite.');
    });
  }

  async function loadMore() {
    setBusy((s) => ({ ...s, __load_more: 'Loading...' }));
    setNotice('');
    try {
      const more = await loadMoreAction(items.map((item) => item.vacancy.id));
      setItems((rows) => {
        const seen = new Set(rows.map((row) => row.vacancy.id));
        const next = more.filter((item) => !seen.has(item.vacancy.id));
        if (!selectedId && next[0]) setSelectedId(next[0].vacancy.id);
        return [...rows, ...next];
      });
      if (more.length < 10) setHasMore(false);
      setNotice(more.length ? `Loaded ${more.length} more scored vacancies.` : 'No more scored vacancies.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((s) => ({ ...s, __load_more: null }));
    }
  }

  function updateSource(source: SourceId, patch: SourceFilterCfg) {
    setSourceFilters((current) => ({ ...current, [source]: { ...(current[source] ?? defaultSourceFilter()), ...patch } }));
  }

  function updateRegion(source: SourceId, key: RegionFilterKey, checked: boolean) {
    const current = sourceFilters[source] ?? defaultSourceFilter();
    updateSource(source, { regions: { ...(current.regions ?? {}), [key]: checked } });
  }

  function updateJobType(source: SourceId, key: JobTypeFilterKey, checked: boolean) {
    const current = sourceFilters[source] ?? defaultSourceFilter();
    updateSource(source, { job_types: { ...(current.job_types ?? {}), [key]: checked } });
  }

  async function saveFilters() {
    setBusy((s) => ({ ...s, __filters: 'Saving...' }));
    setNotice('');
    try {
      const saved = await saveSettingsAction(sourceFilters);
      setSourceFilters(normalizeFilters(saved));
      setNotice('Source filters saved. They will apply on the next scrape run.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((s) => ({ ...s, __filters: null }));
    }
  }

  return (
    <main className="inbox-shell">
      <aside className="inbox-list" aria-label="Vacancies">
        <div className="inbox-top">
          <div>
            <h1>Job inbox</h1>
            <p>
              {activeItems.length} active
              {archivedItems.length ? ` · ${archivedItems.length} archived` : ''}
            </p>
          </div>
          <a className="refresh-link" href="/">
            Refresh
          </a>
        </div>
        <div className="stats-panel" aria-label="Stats">
          <div>
            <strong>{stats.listed}</strong>
            <span>inbox</span>
          </div>
          <div>
            <strong>{stats.liked}</strong>
            <span>liked</span>
          </div>
          <div>
            <strong>{stats.applied}</strong>
            <span>applied</span>
          </div>
          <div>
            <strong>{stats.invited}</strong>
            <span>interviews</span>
          </div>
          <div>
            <strong>{stats.rejected}</strong>
            <span>rejected</span>
          </div>
          <div>
            <strong>{stats.offers}</strong>
            <span>offers</span>
          </div>
        </div>
        <div className="filters-panel">
          <button type="button" className="filters-toggle" onClick={() => setFiltersOpen((open) => !open)}>
            {filtersOpen ? 'Hide filters' : 'Source filters'}
          </button>
          {filtersOpen ? (
            <div className="filters-body">
              {SOURCES.map((source) => {
                const f = sourceFilters[source] ?? defaultSourceFilter();
                return (
                  <section className="source-filter" key={source}>
                    <label className="source-filter-title">
                      <input type="checkbox" checked={f.enabled !== false} onChange={(e) => updateSource(source, { enabled: e.target.checked })} />
                      <span>{SOURCE_LABELS[source]}</span>
                    </label>
                    <div className="filter-group">
                      <span>Regions</span>
                      <div className="filter-chips">
                        {REGION_LABELS.map((r) => (
                          <label key={r.key}>
                            <input
                              type="checkbox"
                              checked={f.regions?.[r.key] !== false}
                              onChange={(e) => updateRegion(source, r.key, e.target.checked)}
                            />
                            {r.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="filter-group">
                      <span>Job type</span>
                      <div className="filter-chips">
                        {JOB_TYPE_LABELS.map((t) => (
                          <label key={t.key}>
                            <input
                              type="checkbox"
                              checked={f.job_types?.[t.key] ?? t.key !== 'internship'}
                              onChange={(e) => updateJobType(source, t.key, e.target.checked)}
                            />
                            {t.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="filter-grid">
                      <label>
                        <span>Min USD salary</span>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={f.min_salary_usd ?? 0}
                          onChange={(e) => updateSource(source, { min_salary_usd: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </label>
                      <label>
                        <span>Max age days</span>
                        <input
                          type="number"
                          min="0"
                          max="90"
                          value={f.max_age_days ?? 14}
                          onChange={(e) => updateSource(source, { max_age_days: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </label>
                    </div>
                    <label className="filter-textarea">
                      <span>Include keywords</span>
                      <textarea
                        rows={2}
                        value={termsText(f.include_terms)}
                        onChange={(e) => updateSource(source, { include_terms: parseTerms(e.target.value) })}
                      />
                    </label>
                    <label className="filter-textarea">
                      <span>Exclude keywords</span>
                      <textarea
                        rows={2}
                        value={termsText(f.exclude_terms)}
                        onChange={(e) => updateSource(source, { exclude_terms: parseTerms(e.target.value) })}
                      />
                    </label>
                  </section>
                );
              })}
              <button type="button" className="save-filters" disabled={Boolean(busy.__filters)} onClick={saveFilters}>
                {busy.__filters ? 'Saving...' : 'Save filters'}
              </button>
            </div>
          ) : null}
        </div>
        {archivedItems.length ? (
          <button type="button" className="archive-toggle" onClick={() => setShowArchive((current) => !current)}>
            {showArchive ? 'Hide archive' : `Show archive (${archivedItems.length})`}
          </button>
        ) : null}
        {items.length === 0 ? (
          <div className="empty-list">No vacancies yet.</div>
        ) : visibleItems.length === 0 ? (
          <div className="empty-list">No active vacancies. Use archive to review old ones.</div>
        ) : (
          sections.map((section) => (
            <div className="score-section" key={section.id}>
              <div className="score-section-header">
                <span>{section.title}</span>
                <span>
                  {section.hint} · {section.items.length}
                </span>
              </div>
              {section.items.map((item) => {
                const active = selected?.vacancy.id === item.vacancy.id;
                const needsLetter = responseLetterRequired(item.vacancy) !== false;
                const source = sourceInfo(item.vacancy);
                return (
                  <button
                    key={item.vacancy.id}
                    type="button"
                    className={`vacancy-row ${active ? 'active' : ''}`}
                    onClick={() => setSelectedId(item.vacancy.id)}
                  >
                    <span className="row-title">{item.vacancy.title}</span>
                    <span className="row-company">{item.vacancy.employer ?? 'Unknown company'}</span>
                    <span className="row-meta">
                      <span className={`score-badge ${scoreClass(item.evaluation?.score)}`}>{scoreLabel(item.evaluation?.score)}</span>
                      <span className={`source-badge ${source.className}`}>{source.label}</span>
                      <span>{publishedLabel(item.vacancy.published_at)}</span>
                      <span>{!needsLetter ? 'no letter' : item.label === 'relevant' ? 'liked' : item.app.status}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
        <button type="button" className="load-more" disabled={!hasMore || Boolean(busy.__load_more)} onClick={loadMore}>
          {busy.__load_more ? 'Loading...' : hasMore ? 'Load 10 more scored' : 'No more scored'}
        </button>
      </aside>

      <section className="inbox-detail" aria-live="polite">
        {!selected ? (
          <div className="empty-detail">Select a vacancy.</div>
        ) : (
          <>
            <header className="detail-header">
              <div>
                <h2>{selected.vacancy.title}</h2>
                <p>
                  {selected.vacancy.employer ?? 'Unknown company'} · {formatSalary(selected.vacancy.salary)} ·{' '}
                  {selected.vacancy.area ?? 'area not specified'} · {publishedLabel(selected.vacancy.published_at)} ·{' '}
                  {selectedNeedsLetter ? 'cover letter may be needed' : 'no cover letter required'}
                </p>
              </div>
              <a className="hh-link" href={vacancyUrl(selected.vacancy)} target="_blank" rel="noreferrer">
                {sourceInfo(selected.vacancy).label}
              </a>
            </header>

            {notice ? <div className="notice">{notice}</div> : null}

            <div className="action-bar">
              <button type="button" className="primary" disabled={Boolean(busy[selected.vacancy.id])} onClick={() => approve(selected.vacancy.id)}>
                {busy[selected.vacancy.id] === 'Generating...'
                  ? 'Generating...'
                  : busy[selected.vacancy.id] === 'Saving...'
                    ? 'Saving...'
                    : !selectedNeedsLetter
                      ? 'Like / no letter needed'
                      : selected.letter
                        ? 'Regenerate letter'
                        : 'Like -> generate letter'}
              </button>
              <button type="button" disabled={Boolean(busy[selected.vacancy.id])} onClick={() => skip(selected.vacancy.id)}>
                Skip
              </button>
              <button type="button" disabled={selectedNeedsLetter && !selected.letter?.text} onClick={() => copyAndOpen(selected)}>
                {selectedNeedsLetter ? 'Copy letter + open source' : 'Open source'}
              </button>
              <button
                type="button"
                disabled={(selectedNeedsLetter && !selected.letter?.text) || selected.app.status === 'sent' || selected.app.status === 'invited'}
                onClick={() => markApplied(selected.vacancy.id)}
              >
                Mark applied
              </button>
              <button type="button" disabled={selected.app.status === 'invited'} onClick={() => markInterview(selected.vacancy.id)}>
                {selected.app.status === 'invited' ? 'Interview marked' : 'Mark interview'}
              </button>
            </div>

            {selected.evaluation?.reasons?.length ? (
              <section className="detail-section">
                <h3>Why it matched</h3>
                <p>{selected.evaluation.reasons.join('; ')}</p>
              </section>
            ) : null}

            <section className="detail-section">
              <h3>Vacancy description</h3>
              <div className="description-text">{descriptionPreview(selected.vacancy.description)}</div>
            </section>

            {!selectedNeedsLetter ? (
              <section className="detail-section muted-section">
                <h3>Cover letter</h3>
                <p>Not required for this vacancy. Open the source vacancy and apply without generating a letter.</p>
              </section>
            ) : selected.letter?.text ? (
              <section className="detail-section letter-section">
                <h3>Cover letter</h3>
                <pre>{selected.letter.text}</pre>
              </section>
            ) : (
              <section className="detail-section muted-section">
                <h3>Cover letter</h3>
                <p>No letter yet. It will be generated only after you approve this vacancy.</p>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
