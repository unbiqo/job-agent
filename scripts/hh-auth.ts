import 'dotenv/config';
import { getDb } from '../src/lib/db';
import { HHClient, hhAuthorizeUrl, hhExchangeCode, hhUserAgent } from '../src/lib/hh';
import { saveHHTokens } from '../src/lib/tokens';

/**
 * Одноразовая OAuth-авторизация владельца на hh:
 *   npm run hh-auth            → печатает URL авторизации
 *   npm run hh-auth -- <code>  → обменивает code на токены, сохраняет в Supabase,
 *                                печатает список resume_id для config/settings.json
 */
async function main() {
  const code = process.argv[2];
  if (!code) {
    console.log('1) Откройте в браузере и авторизуйтесь на hh:\n');
    console.log('   ' + hhAuthorizeUrl());
    console.log('\n2) После редиректа скопируйте параметр ?code=... из адресной строки');
    console.log('3) Запустите: npm run hh-auth -- <code>');
    return;
  }
  const tokens = await hhExchangeCode(code);
  await saveHHTokens(getDb(), tokens);
  console.log('✅ Токены hh сохранены в Supabase (таблица hh_tokens).');

  const hh = new HHClient({ userAgent: hhUserAgent(), accessToken: tokens.access_token });
  const { items } = await hh.getMyResumes();
  console.log('\nВаши резюме на hh — подставьте id в config/settings.json → scoring.resume_versions.*.hh_resume_id:');
  for (const r of items) console.log(`  ${r.id}  —  ${r.title}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
