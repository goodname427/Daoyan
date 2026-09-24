import { describe, expect, it, vi } from 'vitest';
import {
  externalRequestId,
  SecretaryChannelHub,
  type SecretaryChannel,
  type SecretaryInboundHandler,
  type SecretaryNotice,
} from '../scripts/secretary-channel';
import { WebhookSecretaryChannel } from '../scripts/webhook-secretary-channel';
import { secretaryChannelHubFromEnvironment } from '../scripts/secretary-channels';

const notice: SecretaryNotice = {
  id: 'notice-1',
  kind: 'intake',
  message: '已收到',
  correlationId: 'request-1',
  itemId: 'request-1',
  createdAt: '2026-09-20T00:00:00.000Z',
};

function fakeChannel(id: string, overrides: Partial<SecretaryChannel> = {}): SecretaryChannel {
  return {
    id,
    start: async (_handler: SecretaryInboundHandler) => undefined,
    publish: async (_notice: SecretaryNotice) => undefined,
    stop: async () => undefined,
    ...overrides,
  };
}

describe('secretary communication channels', () => {
  it('never configures external channels for a local-only guard, even with real channel settings', async () => {
    const hub = await secretaryChannelHubFromEnvironment(
      {
        DAOYAN_SECRETARY_LOCAL_ONLY: '1',
        DAOYAN_SECRETARY_WEBHOOK_URL: 'https://example.test/hook',
        DAOYAN_DINGTALK_CLIENT_ID: 'configured-client',
        DAOYAN_DINGTALK_CLIENT_SECRET: 'configured-secret',
        DAOYAN_DINGTALK_ALLOWED_SENDER_IDS: 'producer',
      },
      { info: vi.fn(), error: vi.fn() },
    );

    await hub.start(async () => ({ requestId: 'request', accepted: true }));
    expect(hub.configuredChannelIds()).toEqual([]);
    expect(hub.activeChannelIds()).toEqual([]);
    expect(await hub.publish(notice)).toEqual({
      attemptedChannelIds: [],
      failedChannelIds: [],
    });
    await hub.stop();
  });

  it('keeps configured channels available for the real guard', async () => {
    const hub = await secretaryChannelHubFromEnvironment(
      { DAOYAN_SECRETARY_WEBHOOK_URL: 'https://example.test/hook' },
      { info: vi.fn(), error: vi.fn() },
    );

    expect(hub.configuredChannelIds()).toEqual(['webhook:generic']);
  });

  it('derives stable platform request ids without exposing the platform message id', () => {
    expect(externalRequestId('dingtalk', 'message-1')).toBe(
      externalRequestId('dingtalk', 'message-1'),
    );
    expect(externalRequestId('dingtalk', 'message-1')).not.toBe(
      externalRequestId('dingtalk', 'message-2'),
    );
    expect(externalRequestId('dingtalk', 'message-1')).not.toContain('message-1');
  });

  it('isolates failed channels and only publishes through channels that started', async () => {
    const publish = vi.fn(async () => undefined);
    const failedStop = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    const hub = new SecretaryChannelHub(
      [
        fakeChannel('failed', {
          start: async () => {
            throw new Error('offline');
          },
          publish: vi.fn(async () => undefined),
          stop: failedStop,
        }),
        fakeChannel('ready', { publish }),
      ],
      logger,
    );

    await hub.start(async () => ({ requestId: 'request', accepted: true }));
    await hub.publish(notice);
    await hub.stop();

    expect(publish).toHaveBeenCalledWith(notice);
    expect(failedStop).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed 启动失败'));
  });

  it('keeps webhook formatting inside the webhook adapter', async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const channel = new WebhookSecretaryChannel({
      url: 'https://example.test/hook',
      kind: 'dingtalk',
      fetchImpl,
    });

    await channel.publish(notice);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      msgtype: 'text',
      text: { content: '已收到' },
    });
  });

  it('bounds a stuck publisher and reports it for durable retry', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const hub = new SecretaryChannelHub(
      [
        fakeChannel('stuck', {
          publish: async () => await new Promise<void>(() => undefined),
        }),
      ],
      logger,
      { publishTimeoutMs: 5 },
    );
    await hub.start(async () => ({ requestId: 'request', accepted: true }));

    const result = await hub.publish(notice);

    expect(result).toEqual({
      attemptedChannelIds: ['stuck'],
      failedChannelIds: ['stuck'],
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('发送失败'));
  });

  it('retains configured channel identity and can recover a failed start', async () => {
    let unavailable = true;
    const channel = fakeChannel('recovering', {
      start: async () => {
        if (unavailable) throw new Error('offline');
      },
    });
    const hub = new SecretaryChannelHub([channel], { info: vi.fn(), error: vi.fn() });

    await hub.start(async () => ({ requestId: 'request', accepted: true }));
    expect(hub.configuredChannelIds()).toEqual(['recovering']);
    expect(hub.activeChannelIds()).toEqual([]);

    unavailable = false;
    await hub.retryInactive();
    expect(hub.activeChannelIds()).toEqual(['recovering']);
  });
});
