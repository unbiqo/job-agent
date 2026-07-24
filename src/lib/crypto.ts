import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromEnv(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}

/** Шифрует строку для хранения в БД. Без TOKEN_ENCRYPTION_KEY падаем в plain (только для локальной отладки). */
export function seal(plain: string): string {
  const key = keyFromEnv();
  if (!key) return 'plain:' + plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function unseal(sealed: string): string {
  if (sealed.startsWith('plain:')) return sealed.slice('plain:'.length);
  const [tag0, iv, authTag, data] = sealed.split(':');
  if (tag0 !== 'enc' || !iv || !authTag || !data) throw new Error('Некорректный формат зашифрованного значения');
  const key = keyFromEnv();
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY нужен для расшифровки сохранённых токенов');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
