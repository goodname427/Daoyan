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
  ) => void | Promise<void>;
}) {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let pending: {
    request: AppApprovalRequest;
    finish: (action: AppApprovalDecision['action']) => void;
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
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>道衍工作流 · 应用许可</title><style>body{font:16px system-ui;background:#171a20;color:#eee;max-width:760px;margin:48px auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#242933;padding:20px}button{font:inherit;margin:8px;padding:12px 20px;cursor:pointer}</style><h1>后台 Agent 请求应用许可</h1><p>${escapeHtml(request.message)}</p><p>这是工具实际发出的应用许可请求。只允许本次请求，不修改全局许可，也不批准其他操作。</p><pre>${escapeHtml(JSON.stringify({ app: request._meta.tool_params, agent: request.threadId, turn: request.turnId, server: request.serverName, details: request._meta }, null, 2))}</pre><form method="post"><button name="action" value="accept">允许本次请求</button><button name="action" value="decline">拒绝</button><button name="action" value="cancel">取消</button></form></html>`,
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
    const action = new URLSearchParams(body).get('action');
    if (!['accept', 'decline', 'cancel'].includes(action ?? '')) {
      res.writeHead(400).end('Invalid decision');
      return;
    }
    if (pending !== current) {
      res.writeHead(410).end('请求已结束；此选择没有应用到其他请求。');
      return;
    }
    current.finish(action as AppApprovalDecision['action']);
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
          finish: (action: AppApprovalDecision['action']) => {
            if (pending !== entry) return;
            pending = null;
            clearTimeout(timer);
            announcement
              .catch(() => undefined)
              .then(() => options.onResolved?.(request, action))
              .then(() => resolve({ action, content: action === 'accept' ? {} : null }), reject);
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
