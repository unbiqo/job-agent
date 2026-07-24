import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import { OWNER_ID } from './db';

export interface ProjectCard {
  name: string;
  links: string[];
  stack: string[];
  bullets: string[];
  metrics?: string[];
}

export interface Profile {
  resumes: Record<string, string>; // ключ версии -> полный текст
  projects: ProjectCard[];
  notes: string;
  /** Полный корпус фактов — против него валидируются ссылки и числа в письмах. */
  corpus: string;
}

export function loadProfile(cfg: AppConfig, root = process.cwd()): Profile {
  const resumes: Record<string, string> = {};
  for (const [key, rv] of Object.entries(cfg.scoring.resume_versions)) {
    const p = path.join(root, rv.file);
    if (!existsSync(p)) {
      throw new Error(
        `Не найден файл резюме для версии "${key}": ${rv.file}. ` +
          `Скопируйте ${rv.file}.example в ${rv.file} и заполните своими фактами.`,
      );
    }
    resumes[key] = readFileSync(p, 'utf-8').trim();
  }
  const projectsPath = path.join(root, 'config', 'profile', 'projects.json');
  const projects: ProjectCard[] = existsSync(projectsPath)
    ? (JSON.parse(readFileSync(projectsPath, 'utf-8')) as ProjectCard[])
    : [];
  const notesPath = path.join(root, 'config', 'profile', 'notes.md');
  const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf-8').trim() : '';

  const corpus = [Object.values(resumes).join('\n\n'), JSON.stringify(projects), notes].join('\n\n');
  return { resumes, projects, notes, corpus };
}

/**
 * Профиль из profile_facts (заливается скриптом profile-push) с фолбэком на
 * локальные файлы. Личные файлы не коммитятся, поэтому воркер в CI читает БД.
 */
export async function loadProfileSmart(
  db: SupabaseClient,
  cfg: AppConfig,
  root = process.cwd(),
): Promise<Profile> {
  const { data } = await db.from('profile_facts').select('*').eq('user_id', OWNER_ID);
  const rows = (data ?? []) as { kind: string; title: string | null; data: Record<string, unknown> }[];
  const resumeRows = rows.filter((r) => r.kind === 'resume');
  if (!resumeRows.length) return loadProfile(cfg, root);

  const resumes: Record<string, string> = {};
  for (const r of resumeRows) resumes[r.title ?? 'default'] = String(r.data?.text ?? '');
  const projects = rows.filter((r) => r.kind === 'project').map((r) => r.data as unknown as ProjectCard);
  const notes = rows
    .filter((r) => r.kind === 'note')
    .map((r) => String(r.data?.text ?? ''))
    .join('\n\n');
  const corpus = [Object.values(resumes).join('\n\n'), JSON.stringify(projects), notes].join('\n\n');
  return { resumes, projects, notes, corpus };
}

/** Компактный PROFILE_JSON для скоринга (раздел 7.1 ТЗ). */
export function profileForScoring(cfg: AppConfig, profile: Profile): Record<string, unknown> {
  const excerpts: Record<string, string> = {};
  for (const [k, text] of Object.entries(profile.resumes)) excerpts[k] = text.slice(0, 2500);
  return {
    roles: cfg.profile.roles,
    grade: cfg.profile.grade,
    skills: cfg.profile.skills,
    constraints: cfg.profile.constraints,
    salary_min: cfg.filters.salary_min > 0 ? `${cfg.filters.salary_min} ${cfg.filters.currency}` : null,
    formats: cfg.filters.formats,
    projects: profile.projects,
    notes: profile.notes.slice(0, 1500),
    resume_excerpts: excerpts,
  };
}

/** Полные PROFILE_FACTS для письма (раздел 7.2 ТЗ): только выбранная версия резюме + проекты + заметки. */
export function profileFactsForLetter(profile: Profile, resumeVersion: string): Record<string, unknown> {
  return {
    resume: profile.resumes[resumeVersion] ?? Object.values(profile.resumes)[0] ?? '',
    projects: profile.projects,
    notes: profile.notes,
  };
}
