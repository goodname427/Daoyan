/** Read only the first contract object; runtime guidance never expands its scope. */
export function formalTaskContract(direction: string): {
  value: Record<string, unknown>;
  start: number;
  end: number;
} | null {
  if (!/^\[formal-stage-(?:deliverable|verification):[a-z-]+:[a-zA-Z0-9_-]+\]/u.test(direction))
    return null;
  const prefix = '只完成本合同：\n';
  const marker = direction.indexOf(prefix);
  const boundary =
    marker < 0 ? -1 : direction.indexOf('\n直接前驱的有限证据索引：', marker + prefix.length);
  if (boundary < 0) return null;
  let start = marker + prefix.length;
  while (start < boundary && /\s/u.test(direction[start])) start++;
  if (direction[start] !== '{') return null;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let offset = start; offset < boundary; offset++) {
    const char = direction[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(direction.slice(start, offset + 1));
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        return { value: value as Record<string, unknown>, start, end: offset + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}
