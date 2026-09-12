import * as coreApi from '../core/index';

/**
 * 外部元法术加载（打包后的用户扩展）。
 *
 * 宿主（Electron 主进程）扫描 exe 旁的 metas/*.js，把文件 URL 通过
 * preload 暴露给渲染进程；这里把它们动态 import 进来并调用 register()。
 * 外部模块通过 globalThis.DAOYAN 获得注册能力 —— 保证用的是同一份注册表。
 */
interface HostApi {
  listMetaFiles?: () => Promise<string[]>;
}

export async function loadExternalMetas(): Promise<string[]> {
  const host = (globalThis as { daoyanHost?: HostApi }).daoyanHost;
  if (!host?.listMetaFiles) return [];

  (globalThis as Record<string, unknown>).DAOYAN = coreApi;
  const urls = await host.listMetaFiles();
  if (urls.length === 0) return [];

  const loaders = urls.map((u) => async () => import(/* @vite-ignore */ u));
  return coreApi.loadExternalMetas(loaders);
}
