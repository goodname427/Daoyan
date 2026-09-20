import {
  DWClient,
  EventAck,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage,
} from 'dingtalk-stream';
import {
  externalRequestId,
  type SecretaryChannel,
  type SecretaryInboundHandler,
  type SecretaryNotice,
} from './secretary-channel';

const PROACTIVE_MESSAGE_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

export interface DingtalkSecretaryChannelConfig {
  clientId: string;
  clientSecret: string;
  allowedSenderIds: string[];
  notifyUserId: string;
  robotCode: string;
}

interface DingtalkStreamClient {
  registerCallbackListener(
    eventId: string,
    callback: (value: DWClientDownStream) => void,
  ): DingtalkStreamClient;
  registerAllEventListener(
    callback: (value: DWClientDownStream) => { status: EventAck },
  ): DingtalkStreamClient;
  connect(): Promise<void>;
  disconnect(): void;
  getAccessToken(): Promise<string>;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

interface PendingReply {
  sessionWebhook: string;
  expiresAt: number;
}

export interface DingtalkSecretaryChannelOptions {
  fetchImpl?: typeof fetch;
  clientFactory?: (config: DingtalkSecretaryChannelConfig) => DingtalkStreamClient;
  now?: () => number;
  onError?: (error: unknown) => void;
  startTimeoutMs?: number;
}

function required(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function dingtalkConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DingtalkSecretaryChannelConfig | null {
  const clientId = required(environment.DAOYAN_DINGTALK_CLIENT_ID);
  const clientSecret = required(environment.DAOYAN_DINGTALK_CLIENT_SECRET);
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error('钉钉通道必须同时配置 DAOYAN_DINGTALK_CLIENT_ID 和 CLIENT_SECRET');
  }
  const allowedSenderIds = required(environment.DAOYAN_DINGTALK_ALLOWED_SENDER_IDS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedSenderIds.length === 0) {
    throw new Error('钉钉通道必须配置 DAOYAN_DINGTALK_ALLOWED_SENDER_IDS');
  }
  return {
    clientId,
    clientSecret,
    allowedSenderIds,
    notifyUserId: required(environment.DAOYAN_DINGTALK_NOTIFY_USER_ID) || allowedSenderIds[0]!,
    robotCode: required(environment.DAOYAN_DINGTALK_ROBOT_CODE) || clientId,
  };
}

function defaultClientFactory(config: DingtalkSecretaryChannelConfig): DingtalkStreamClient {
  return new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    debug: false,
    keepAlive: true,
  });
}

function textBody(content: string): object {
  return {
    msgtype: 'text',
    text: { content },
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超过 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DingtalkSecretaryChannel implements SecretaryChannel {
  readonly id = 'dingtalk:stream';
  private readonly allowedSenderIds: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly client: DingtalkStreamClient;
  private readonly onError: (error: unknown) => void;
  private readonly startTimeoutMs: number;
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly seenMessages = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private readonly inflightMessages = new Map<string, Promise<void>>();
  private handler: SecretaryInboundHandler | null = null;
  private listenersRegistered = false;

  constructor(
    private readonly config: DingtalkSecretaryChannelConfig,
    options: DingtalkSecretaryChannelOptions = {},
  ) {
    this.allowedSenderIds = new Set(config.allowedSenderIds);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.startTimeoutMs = options.startTimeoutMs ?? 15_000;
    this.client = (options.clientFactory ?? defaultClientFactory)(config);
  }

  async start(handler: SecretaryInboundHandler): Promise<void> {
    this.handler = handler;
    if (!this.listenersRegistered) {
      this.client.registerCallbackListener(TOPIC_ROBOT, (message) => {
        void this.receive(message).catch(this.onError);
      });
      this.client.registerAllEventListener(() => ({ status: EventAck.SUCCESS }));
      this.listenersRegistered = true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.connect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`钉钉 Stream 连接超过 ${this.startTimeoutMs}ms`)),
            this.startTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.client.disconnect();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private acknowledge(messageId: string): void {
    this.client.socketCallBackResponse(messageId, { status: EventAck.SUCCESS });
  }

  private rememberMessage(messageId: string): void {
    this.seenMessages.add(messageId);
    this.seenMessageOrder.push(messageId);
    if (this.seenMessageOrder.length > 1_000) {
      const oldest = this.seenMessageOrder.shift();
      if (oldest) this.seenMessages.delete(oldest);
    }
  }

  private async processAuthorizedMessage(value: RobotMessage): Promise<void> {
    const predictedRequestId = externalRequestId('dingtalk', value.msgId);
    this.pendingReplies.set(predictedRequestId, {
      sessionWebhook: value.sessionWebhook,
      expiresAt: value.sessionWebhookExpiredTime,
    });
    try {
      const receipt = await this.handler?.({
        source: 'dingtalk',
        messageId: value.msgId,
        senderId: value.senderStaffId,
        conversationId: value.conversationId,
        text: value.text.content.trim(),
        receivedAt: new Date(value.createAt || this.now()).toISOString(),
      });
      if (receipt?.requestId && receipt.requestId !== predictedRequestId) {
        this.pendingReplies.delete(predictedRequestId);
        this.pendingReplies.set(receipt.requestId, {
          sessionWebhook: value.sessionWebhook,
          expiresAt: value.sessionWebhookExpiredTime,
        });
      } else if (receipt && !receipt.accepted) {
        this.pendingReplies.delete(predictedRequestId);
      }
    } catch (error) {
      this.pendingReplies.delete(predictedRequestId);
      throw error;
    }
  }

  private async receive(downstream: DWClientDownStream): Promise<void> {
    const streamMessageId = downstream.headers.messageId;
    const value = JSON.parse(downstream.data) as RobotMessage;
    if (value.msgtype !== 'text' || !value.text?.content?.trim()) {
      this.acknowledge(streamMessageId);
      return;
    }
    if (!this.allowedSenderIds.has(value.senderStaffId)) {
      this.acknowledge(streamMessageId);
      return;
    }
    if (this.seenMessages.has(value.msgId)) {
      this.acknowledge(streamMessageId);
      return;
    }
    const existing = this.inflightMessages.get(value.msgId);
    if (existing) {
      await existing;
      this.acknowledge(streamMessageId);
      return;
    }
    const operation = this.processAuthorizedMessage(value);
    this.inflightMessages.set(value.msgId, operation);
    try {
      await operation;
      this.rememberMessage(value.msgId);
      this.acknowledge(streamMessageId);
    } finally {
      if (this.inflightMessages.get(value.msgId) === operation) {
        this.inflightMessages.delete(value.msgId);
      }
    }
  }

  private async accessToken(): Promise<string> {
    return await withTimeout(this.client.getAccessToken(), 8_000, '钉钉 access token 请求');
  }

  private async sendSessionReply(target: PendingReply, message: string): Promise<boolean> {
    if (!target.sessionWebhook || target.expiresAt <= this.now()) return false;
    const response = await this.fetchImpl(target.sessionWebhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': await this.accessToken(),
      },
      body: JSON.stringify(textBody(message)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`钉钉会话回复返回 ${response.status}`);
    return true;
  }

  private async sendProactive(message: string): Promise<void> {
    const response = await this.fetchImpl(PROACTIVE_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': await this.accessToken(),
      },
      body: JSON.stringify({
        robotCode: this.config.robotCode,
        userIds: [this.config.notifyUserId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: message }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`钉钉主动通知返回 ${response.status}`);
  }

  async publish(notice: SecretaryNotice): Promise<void> {
    const pending = notice.correlationId
      ? this.pendingReplies.get(notice.correlationId)
      : undefined;
    if (pending) {
      try {
        if (await this.sendSessionReply(pending, notice.message)) {
          this.pendingReplies.delete(notice.correlationId);
          return;
        }
      } catch (error) {
        this.onError(new Error(`钉钉原会话回复失败，改用主动通知：${String(error)}`));
      }
      this.pendingReplies.delete(notice.correlationId);
    }
    await this.sendProactive(notice.message);
  }

  async stop(): Promise<void> {
    this.handler = null;
    this.pendingReplies.clear();
    this.seenMessages.clear();
    this.seenMessageOrder.length = 0;
    this.inflightMessages.clear();
    this.client.disconnect();
  }
}

export function dingtalkChannelFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: DingtalkSecretaryChannelOptions = {},
): DingtalkSecretaryChannel | null {
  const config = dingtalkConfigFromEnvironment(environment);
  return config ? new DingtalkSecretaryChannel(config, options) : null;
}
