import { readFileSync } from 'node:fs';

export function requireSecret(name, env = process.env) {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();

  if (direct && file) {
    throw new Error(`${name}と${name}_FILEは同時に設定できません`);
  }

  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }

  if (direct) return direct;
  throw new Error(`${name}または${name}_FILEが設定されていません`);
}

export function requireId(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value || !/^\d{17,20}$/.test(value)) {
    throw new Error(`${name}には17〜20桁のDiscord IDを設定してください`);
  }
  return value;
}
