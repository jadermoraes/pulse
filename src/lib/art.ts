/**
 * Art placeholder colour helpers.
 * Maps any string (item id, user name, etc.) to one of the ART_CLASSES CSS classes
 * using a stable djb2-style hash.
 */
export const ART_CLASSES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] as const;

export function artClass(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  return ART_CLASSES[Math.abs(hash) % ART_CLASSES.length];
}
