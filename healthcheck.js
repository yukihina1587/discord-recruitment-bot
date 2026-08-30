import { statSync } from 'node:fs';

const healthcheckFile = process.env.HEALTHCHECK_FILE ?? '/tmp/discord-bot-ready';
const maxAgeMs = Number(process.env.HEALTHCHECK_MAX_AGE_MS ?? 90_000);

try {
  const ageMs = Date.now() - statSync(healthcheckFile).mtimeMs;
  process.exit(ageMs >= 0 && ageMs <= maxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
