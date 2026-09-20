import type { DWClientDownStream, EventAck } from 'dingtalk-stream';
import { describe, expect, it, vi } from 'vitest';
import {
  DingtalkSecretaryChannel,
  dingtalkConfigFromEnvironment,
} from '../scripts/dingtalk-secretary-channel';
import { externalRequestId, type SecretaryNotice } from '../scripts/secretary-channel';

function downstream(overrides: Record<string, unknown> = {}): DWClientDownStream {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: { messageId: 'stream-1', topic: '/v1.0/im/bot/messages/get' },
    data: JSON.stringify({
      msgId: 'platform-1',
      msgtype: 'text',
      conversationId: 'conversation-1',
      senderStaffId: 'producer-1',
      sessionWebhook: 'https://example.test/session',
      sessionWebhookExpiredTime: 2_000,
      createAt: 1_000,
      robotCode: 'robot-1',
      text: { content: ' 项目现在怎么样？ ' },
      ...overrides,
    }),
  } as unknown as DWClientDownStream;
}

function createHarness() {
  let callback: ((value: DWClientDownStream) => void) | null = null;
  const acknowledge = vi.fn();
  const disconnect = vi.fn();
  const client = {
    registerCallbackListener(_eventId: string, next: (value: DWClientDownStream) => void) {
      callback = next;
      return client;
    },
    registerAllEventListener(_next: (value: DWClientDownStream) => { status: EventAck }) {
      return client;
    },
    connect: vi.fn(async () => undefined),
    disconnect,
    getAccessToken: vi.fn(async () => 'access-token'),
    socketCallBackResponse: acknowledge,
  };
  const fetchImpl = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
  );
  const errors: unknown[] = [];
  const channel = new DingtalkSecretaryChannel(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedSenderIds: ['producer-1'],
      notifyUserId: 'producer-1',
      robotCode: 'robot-1',
    },
    {
      clientFactory: () => client,
      fetchImpl,
      now: () => 1_500,
      onError: (error) => errors.push(error),
    },
  );
  return {
    channel,
    callback: () => {
      if (!callback) throw new Error('callback not registered');
      return callback;
    },
    acknowledge,
    disconnect,
    fetchImpl,
    errors,
  };
}

function notice(correlationId = ''): SecretaryNotice {
  return {
    id: 'notice-1',
    kind: 'intake',
    message: '秘书答复',
    correlationId,
    itemId: correlationId,
    createdAt: '2026-09-20T00:00:00.000Z',
  };
}

describe('DingTalk secretary channel', () => {
  it('is disabled without credentials and rejects unsafe partial configuration', () => {
    expect(dingtalkConfigFromEnvironment({})).toBeNull();
    expect(() => dingtalkConfigFromEnvironment({ DAOYAN_DINGTALK_CLIENT_ID: 'client-id' })).toThrow(
      'CLIENT_SECRET',
    );
    expect(() =>
      dingtalkConfigFromEnvironment({
        DAOYAN_DINGTALK_CLIENT_ID: 'client-id',
        DAOYAN_DINGTALK_CLIENT_SECRET: 'secret',
      }),
    ).toThrow('ALLOWED_SENDER_IDS');
  });

  it('accepts authorized text once and replies to its original session', async () => {
    const harness = createHarness();
    const handler = vi.fn(async () => ({
      requestId: externalRequestId('dingtalk', 'platform-1'),
      accepted: true,
    }));
    await harness.channel.start(handler);

    harness.callback()(downstream());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    harness.callback()(downstream());
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledTimes(2));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'dingtalk',
        senderId: 'producer-1',
        text: '项目现在怎么样？',
      }),
    );
    await harness.channel.publish(notice(externalRequestId('dingtalk', 'platform-1')));
    expect(harness.fetchImpl).toHaveBeenCalledWith(
      'https://example.test/session',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-acs-dingtalk-access-token': 'access-token',
        }),
      }),
    );
    expect(harness.errors).toEqual([]);
  });

  it('ignores unauthorized users and sends unrelated events proactively', async () => {
    const harness = createHarness();
    const handler = vi.fn(async () => ({ requestId: 'unused', accepted: true }));
    await harness.channel.start(handler);

    harness.callback()(downstream({ senderStaffId: 'other-user' }));
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledTimes(1));
    expect(handler).not.toHaveBeenCalled();

    await harness.channel.publish(notice());
    const [url, init] = harness.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        robotCode: 'robot-1',
        userIds: ['producer-1'],
        msgKey: 'sampleText',
      }),
    );
    await harness.channel.stop();
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  it('falls back to a proactive message when the original session reply fails', async () => {
    const harness = createHarness();
    const requestId = externalRequestId('dingtalk', 'platform-1');
    await harness.channel.start(async () => ({ requestId, accepted: true }));
    harness.callback()(downstream());
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledOnce());
    harness.fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await harness.channel.publish(notice(requestId));

    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    expect(harness.fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    );
    expect(harness.errors).toHaveLength(1);
  });

  it('does not acknowledge concurrent redelivery before the inbox write succeeds', async () => {
    const harness = createHarness();
    let rejectFirst!: (error: Error) => void;
    const firstFailure = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let firstAttempt = true;
    const handler = vi.fn(async () => {
      if (firstAttempt) await firstFailure;
      return {
        requestId: externalRequestId('dingtalk', 'platform-1'),
        accepted: true,
      };
    });
    await harness.channel.start(handler);

    harness.callback()(downstream());
    harness.callback()(downstream());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(harness.acknowledge).not.toHaveBeenCalled();
    firstAttempt = false;
    rejectFirst(new Error('disk unavailable'));
    await vi.waitFor(() => expect(harness.errors).toHaveLength(2));
    expect(harness.acknowledge).not.toHaveBeenCalled();

    harness.callback()(downstream());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.acknowledge).toHaveBeenCalledOnce());
  });
});
