// Loads .env before any other module reads process.env. Every entry point
// (server, migration script) imports this first; ESM caching makes it run once.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '..');

// Externally-set variables (e.g. PORT injected by a process manager) must win
// over .env values, so capture them before loading the file.
const externalPort = process.env.PORT;
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // .env is optional; environment variables may be set externally (e.g. Vercel)
}
if (externalPort) process.env.PORT = externalPort;

// An empty `ANTHROPIC_API_KEY=` line would still occupy its slot in the SDK's
// credential precedence and shadow OAuth-profile auth — drop empty values.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) {
  if (process.env[key] === '') delete process.env[key];
}
