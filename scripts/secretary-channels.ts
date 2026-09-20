import {
  SecretaryChannelHub,
  type SecretaryChannel,
  type SecretaryChannelLogger,
} from './secretary-channel';
import { webhookChannelFromEnvironment } from './webhook-secretary-channel';

function addConfiguredChannel(
  channels: SecretaryChannel[],
  logger: SecretaryChannelLogger,
  create: () => SecretaryChannel | null,
): void {
  try {
    const channel = create();
    if (channel) channels.push(channel);
  } catch (error) {
    logger.error(`[通讯通道] 配置无效：${String(error)}`);
  }
}

export async function secretaryChannelHubFromEnvironment(
  environment: NodeJS.ProcessEnv,
  logger: SecretaryChannelLogger,
): Promise<SecretaryChannelHub> {
  const channels: SecretaryChannel[] = [];
  addConfiguredChannel(channels, logger, () => webhookChannelFromEnvironment(environment));
  if (
    environment.DAOYAN_DINGTALK_CLIENT_ID?.trim() ||
    environment.DAOYAN_DINGTALK_CLIENT_SECRET?.trim()
  ) {
    try {
      const { dingtalkChannelFromEnvironment } = await import('./dingtalk-secretary-channel');
      addConfiguredChannel(channels, logger, () =>
        dingtalkChannelFromEnvironment(environment, {
          onError: (error) => logger.error(`[通讯通道] 钉钉入站处理失败：${String(error)}`),
        }),
      );
    } catch (error) {
      logger.error(`[通讯通道] 钉钉适配器加载失败：${String(error)}`);
    }
  }
  return new SecretaryChannelHub(channels, logger);
}
