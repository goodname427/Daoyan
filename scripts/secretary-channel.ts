import { createHash } from 'node:crypto';

export interface SecretaryInboundMessage {
  source: string;
  messageId: string;
  senderId: string;
  conversationId: string;
  text: string;
  receivedAt: string;
}

export interface SecretaryInboundReceipt {
  requestId: string;
  accepted: boolean;
}

export interface SecretaryNotice {
  id: string;
  kind: string;
  message: string;
  correlationId: string;
  itemId: string;
  createdAt: string;
  taskId?: string;
  taskTitle?: string;
  parentScope?: string;
  parentTitle?: string;
  versionTitle?: string;
  completedAt?: string;
}

export type SecretaryInboundHandler = (
  message: SecretaryInboundMessage,
) => Promise<SecretaryInboundReceipt>;

export interface SecretaryChannel {
  readonly id: string;
  start(handler: SecretaryInboundHandler): Promise<void>;
  publish(notice: SecretaryNotice): Promise<void>;
  stop(): Promise<void>;
}

export interface SecretaryChannelLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface SecretaryPublishResult {
  attemptedChannelIds: string[];
  failedChannelIds: string[];
}

export interface SecretaryChannelHubOptions {
  startTimeoutMs?: number;
  publishTimeoutMs?: number;
  stopTimeoutMs?: number;
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

export function externalRequestId(source: string, messageId: string): string {
  const digest = createHash('sha256').update(`${source}:${messageId}`).digest('hex');
  return `${source}-${digest.slice(0, 32)}`;
}

export class SecretaryChannelHub {
  private readonly activeChannels = new Set<SecretaryChannel>();
  private inboundHandler: SecretaryInboundHandler | null = null;
  private lifecycle = 0;

  constructor(
    private readonly channels: SecretaryChannel[],
    private readonly logger: SecretaryChannelLogger,
    private readonly options: SecretaryChannelHubOptions = {},
  ) {}

  activeChannelIds(): string[] {
    return [...this.activeChannels].map((channel) => channel.id);
  }

  configuredChannelIds(): string[] {
    return this.channels.map((channel) => channel.id);
  }

  async start(handler: SecretaryInboundHandler): Promise<void> {
    this.lifecycle += 1;
    this.inboundHandler = handler;
    this.activeChannels.clear();
    await this.retryInactive(this.lifecycle);
  }

  async retryInactive(expectedLifecycle = this.lifecycle): Promise<void> {
    if (!this.inboundHandler) return;
    for (const channel of this.channels) {
      if (this.activeChannels.has(channel)) continue;
      try {
        await withTimeout(
          channel.start(this.inboundHandler),
          this.options.startTimeoutMs ?? 20_000,
          `${channel.id} 启动`,
        );
        if (expectedLifecycle !== this.lifecycle || !this.inboundHandler) {
          await channel.stop();
          continue;
        }
        this.activeChannels.add(channel);
        this.logger.info(`[通讯通道] ${channel.id} 已启动`);
      } catch (error) {
        this.logger.error(`[通讯通道] ${channel.id} 启动失败：${String(error)}`);
        try {
          await channel.stop();
        } catch (stopError) {
          this.logger.error(`[通讯通道] ${channel.id} 清理失败：${String(stopError)}`);
        }
      }
    }
  }

  async publish(notice: SecretaryNotice, channelIds?: string[]): Promise<SecretaryPublishResult> {
    const requested = channelIds ? new Set(channelIds) : null;
    const activeChannels = [...this.activeChannels].filter(
      (channel) => !requested || requested.has(channel.id),
    );
    const results = await Promise.allSettled(
      activeChannels.map((channel) =>
        withTimeout(
          channel.publish(notice),
          this.options.publishTimeoutMs ?? 20_000,
          `${channel.id} 发送`,
        ),
      ),
    );
    const failedChannelIds: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const channelId = activeChannels[index]?.id ?? 'unknown';
        failedChannelIds.push(channelId);
        this.logger.error(`[通讯通道] ${channelId} 发送失败：${String(result.reason)}`);
      }
    });
    return {
      attemptedChannelIds: activeChannels.map((channel) => channel.id),
      failedChannelIds,
    };
  }

  async stop(): Promise<void> {
    const activeChannels = [...this.activeChannels];
    this.lifecycle += 1;
    this.inboundHandler = null;
    this.activeChannels.clear();
    const results = await Promise.allSettled(
      activeChannels.map((channel) =>
        withTimeout(channel.stop(), this.options.stopTimeoutMs ?? 5_000, `${channel.id} 停止`),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `[通讯通道] ${activeChannels[index]?.id ?? 'unknown'} 停止失败：${String(result.reason)}`,
        );
      }
    });
  }
}
