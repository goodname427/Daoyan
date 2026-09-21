import { describe, expect, it, vi } from 'vitest';
import {
  parseWindowsRegistryValue,
  refreshWindowsUserEnvironment,
} from '../scripts/windows-user-environment';

describe('Windows user environment refresh', () => {
  it('parses string values returned by reg.exe', () => {
    expect(
      parseWindowsRegistryValue(
        '\r\nHKEY_CURRENT_USER\\Environment\r\n    DAOYAN_DINGTALK_CLIENT_ID    REG_SZ    ding app id\r\n',
      ),
    ).toBe('ding app id');
  });

  it('fills missing values without overriding the current process environment', () => {
    const query = vi.fn((name: string) => `    ${name}    REG_SZ    registry-${name}\r\n`);
    const result = refreshWindowsUserEnvironment(
      { DAOYAN_DINGTALK_CLIENT_ID: 'process-id' },
      ['DAOYAN_DINGTALK_CLIENT_ID', 'DAOYAN_DINGTALK_CLIENT_SECRET'],
      { platform: 'win32', query },
    );

    expect(result.DAOYAN_DINGTALK_CLIENT_ID).toBe('process-id');
    expect(result.DAOYAN_DINGTALK_CLIENT_SECRET).toBe('registry-DAOYAN_DINGTALK_CLIENT_SECRET');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not query the Windows registry on other platforms', () => {
    const query = vi.fn(() => 'should-not-run');
    const result = refreshWindowsUserEnvironment({}, ['DAOYAN_DINGTALK_CLIENT_ID'], {
      platform: 'linux',
      query,
    });

    expect(result.DAOYAN_DINGTALK_CLIENT_ID).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
