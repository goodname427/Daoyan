/**
 * 元法术加载器。
 *
 * 约定：
 *   1. `src/core/metas/` 下的每个 `.ts` 文件默认导出一个 `register()` 函数
 *   2. Vite 环境（游戏本体 / vitest）用 `import.meta.glob` 自动收录 ——
 *      **新增文件不需要改任何索引**
 *   3. 纯 Node（tsx 跑无头沙盒）没有 glob，走下面的显式兜底清单，
 *      新增元法术文件时请同步补一行
 *   4. 打包后用户可以把自己的 `.js` 元法术文件丢到外部 `metas/` 目录，
 *      由 `loadExternalMetas()` 动态加载（见 docs/扩展元法术.md）
 */

import * as attribute from './attribute';
import * as control from './control';
import * as math from './math';
import * as sense from './sense';
import * as vector from './vector';

import { allMetas } from '../meta';
import type { MetaDef } from '../meta';

type MetaModule = { default?: () => void };

const globbable = import.meta as unknown as {
  glob?: (pattern: string, opts?: { eager?: boolean }) => Record<string, MetaModule>;
};

/** Vite 构建期自动收录目录内全部 .ts */
const autoModules: Record<string, MetaModule> = globbable.glob
  ? globbable.glob('./*.ts', { eager: true })
  : {};

/** 纯 Node 兜底：新增元法术文件时请在此补一行 */
const fallbackModules: Record<string, MetaModule> = {
  './math.ts': math,
  './vector.ts': vector,
  './sense.ts': sense,
  './control.ts': control,
  './attribute.ts': attribute,
};

const modules: Record<string, MetaModule> = { ...fallbackModules, ...autoModules };

let loaded = false;

(function loadBuiltin(): void {
  if (loaded) return;
  loaded = true;
  for (const path of Object.keys(modules).sort()) {
    try {
      modules[path].default?.();
    } catch (e) {
      console.error(`[元法术] 加载失败: ${path}`, e);
    }
  }
})();

/**
 * 运行时加载外部元法术（Electron 下通过宿主扫描目录得到模块 URL 列表）。
 * @param loaders 由宿主注入的加载函数数组
 */
export async function loadExternalMetas(
  loaders: Array<() => Promise<MetaModule>>,
): Promise<string[]> {
  const added: string[] = [];
  const before = new Set(allMetas().map((m) => m.name));
  for (const load of loaders) {
    try {
      const mod = await load();
      mod.default?.();
    } catch (e) {
      console.error('[元法术] 外部模块加载失败', e);
    }
  }
  for (const m of allMetas()) {
    if (!before.has(m.name)) added.push(m.name);
  }
  return added;
}

export type { MetaDef };
