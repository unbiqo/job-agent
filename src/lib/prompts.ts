import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';

/**
 * Промпты — версионируемые файлы в prompts/ (задача 1 слоя качества):
 * шапка `--- version: N ---`, тело — текст промпта с плейсхолдерами {{key}}.
 * Версия логируется у каждого LLM-вызова, чтобы можно было откатить промпт
 * и сравнить качество версий через npm run eval.
 */
export interface PromptFile {
  name: string;
  /** Относительный путь для логов, например prompts/scoring.md */
  file: string;
  version: number;
  text: string;
}

export function loadPrompt(cfg: AppConfig, name: string, root = process.cwd()): PromptFile {
  const dir = cfg.prompts?.dir ?? 'prompts';
  const relFile = `${dir}/${name}.md`;
  const raw = readFileSync(path.join(root, dir, `${name}.md`), 'utf-8');

  const head = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  let version = 0;
  let text = raw;
  if (head) {
    const vm = head[1].match(/version:\s*(\d+)/);
    if (vm) version = Number(vm[1]);
    text = raw.slice(head[0].length);
  }
  // HTML-комментарии шапки (пометки для людей) в промпт не попадают
  text = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return { name, file: relFile, version, text };
}

/** Подстановка {{key}}-плейсхолдеров. Неизвестный ключ заменяется пустой строкой. */
export function renderPrompt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''));
}
