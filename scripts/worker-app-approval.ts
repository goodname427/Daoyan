import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PlannedTask } from './agent-routing';

/** Legacy contracts already name real app operation; paperwork/E2E alone do not need a UI host. */
export function taskNeedsApplicationApproval(task: PlannedTask): boolean {
  if (task.type !== 'implementation' && task.type !== 'test') return false;
  return /(?:实玩|实际应用|实际体验|亲自操作|真实页面操作|真实玩家操作|computer-use|Electron)/iu.test(
    [task.objective, ...task.deliverables, ...task.verification].join('\n'),
  );
}

export interface AppApprovalRequest {
  threadId: string;
  turnId: string;
  serverName: string;
  mode: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

export interface AppApprovalDecision {
  action: 'accept' | 'decline' | 'cancel';
  content: Record<string, unknown> | null;
  _meta?: { persist: 'session' | 'always' };
}

/** Native elicitation advertises the persistence choices it actually supports. */
export function applicationApprovalPersistence(
  request: AppApprovalRequest,
): ('session' | 'always')[] {
  const value = request._meta.persist;
  const choices = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(choices) ||
    !choices.length ||
    choices.length > 2 ||
    !choices.every((choice) => choice === 'session' || choice === 'always')
  )
    return [];
  return [...new Set(choices)] as ('session' | 'always')[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Only render the actual, empty Computer Use app-permission form. No general OAuth/form relay. */
export function applicationApprovalRequest(
  value: unknown,
  threadId: string,
  turnId: string,
): AppApprovalRequest | null {
  if (!record(value) || !record(value._meta) || !record(value.requestedSchema)) return null;
  const meta = value._meta;
  const schema = value.requestedSchema;
  if (
    value.threadId !== threadId ||
    value.turnId !== turnId ||
    value.serverName !== 'node_repl' ||
    !['form', 'openai/form', 'openaiForm'].includes(String(value.mode)) ||
    typeof value.message !== 'string' ||
    meta.connector_id !== 'computer-use' ||
    meta.codex_approval_kind !== 'mcp_tool_call' ||
    !record(meta.tool_params) ||
    typeof meta.tool_params.app !== 'string' ||
    !['electron', 'electron.exe'].includes(meta.tool_params.app.toLowerCase()) ||
    meta.codex_sensitive_action !== undefined ||
    meta.codex_requires_user_input !== undefined ||
    schema.type !== 'object' ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.length)) ||
    (schema.properties !== undefined &&
      (!record(schema.properties) || Object.keys(schema.properties).length))
  )
    return null;
  return value as unknown as AppApprovalRequest;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

/** Decisions stay in this process, never in model-writable decision files. */
export async function startApplicationApprovalServer(options: {
  timeoutMs?: number;
  onPending: (url: string, request: AppApprovalRequest) => void | Promise<void>;
  onResolved?: (
    request: AppApprovalRequest,
    action: AppApprovalDecision['action'],
    persist?: 'session' | 'always',
  ) => void | Promise<void>;
}) {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let pending: {
    request: AppApprovalRequest;
    finish: (action: AppApprovalDecision['action'], persist?: 'session' | 'always') => void;
  } | null = null;
  let sequence = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.headers.host !== origin.slice('http://'.length) ||
      req.url !== `/${token}/${sequence}`
    ) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!pending) {
      res.writeHead(410).end('请求已结束；没有待审批操作。');
      return;
    }
    const current = pending;
    if (req.method === 'GET') {
      const request = pending.request;
      const choices = applicationApprovalPersistence(request);
      const persistenceButtons = choices
        .map(
          (choice) =>
            `<button name="action" value="accept-${choice}">${choice === 'always' ? '始终允许此应用' : '本会话允许'}</button>`,
        )
        .join('');
      const explanation = choices.includes('always')
        ? '选择“始终允许此应用”会向原生 Computer Use 请求保存应用许可；是否在后续任务生效须由对应入口实际验证。许可按工具返回的应用标识生效；electron.exe 标识适用于 Electron 应用，不区分游戏目录。官方提供设置 → Computer Use 的撤销入口，具体显示以当前安装版本为准。'
        : '只显示工具实际支持的许可范围；本次允许不会保存未来应用许可。';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>道衍工作流 · 应用许可</title><style>body{font:16px system-ui;background:#171a20;color:#eee;max-width:760px;margin:48px auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#242933;padding:20px}button{font:inherit;margin:8px;padding:12px 20px;cursor:pointer}</style><h1>后台 Agent 请求应用许可</h1><p>${escapeHtml(request.message)}</p><p>${explanation}</p><pre>${escapeHtml(JSON.stringify({ app: request._meta.tool_params, agent: request.threadId, turn: request.turnId, server: request.serverName, details: request._meta }, null, 2))}</pre><form method="post">${persistenceButtons}<button name="action" value="accept">允许本次请求</button><button name="action" value="decline">拒绝</button><button name="action" value="cancel">取消</button></form></html>`,
      );
      return;
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/x-www-form-urlencoded'
    ) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 128) {
        res.writeHead(413).end('Too large');
        return;
      }
    }
    const selection = new URLSearchParams(body).get('action');
    const persist =
      selection === 'accept-always'
        ? 'always'
        : selection === 'accept-session'
          ? 'session'
          : undefined;
    const action = persist ? 'accept' : selection;
    if (persist && !applicationApprovalPersistence(current.request).includes(persist)) {
      res.writeHead(400).end('Unsupported persistence');
      return;
    }
    if (!['accept', 'decline', 'cancel'].includes(action ?? '')) {
      res.writeHead(400).end('Invalid decision');
      return;
    }
    if (pending !== current) {
      res.writeHead(410).end('请求已结束；此选择没有应用到其他请求。');
      return;
    }
    current.finish(action as AppApprovalDecision['action'], persist);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('已记录你的选择，可以返回道衍聊天。');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    request(request: AppApprovalRequest): Promise<AppApprovalDecision> {
      if (pending) return Promise.reject(new Error('Already waiting for an app approval'));
      sequence += 1;
      return new Promise((resolve, reject) => {
        let announcement = Promise.resolve();
        const timer = setTimeout(() => entry.finish('cancel'), options.timeoutMs ?? 240_000);
        const entry = {
          request,
          finish: (action: AppApprovalDecision['action'], persist?: 'session' | 'always') => {
            if (pending !== entry) return;
            pending = null;
            clearTimeout(timer);
            announcement
              .catch(() => undefined)
              .then(() => options.onResolved?.(request, action, persist))
              .then(
                () =>
                  resolve({
                    action,
                    content: action === 'accept' ? {} : null,
                    ...(persist ? { _meta: { persist } } : {}),
                  }),
                reject,
              );
          },
        };
        pending = entry;
        announcement = Promise.resolve().then(() =>
          options.onPending(`${origin}/${token}/${sequence}`, request),
        );
        void announcement.catch((error) => {
          clearTimeout(timer);
          if (pending === entry) pending = null;
          reject(error);
        });
      });
    },
    async close() {
      pending?.finish('cancel');
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
