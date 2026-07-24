import type { AppConfig } from './config';
import type { SalaryJson } from './types';

/**
 * Задача 5 слоя качества: частотная аналитика 👍- vs 👎-вакансий.
 * ТОЛЬКО отчёт — никаких автоматических изменений запросов/порогов/весов;
 * выводы владелец применяет вручную через config/settings.json.
 *
 * TODO(roadmap v2, ТЗ «слой качества» п.6): при 300+ метках реализацию можно
 * заменить (регрессия/кластеризация и т.п.) — интерфейс PatternAnalyzer для этого
 * и выделен. Сейчас НЕ реализовывать: ML-модели, LLM-as-judge, авто-обучение.
 */
export interface LabeledVacancy {
  label: 'relevant' | 'irrelevant';
  title: string;
  description: string | null;
  key_skills: string[] | null;
  salary: SalaryJson | null;
  employer: string | null;
}

export interface TermStat {
  term: string;
  likeCount: number;
  dislikeCount: number;
  /** Сглаженное отношение относительных частот 👍/👎: >1 — тянет к лайкам. */
  lift: number;
}

export interface PatternReport {
  nLike: number;
  nDislike: number;
  likeTop: TermStat[];
  dislikeTop: TermStat[];
  liftTop: TermStat[]; // наибольший перекос в сторону 👍
  liftBottom: TermStat[]; // наибольший перекос в сторону 👎
  markdown: string;
}

export interface PatternAnalyzer {
  readonly id: string;
  analyze(items: LabeledVacancy[]): PatternReport;
}

const RU_EN_STOPWORDS = new Set(
  (
    'и в во не на с со по для от до из за как что это или а но у о об при мы вы вас нам наш ваш их его её ' +
    'работа работы работу опыт опыта знание знания умение навыки требования обязанности условия компания команда ' +
    'the a an and or of to in on for with from by at is are be will you your we our as it this that ' +
    'work experience skills requirements team company job position candidate'
  )
    .split(/\s+/)
    .filter(Boolean),
);

function tokenize(text: string, stopwords: Set<string>): Set<string> {
  const tokens = text.toLowerCase().match(/[a-zа-яё][a-zа-яё0-9+#.-]{1,}/gi) ?? [];
  const out = new Set<string>();
  for (const t of tokens) {
    const clean = t.replace(/[.-]+$/, '');
    if (clean.length < 3) continue;
    if (stopwords.has(clean)) continue;
    out.add(clean);
  }
  return out;
}

function vacancyText(v: LabeledVacancy): string {
  return [v.title, (v.key_skills ?? []).join(' '), v.description ?? ''].join('\n').toLowerCase();
}

function salaryBucket(s: SalaryJson | null): string | null {
  if (!s) return null;
  const base = s.from ?? s.to;
  if (base == null) return null;
  const cur = s.currency ?? '?';
  const step = 100_000;
  const lo = Math.floor(base / step) * 100;
  return `${lo}–${lo + 100}к ${cur}`;
}

export class FrequencyPatternAnalyzer implements PatternAnalyzer {
  readonly id = 'frequency';

  constructor(
    private opts: { stopwords: Set<string>; techTerms: string[]; topN: number },
  ) {}

  analyze(items: LabeledVacancy[]): PatternReport {
    const likes = items.filter((i) => i.label === 'relevant');
    const dislikes = items.filter((i) => i.label === 'irrelevant');

    // документные частоты: в скольких вакансиях группа встретила терм
    const likeFreq = new Map<string, number>();
    const dislikeFreq = new Map<string, number>();
    const count = (v: LabeledVacancy, into: Map<string, number>) => {
      const text = vacancyText(v);
      const terms = tokenize(text, this.opts.stopwords);
      // tech-термины из словаря (в т.ч. многословные) — подстрочным поиском
      for (const term of this.opts.techTerms) {
        if (term && text.includes(term.toLowerCase())) terms.add(term.toLowerCase());
      }
      for (const t of terms) into.set(t, (into.get(t) ?? 0) + 1);
    };
    likes.forEach((v) => count(v, likeFreq));
    dislikes.forEach((v) => count(v, dislikeFreq));

    const allTerms = new Set([...likeFreq.keys(), ...dislikeFreq.keys()]);
    const stats: TermStat[] = [...allTerms].map((term) => {
      const a = likeFreq.get(term) ?? 0;
      const b = dislikeFreq.get(term) ?? 0;
      const lift = ((a + 1) / (likes.length + 2)) / ((b + 1) / (dislikes.length + 2));
      return { term, likeCount: a, dislikeCount: b, lift };
    });

    const topN = this.opts.topN;
    const likeTop = [...stats].sort((x, y) => y.likeCount - x.likeCount || y.lift - x.lift).slice(0, topN);
    const dislikeTop = [...stats].sort((x, y) => y.dislikeCount - x.dislikeCount || x.lift - y.lift).slice(0, topN);
    const liftTop = [...stats].filter((s) => s.likeCount >= 2).sort((x, y) => y.lift - x.lift).slice(0, 15);
    const liftBottom = [...stats].filter((s) => s.dislikeCount >= 2).sort((x, y) => x.lift - y.lift).slice(0, 15);

    const markdown = this.render(items, likes.length, dislikes.length, likeTop, dislikeTop, liftTop, liftBottom);
    return { nLike: likes.length, nDislike: dislikes.length, likeTop, dislikeTop, liftTop, liftBottom, markdown };
  }

  private render(
    items: LabeledVacancy[],
    nLike: number,
    nDislike: number,
    likeTop: TermStat[],
    dislikeTop: TermStat[],
    liftTop: TermStat[],
    liftBottom: TermStat[],
  ): string {
    const lines: string[] = [
      `# Паттерны 👍/👎 — ${new Date().toISOString()}`,
      '',
      `Меток: ${items.length} (👍 ${nLike} · 👎 ${nDislike})`,
      '',
    ];
    if (items.length === 0) {
      lines.push('**Недостаточно данных** — размечайте вакансии кнопками 👍/👎 в Telegram.');
      return lines.join('\n');
    }

    const table = (title: string, rows: TermStat[]) => {
      if (!rows.length) return;
      lines.push(`## ${title}`, '', '| Терм | 👍 | 👎 | lift |', '|---|---|---|---|');
      for (const r of rows) lines.push(`| ${r.term} | ${r.likeCount} | ${r.dislikeCount} | ${r.lift.toFixed(2)} |`);
      lines.push('');
    };
    table(`Топ-${likeTop.length} слов в лайкнутых`, likeTop);
    table(`Топ-${dislikeTop.length} слов в дизлайкнутых`, dislikeTop);
    table('Наибольший перекос к 👍 (lift)', liftTop);
    table('Наибольший перекос к 👎 (lift)', liftBottom);

    // зарплатные вилки и работодатели
    const buckets = (label: 'relevant' | 'irrelevant') => {
      const m = new Map<string, number>();
      for (const v of items.filter((i) => i.label === label)) {
        const b = salaryBucket(v.salary);
        if (b) m.set(b, (m.get(b) ?? 0) + 1);
      }
      return [...m.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8);
    };
    const likeB = buckets('relevant');
    const dislikeB = buckets('irrelevant');
    if (likeB.length || dislikeB.length) {
      lines.push('## Зарплатные вилки', '');
      if (likeB.length) lines.push('👍: ' + likeB.map(([b, c]) => `${b} (${c})`).join(' · '));
      if (dislikeB.length) lines.push('👎: ' + dislikeB.map(([b, c]) => `${b} (${c})`).join(' · '));
      lines.push('');
    }

    const employers = new Map<string, { like: number; dislike: number }>();
    for (const v of items) {
      if (!v.employer) continue;
      const e = employers.get(v.employer) ?? { like: 0, dislike: 0 };
      if (v.label === 'relevant') e.like++;
      else e.dislike++;
      employers.set(v.employer, e);
    }
    const empRows = [...employers.entries()].sort((a, b) => b[1].like + b[1].dislike - (a[1].like + a[1].dislike)).slice(0, 10);
    if (empRows.length) {
      lines.push('## Работодатели', '', '| Работодатель | 👍 | 👎 |', '|---|---|---|');
      for (const [name, c] of empRows) lines.push(`| ${name.replace(/\|/g, '/')} | ${c.like} | ${c.dislike} |`);
      lines.push('');
    }

    lines.push('---', '_Только отчёт: выводы применяются вручную через config/settings.json (запросы, стоп-слова, порог)._');
    return lines.join('\n');
  }
}

const DEFAULT_TECH_TERMS = [
  'python', 'typescript', 'javascript', 'node.js', 'react', 'next.js', 'sql', 'postgresql',
  'rag', 'llm', 'langchain', 'gemini', 'openai', 'gpt', 'ml', 'nlp', 'pytorch', 'fastapi',
  'docker', 'kubernetes', 'aws', 'telegram', 'supabase', 'gigachat', '1c', 'битрикс',
  'go', 'java', 'c#', 'php', 'machine learning', 'prompt engineering',
];

export function createPatternAnalyzer(cfg: AppConfig): PatternAnalyzer {
  const stopwords = new Set(RU_EN_STOPWORDS);
  for (const w of cfg.analytics?.stopwords_extra ?? []) stopwords.add(w.toLowerCase());
  return new FrequencyPatternAnalyzer({
    stopwords,
    techTerms: cfg.analytics?.tech_terms ?? DEFAULT_TECH_TERMS,
    topN: cfg.analytics?.top_n ?? 20,
  });
}
