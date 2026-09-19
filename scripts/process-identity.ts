import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ownershipCache = new Map<string, { alive: boolean; checkedAt: number }>();

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getProcessIdentity(pid: number): string {
  if (!isProcessAlive(pid)) return '';
  try {
    if (process.platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()`;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', windowsHide: true },
      );
      return result.status === 0 ? result.stdout.trim() : '';
    }
    if (process.platform === 'linux') {
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterName = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return afterName[19] ? `${bootId}:${afterName[19]}` : '';
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

export function isOwnedProcessAlive(pid: number, identity: string, cacheMs = 5_000): boolean {
  if (!identity) return false;
  const key = `${pid}:${identity}`;
  const cached = ownershipCache.get(key);
  if (cached && Date.now() - cached.checkedAt <= cacheMs) return cached.alive;
  const alive = getProcessIdentity(pid) === identity;
  ownershipCache.set(key, { alive, checkedAt: Date.now() });
  return alive;
}

export async function waitForProcessIdentity(pid: number, timeoutMs = 1_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    const identity = getProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  return '';
}
