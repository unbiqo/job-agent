import 'dotenv/config';
import { loadFileConfig } from '../src/lib/config';
import { getDb, OWNER_ID } from '../src/lib/db';
import { loadProfile } from '../src/lib/profile';

/**
 * Заливает локальную базу знаний (config/profile/*) в таблицу profile_facts.
 * Личные файлы не коммитятся в git, поэтому воркер в GitHub Actions читает профиль из БД.
 */
async function main() {
  const cfg = loadFileConfig();
  const profile = loadProfile(cfg);
  const db = getDb();

  const { error: delErr } = await db.from('profile_facts').delete().eq('user_id', OWNER_ID);
  if (delErr) throw new Error(delErr.message);

  const rows = [
    ...Object.entries(profile.resumes).map(([key, text]) => ({
      user_id: OWNER_ID,
      kind: 'resume',
      title: key,
      data: { text },
    })),
    ...profile.projects.map((p) => ({ user_id: OWNER_ID, kind: 'project', title: p.name, data: p })),
    ...(profile.notes ? [{ user_id: OWNER_ID, kind: 'note', title: 'notes', data: { text: profile.notes } }] : []),
  ];
  if (rows.length) {
    const { error } = await db.from('profile_facts').insert(rows);
    if (error) throw new Error(error.message);
  }
  console.log(
    `✅ Профиль загружен: резюме ${Object.keys(profile.resumes).length}, проектов ${profile.projects.length}, заметки: ${profile.notes ? 'да' : 'нет'}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
