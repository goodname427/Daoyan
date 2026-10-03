import { describe, expect, it } from 'vitest';
import {
  applicationApprovalRequest,
  applicationApprovalPersistence,
  startApplicationApprovalServer,
  taskNeedsApplicationApproval,
} from '../scripts/worker-app-approval';
import type { PlannedTask } from '../scripts/agent-routing';

const request = {
  threadId: 'worker-1',
  turnId: 'turn-1',
  serverName: 'node_repl',
  mode: 'openai/form',
  message: 'Allow Codex to use <electron>?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    connector_id: 'computer-use',
    codex_approval_kind: 'mcp_tool_call',
    tool_params: { app: 'electron' },
  },
};

describe('workflow application approvals', () => {
  it('routes a required real play contract, but leaves documentation and E2E-only work non-interactive', () => {
    const task = {
      type: 'test',
      objective: '在独立 Electron 窗口亲自操作三術',
      verification: [],
      deliverables: [],
    } as unknown as PlannedTask;
    expect(taskNeedsApplicationApproval(task)).toBe(true);
    expect(taskNeedsApplicationApproval({ ...task, type: 'documentation' })).toBe(false);
    expect(
      taskNeedsApplicationApproval({
        ...task,
        objective: '回归',
        verification: ['npm run test:e2e'],
      }),
    ).toBe(false);
  });

  it('rejects cross-thread, cross-turn, non-native, audio and nonempty form requests', () => {
    expect(applicationApprovalRequest(request, 'worker-1', 'turn-1')).toEqual(request);
    for (const changed of [
      { ...request, threadId: 'other' },
      { ...request, turnId: 'other' },
      { ...request, serverName: 'untrusted' },
      { ...request, mode: 'url' },
      {
        ...request,
        requestedSchema: { type: 'object', properties: { password: { type: 'string' } } },
      },
      { ...request, _meta: { ...request._meta, tool_params: { app: 'computer-audio' } } },
    ])
      expect(applicationApprovalRequest(changed, 'worker-1', 'turn-1')).toBeNull();
  });

  it('holds the request, escapes content, rejects cross-origin and invalid decisions, and cannot replay acceptance', async () => {
    let url = '';
    let announce!: () => void;
    const announced = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const host = await startApplicationApprovalServer({
      onPending: (value) => {
        url = value;
        announce();
      },
    });
    try {
      let resolved = false;
      const decision = host.request(request).then((result) => {
        resolved = true;
        return result;
      });
      await announced;
      const origin = new URL(url).origin;
      expect(resolved).toBe(false);
      const page = await (await fetch(url)).text();
      expect(page).toContain('&lt;electron&gt;');
      expect(page).not.toContain('Always allow');
      const post = (body: string, source = origin) =>
        fetch(url, {
          method: 'POST',
          headers: { Origin: source, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
      expect((await post('action=accept', 'https://evil.invalid')).status).toBe(403);
      expect((await post('action=always')).status).toBe(400);
      expect((await post('action=accept-always')).status).toBe(400);
      expect(resolved).toBe(false);
      expect((await post('action=accept')).status).toBe(200);
      expect(await decision).toEqual({ action: 'accept', content: {} });
      expect((await post('action=accept')).status).toBe(410);
    } finally {
      await host.close();
    }
  });

  it.each(['always', 'session'] as const)(
    'returns native %s persistence only after the human chooses it',
    async (persist) => {
      let announce!: (url: string) => void;
      const announced = new Promise<string>((resolve) => {
        announce = resolve;
      });
      const resolutions: unknown[] = [];
      const host = await startApplicationApprovalServer({
        onPending: announce,
        onResolved: (_request, action, scope) => {
          resolutions.push({ action, scope });
        },
      });
      try {
        const pending = host.request({
          ...request,
          _meta: { ...request._meta, persist: [persist] },
        });
        const url = await announced;
        const page = await (await fetch(url)).text();
        expect(page).toContain(`value="accept-${persist}"`);
        const other = persist === 'always' ? 'session' : 'always';
        expect(page).not.toContain(`value="accept-${other}"`);
        expect(resolutions).toEqual([]);
        const post = (selection: string) =>
          fetch(url, {
            method: 'POST',
            headers: {
              Origin: new URL(url).origin,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `action=${selection}`,
          });
        expect((await post(`accept-${other}`)).status).toBe(400);
        expect((await post(`accept-${persist}`)).status).toBe(200);
        expect(await pending).toEqual({ action: 'accept', content: {}, _meta: { persist } });
        expect(resolutions).toEqual([{ action: 'accept', scope: persist }]);
        expect((await post(`accept-${persist}`)).status).toBe(410);
      } finally {
        await host.close();
      }
    },
  );

  it('does not invent native persistence support from malformed or missing metadata', () => {
    for (const persist of [
      undefined,
      true,
      'all',
      [],
      ['always', 'all'],
      ['always', 'session', 'always'],
    ])
      expect(
        applicationApprovalPersistence({ ...request, _meta: { ...request._meta, persist } }),
      ).toEqual([]);
    expect(
      applicationApprovalPersistence({
        ...request,
        _meta: { ...request._meta, persist: 'always' },
      }),
    ).toEqual(['always']);
  });

  it.each(['decline', 'cancel'] as const)('preserves a real %s decision', async (action) => {
    let announce!: (url: string) => void;
    const announced = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const host = await startApplicationApprovalServer({ onPending: announce });
    try {
      const pending = host.request(request);
      const url = await announced;
      await fetch(url, {
        method: 'POST',
        headers: {
          Origin: new URL(url).origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `action=${action}`,
      });
      expect(await pending).toEqual({ action, content: null });
    } finally {
      await host.close();
    }
  });

  it('cancels rather than approving after timeout or host shutdown', async () => {
    const host = await startApplicationApprovalServer({ timeoutMs: 15, onPending: () => {} });
    expect(await host.request(request)).toEqual({ action: 'cancel', content: null });
    const pending = host.request(request);
    await host.close();
    expect(await pending).toEqual({ action: 'cancel', content: null });
  });
});
