import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeConfig } from '../src/lib/config';
import { HHError } from '../src/lib/hh';
import {
  canSearch,
  canSend,
  checkOAuth,
  checkSearch,
  classifyHHError,
  deriveMode,
  modeChangeMessage,
  resolveRunMode,
  type OAuthClient,
  type SearchClient,
} from '../src/lib/hh-health';

const forbidden403 = new HHError(403, JSON.stringify({ errors: [{ type: 'forbidden' }] }));
const unauthorized401 = new HHError(401, JSON.stringify({ errors: [{ type: 'oauth', value: 'token_expired' }] }));
const server503 = new HHError(503, 'upstream error');

test('classifyHHError: 403 forbidden = IP-блок', () => {
  assert.equal(classifyHHError(forbidden403), 'ip_block');
});

test('classifyHHError: 401 = протухший токен, 5xx = временная, сеть = временная', () => {
  assert.equal(classifyHHError(unauthorized401), 'expired_token');
  assert.equal(classifyHHError(server503), 'temporary');
  assert.equal(classifyHHError(new Error('fetch failed')), 'temporary');
});

// Тест #1: health-check классифицирует 403 forbidden как IP-блок и ретраит с токеном
test('checkSearch: при 403 IP-блоке повторяет запрос с OAuth-токеном', async () => {
  let publicCalls = 0;
  let authedCalls = 0;
  const pub: SearchClient = {
    async searchVacancies() {
      publicCalls++;
      throw forbidden403;
    },
  };
  const authed: SearchClient = {
    async searchVacancies() {
      authedCalls++;
      return { items: [] };
    },
  };
  const res = await checkSearch(pub, authed);
  assert.deepEqual(res, { ok: true, usedOAuth: true });
  assert.equal(publicCalls, 1);
  assert.equal(authedCalls, 1);
});

test('checkSearch: публичный поиск работает — OAuth не трогаем', async () => {
  const pub: SearchClient = { async searchVacancies() { return { items: [] }; } };
  const res = await checkSearch(pub, null);
  assert.deepEqual(res, { ok: true, usedOAuth: false });
});

test('checkOAuth: 401 → одна попытка refresh, затем ok', async () => {
  let refreshed = 0;
  const stale: OAuthClient = { async getMyResumes() { throw unauthorized401; } };
  const fresh: OAuthClient = { async getMyResumes() { return { items: [] }; } };
  const res = await checkOAuth(stale, async () => {
    refreshed++;
    return fresh;
  });
  assert.equal(res.ok, true);
  assert.equal(res.refreshed, true);
  assert.equal(refreshed, 1);
});

test('deriveMode / canSend / canSearch', () => {
  assert.equal(deriveMode(true, true), 'FULL');
  assert.equal(deriveMode(true, false), 'NO_OAUTH');
  assert.equal(deriveMode(false, true), 'FALLBACK');
  assert.equal(canSend('FULL'), true);
  assert.equal(canSend('NO_OAUTH'), false);
  assert.equal(canSearch('NO_OAUTH'), true);
  assert.equal(canSearch('FALLBACK'), false);
});

// Тест #5: возврат в FULL автоматический
test('resolveRunMode: оба health-check проходят → FULL (авто-возврат из деградации)', async () => {
  const okClient = {
    async searchVacancies() { return { items: [] }; },
    async getMyResumes() { return { items: [] }; },
  } as unknown as import('../src/lib/hh').HHClient;
  const cfg = { hh: { mode: 'auto' } } as unknown as RuntimeConfig;
  const res = await resolveRunMode({ cfg, hhPublic: okClient, hhAuthed: okClient });
  assert.equal(res.mode, 'FULL');
});

test('modeChangeMessage: уведомляет при смене и молчит без изменения', () => {
  assert.equal(modeChangeMessage(null, 'FULL'), null);
  assert.equal(modeChangeMessage('FULL', 'FULL'), null);
  const msg = modeChangeMessage('NO_OAUTH', 'FULL');
  assert.ok(msg && msg.includes('FULL'));
  assert.ok(modeChangeMessage('FULL', 'NO_OAUTH')?.includes('NO_OAUTH'));
});

test('resolveRunMode: forced hh.mode перекрывает детект', async () => {
  const throwing = {
    async searchVacancies() { throw server503; },
    async getMyResumes() { throw server503; },
  } as unknown as import('../src/lib/hh').HHClient;
  const cfg = { hh: { mode: 'no_oauth' } } as unknown as RuntimeConfig;
  const res = await resolveRunMode({ cfg, hhPublic: throwing, hhAuthed: throwing });
  assert.equal(res.mode, 'NO_OAUTH');
  assert.equal(res.sendClient, null);
});
