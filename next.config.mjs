import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: root,
  // config/settings.json и prompts/ читаются в рантайме (webhook на Vercel) — включаем в трейсинг
  outputFileTracingIncludes: {
    '/**/*': ['./config/settings.json', './prompts/**/*'],
  },
};

export default nextConfig;
