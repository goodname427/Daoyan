import { describe, expect, it } from 'vitest';
import {
  getProcessIdentity,
  isOwnedProcessAlive,
  isProcessAlive,
} from '../scripts/process-identity';

describe('process identity', () => {
  it('recognizes the current process by pid and start identity', () => {
    const identity = getProcessIdentity(process.pid);

    expect(identity).not.toBe('');
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isOwnedProcessAlive(process.pid, identity)).toBe(true);
  });

  it('rejects stale identities and invalid process ids', () => {
    const identity = getProcessIdentity(process.pid);

    expect(isOwnedProcessAlive(process.pid, `${identity}-stale`)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(getProcessIdentity(-1)).toBe('');
  });
});
