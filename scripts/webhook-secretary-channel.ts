import type {
  SecretaryChannel,
  SecretaryInboundHandler,
  SecretaryNotice,
} from './secretary-channel';

export type WebhookKind = 'generic' | 'feishu' | 'wecom' | 'discord' | 'dingtalk';

export interface WebhookSecretaryChannelOptions {
  url: string;
  kind: WebhookKind;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function webhookBody(kind: WebhookKind, notice: SecretaryNotice): unknown {
  if (kind === 'feishu') return { msg_type: 'text', content: { text: notice.message } };
  if (kind === 'wecom') return { msgtype: 'text', text: { content: notice.message } };
  if (kind === 'discord') return { content: notice.message };
  if (kind === 'dingtalk') return { msgtype: 'text', text: { content: notice.message } };
  return notice;
}

export class WebhookSecretaryChannel implements SecretaryChannel {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: WebhookSecretaryChannelOptions) {
    this.id = `webhook:${options.kind}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async start(_handler: SecretaryInboundHandler): Promise<void> {}

  async publish(notice: SecretaryNotice): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(this.options.kind, notice)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`webhook 返回 ${response.status}`);
  }

  async stop(): Promise<void> {}
}

export function webhookChannelFromEnvironment(
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): WebhookSecretaryChannel | null {
  const url = environment.DAOYAN_SECRETARY_WEBHOOK_URL?.trim();
  if (!url) return null;
  const rawKind = (environment.DAOYAN_SECRETARY_WEBHOOK_KIND ?? 'generic').toLowerCase();
  const kinds = new Set<WebhookKind>(['generic', 'feishu', 'wecom', 'discord', 'dingtalk']);
  if (!kinds.has(rawKind as WebhookKind)) {
    throw new Error(`不支持的秘书 webhook 类型：${rawKind}`);
  }
  return new WebhookSecretaryChannel({
    url,
    kind: rawKind as WebhookKind,
    fetchImpl,
  });
}
