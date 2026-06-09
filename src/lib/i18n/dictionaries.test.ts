import { describe, it, expect } from 'vitest';
import en from './en.json';
import ptBR from './pt-BR.json';

/** Recursively collect the dotted key paths of every leaf (string) in a dictionary. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...leafKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('i18n dictionaries', () => {
  const enKeys = leafKeys(en as Record<string, unknown>);
  const ptKeys = leafKeys(ptBR as Record<string, unknown>);

  it('pt-BR has exactly the same key set as en (no missing/extra translations)', () => {
    const missingInPt = enKeys.filter((k) => !ptKeys.includes(k));
    const extraInPt = ptKeys.filter((k) => !enKeys.includes(k));
    expect(missingInPt, `Keys missing in pt-BR: ${missingInPt.join(', ')}`).toEqual([]);
    expect(extraInPt, `Keys in pt-BR not present in en: ${extraInPt.join(', ')}`).toEqual([]);
  });

  it('no empty string values in either dictionary', () => {
    const emptyIn = (obj: Record<string, unknown>, label: string) => {
      const walk = (o: Record<string, unknown>, prefix = ''): string[] => {
        const bad: string[] = [];
        for (const [k, v] of Object.entries(o)) {
          const path = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object') bad.push(...walk(v as Record<string, unknown>, path));
          else if (typeof v === 'string' && v.trim() === '') bad.push(`${label}:${path}`);
        }
        return bad;
      };
      return walk(obj);
    };
    expect([
      ...emptyIn(en as Record<string, unknown>, 'en'),
      ...emptyIn(ptBR as Record<string, unknown>, 'pt-BR')
    ]).toEqual([]);
  });
});
