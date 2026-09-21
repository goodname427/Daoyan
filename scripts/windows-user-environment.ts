import { execFileSync } from 'node:child_process';

type RegistryQuery = (name: string) => string;

const DEFAULT_QUERY: RegistryQuery = (name) =>
  execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export function parseWindowsRegistryValue(output: string): string {
  const valueLine = output
    .split(/\r?\n/u)
    .map((line) => line.match(/\s+REG_(?:EXPAND_)?SZ\s+(.+)$/u)?.[1]?.trim() ?? '')
    .find(Boolean);
  return valueLine ?? '';
}

export function refreshWindowsUserEnvironment(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  options: { platform?: NodeJS.Platform; query?: RegistryQuery } = {},
): NodeJS.ProcessEnv {
  const refreshed = { ...environment };
  if ((options.platform ?? process.platform) !== 'win32') return refreshed;

  const query = options.query ?? DEFAULT_QUERY;
  for (const name of names) {
    if (refreshed[name]?.trim()) continue;
    try {
      const value = parseWindowsRegistryValue(query(name));
      if (value) refreshed[name] = value;
    } catch {
      // Missing optional user-level settings leave the channel disabled.
    }
  }
  return refreshed;
}
