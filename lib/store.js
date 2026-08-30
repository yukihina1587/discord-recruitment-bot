// シンプルな JSON 永続化ストア。
// data/<name>.json に読み書きするだけの軽量ラッパー。
// （規模が大きくなったら SQLite などに置き換えやすいよう、入り口を1か所に集約しています）
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(__dirname, '..', 'data');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function filePath(name) {
  if (!SAFE_NAME.test(name)) {
    throw new TypeError('Expected a safe store name containing only letters, numbers, "_" or "-"');
  }
  const dataDir = resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
  return { dataDir, path: join(dataDir, `${name}.json`) };
}

// data/<name>.json を読み込む。無ければ fallback を返す。
export function load(name, fallback = {}) {
  const { path } = filePath(name);
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`[store] failed to read store "${name}"`, { cause: err });
  }
}

// data/<name>.json に書き込む（壊れにくいよう一時ファイル経由で置き換え）。
export function save(name, data) {
  const { dataDir, path } = filePath(name);
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const tmp = join(dataDir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch (err) {
    console.error(`[store] ${name} の保存に失敗:`, err);
    return false;
  }
}
