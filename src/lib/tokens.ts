import type { SupabaseClient } from '@supabase/supabase-js';
import { seal, unseal } from './crypto';
import { HHClient, hhRefreshToken, hhUserAgent, type HHTokenSet } from './hh';
import { OWNER_ID } from './db';

export async function saveHHTokens(db: SupabaseClient, tokens: HHTokenSet): Promise<void> {
  const { error } = await db.from('hh_tokens').upsert({
    user_id: OWNER_ID,
    access_token: seal(tokens.access_token),
    refresh_token: seal(tokens.refresh_token),
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error('hh_tokens upsert: ' + error.message);
}

/**
 * Возвращает действующий access token. hh позволяет обновлять токен только после
 * его истечения, поэтому refresh делаем лишь когда expires_at в прошлом.
 */
export async function getHHAccessToken(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.from('hh_tokens').select('*').eq('user_id', OWNER_ID).maybeSingle();
  if (error) throw new Error('hh_tokens select: ' + error.message);
  if (!data) throw new Error('Токены hh не найдены — выполните авторизацию: npm run hh-auth');
  const expiresAt = Date.parse(data.expires_at as string);
  if (Date.now() < expiresAt) return unseal(data.access_token as string);

  const fresh = await hhRefreshToken(unseal(data.refresh_token as string));
  await saveHHTokens(db, {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || unseal(data.refresh_token as string),
    expires_in: fresh.expires_in,
  });
  return fresh.access_token;
}

export async function getAuthedHH(db: SupabaseClient): Promise<HHClient> {
  const token = await getHHAccessToken(db);
  return new HHClient({ userAgent: hhUserAgent(), accessToken: token });
}

/**
 * Принудительный refresh токена (v1.1): используется health-check при 401, когда
 * токен формально не истёк, но hh его отверг. Обновляет и персистит токен.
 */
export async function forceRefreshHH(db: SupabaseClient): Promise<HHClient> {
  const { data, error } = await db.from('hh_tokens').select('*').eq('user_id', OWNER_ID).maybeSingle();
  if (error) throw new Error('hh_tokens select: ' + error.message);
  if (!data) throw new Error('Токены hh не найдены — выполните авторизацию: npm run hh-auth');
  const refresh = unseal(data.refresh_token as string);
  const fresh = await hhRefreshToken(refresh);
  await saveHHTokens(db, {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || refresh,
    expires_in: fresh.expires_in,
  });
  return new HHClient({ userAgent: hhUserAgent(), accessToken: fresh.access_token });
}
