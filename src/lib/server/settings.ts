import type { DB } from './db';

/** Read a settings value by key, or null if unset. */
export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare('select value from settings where key=?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

/** Upsert a settings value. */
export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'insert into settings (key,value) values (?,?) on conflict(key) do update set value=excluded.value'
  ).run(key, value);
}
