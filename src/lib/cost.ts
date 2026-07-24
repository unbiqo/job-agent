import type { LLMTaskCfg } from './config';
import type { LLMUsage } from './llm/client';

/**
 * Скоринг и письма используют разные модели с разной ценой за токен,
 * поэтому стоимость считаем по ходу вызовов (а не одной формулой в конце прогона
 * по суммарным токенам, как было при единой модели).
 *
 * Задача 1 слоя качества: каждый LLM-вызов логируется с prompt_file,
 * prompt_version, model, токенами и стоимостью — записи копятся в calls[]
 * и попадают в runs.stats.llm_calls.
 */
export interface LLMCallMeta {
  task: string; // scoring | letter | ...
  prompt_file?: string;
  prompt_version?: number;
  model?: string;
}

export interface LLMCallRecord extends LLMCallMeta {
  tokens_in: number;
  tokens_out: number;
  billed_tokens_in: number;
  billed_tokens_out: number;
  cost_usd: number;
  at: string;
}

export interface TokenTally {
  in: number;
  out: number;
  costUsd: number;
  calls: LLMCallRecord[];
}

export function emptyTally(): TokenTally {
  return { in: 0, out: 0, costUsd: 0, calls: [] };
}

/**
 * Стоимость вызова — ТОЛЬКО из billed-токенов (обслуженных платным ключом).
 * На бесплатных ключах billed*=0 → $0, поэтому дайджест не показывает фантомные
 * траты, которых у Google на free tier нет.
 */
export function billedCost(
  usage: Pick<LLMUsage, 'billedInputTokens' | 'billedOutputTokens'>,
  price: LLMTaskCfg,
): number {
  return (
    (usage.billedInputTokens / 1e6) * price.price_in_per_mtok +
    (usage.billedOutputTokens / 1e6) * price.price_out_per_mtok
  );
}

export function addUsage(tally: TokenTally, usage: LLMUsage, price: LLMTaskCfg, meta?: LLMCallMeta): void {
  const cost = billedCost(usage, price);
  tally.in += usage.inputTokens;
  tally.out += usage.outputTokens;
  tally.costUsd += cost;
  if (meta) {
    tally.calls.push({
      ...meta,
      model: meta.model ?? price.model,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
      billed_tokens_in: usage.billedInputTokens,
      billed_tokens_out: usage.billedOutputTokens,
      cost_usd: Number(cost.toFixed(6)),
      at: new Date().toISOString(),
    });
  }
}
