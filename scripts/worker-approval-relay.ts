import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applicationApprovalRequest, type AppApprovalRequest } from './worker-app-approval';
import type { SecretaryChannelHub } from './secretary-channel';

const PIPE = 'DAOYAN_APPROVAL_RELAY_PIPE';
const SECRET = 'DAOYAN_APPROVAL_RELAY_SECRET';
export interface ApprovalRelayEvent {
  id: string;
  status: 'pending' | 'resolved';
  request: AppApprovalRequest;
  url?: string;
  action?: 'accept' | 'decline' | 'cancel';
}

export function withoutApprovalRelay(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean[PIPE];
  delete clean[SECRET];
  return clean;
}

/** Ephemeral permission capabilities are sent directly, never via workspace outbox/state. */
export async function deliverHumanApproval(
  hub: SecretaryChannelHub | null,
  event: ApprovalRelayEvent,
  formUrl: string,
  itemId: string,
) {
  if (!hub || hub.configuredChannelIds().length === 0)
    throw new Error('没有已配置的制作人许可接收通道');
  const result = await hub.publish({
    id: `application-approval-${event.id}`,
    kind: 'application-approval',
    itemId,
    correlationId: `application-approval-${event.id}`,
    createdAt: new Date().toISOString(),
    message: `后台任务 ${itemId} 申请应用许可：${event.request.message}。请在本机打开 ${formUrl} 选择；四分钟未处理会取消。`,
  });
  if (!result.attemptedChannelIds.some((id) => !result.failedChannelIds.includes(id)))
    throw new Error('制作人许可请求投递失败');
}

export async function publishApprovalRelay(
  event: ApprovalRelayEvent,
  environment = process.env,
): Promise<boolean> {
  if (!environment[PIPE] && !environment[SECRET]) return false;
  if (!environment[PIPE] || !environment[SECRET]) throw new Error('Incomplete approval relay');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(environment[PIPE]!);
    const timer = setTimeout(
      () => socket.destroy(new Error('Approval display relay timed out')),
      30_000,
    );
    let response = '';
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ secret: environment[SECRET], event })}\n`),
    );
    socket.on('data', (chunk) => {
      response += String(chunk);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      if (response.trim() === 'ok') resolve();
      else reject(new Error('Approval display relay did not acknowledge the request'));
    });
  });
  return true;
}

/** Form URLs only cross the private pipe into a configured human notification channel. */
export async function startApprovalRelay(options: {
  onPending: (event: ApprovalRelayEvent, formUrl: string, signal: AbortSignal) => Promise<void>;
  onResolved?: (event: ApprovalRelayEvent) => Promise<void>;
}) {
  const secret = randomBytes(32).toString('hex');
  const pipe =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daoyan-approval-${randomUUID()}`
      : resolve(tmpdir(), `daoyan-approval-${randomUUID()}.sock`);
  const pending = new Map<string, ApprovalRelayEvent>();
  const sockets = new Set<Socket>();
  let closed = false;
  const relay = createServer((socket) => {
    const controller = new AbortController();
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      controller.abort();
    });
    let input = '';
    let consumed = false;
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += String(chunk);
      if (input.length > 32_768) {
        socket.destroy();
        return;
      }
      if (consumed || !input.includes('\n')) return;
      consumed = true;
      void (async () => {
        const message = JSON.parse(input.slice(0, input.indexOf('\n'))) as {
          secret: string;
          event: ApprovalRelayEvent;
        };
        const received = Buffer.from(String(message.secret));
        if (received.length !== secret.length || !timingSafeEqual(received, Buffer.from(secret)))
          throw new Error('Invalid relay sender');
        const event = message.event;
        if (
          !/^[0-9a-f-]{36}$/i.test(event.id) ||
          !event.request?.threadId ||
          !event.request?.turnId ||
          !applicationApprovalRequest(event.request, event.request.threadId, event.request.turnId)
        )
          throw new Error('Invalid relay event');
        if (event.status === 'pending') {
          if (
            !/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/\d+$/.test(event.url ?? '') ||
            pending.has(event.id)
          )
            throw new Error('Invalid approval form URL');
          pending.set(event.id, event);
          try {
            await options.onPending(event, event.url!, controller.signal);
            if (controller.signal.aborted)
              throw new Error('Approval sender disconnected during delivery');
          } catch (error) {
            pending.delete(event.id);
            throw error;
          }
        } else if (event.status === 'resolved') {
          const original = pending.get(event.id);
          if (
            !original ||
            original.request.threadId !== event.request.threadId ||
            original.request.turnId !== event.request.turnId ||
            !['accept', 'decline', 'cancel'].includes(event.action ?? '')
          )
            throw new Error('Invalid approval resolution');
          pending.delete(event.id);
          await options.onResolved?.(event);
        } else throw new Error('Invalid approval status');
        socket.end('ok\n');
      })().catch(() => socket.end('error\n'));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once('error', reject);
      relay.listen(pipe, () => resolve());
    });
  } catch (error) {
    relay.close();
    throw error;
  }
  return {
    environment: { [PIPE]: pipe, [SECRET]: secret },
    async close() {
      if (closed) return;
      closed = true;
      pending.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}

export function redactApprovalFormUrls(text: string): string {
  return text.replace(
    /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/\d+/g,
    '[application approval form URL omitted]',
  );
}
