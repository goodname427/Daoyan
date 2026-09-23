// 务必最先加载：元法术注册是全局副作用（自动收录 metas/ 目录下所有文件）
import './metas';

export * from './types';
export * from './ast';
export * from './meta';
export * from './pricing';
export * from './ledger';
export * from './attributes';
export * from './input';
export * from './world';
export * from './analyzer';
export * from './compiler';
export * from './vm';
export * from './dsl';
export * from './migration';
export * from './spellMeta';

import type { SpellBook } from './ast';
import { parseSpellbook } from './dsl';

export { loadExternalMetas } from './metas';

/** 从 DSL 源码加载一本法术书（节点图产出同一份结构后可直接复用后续流程） */
export function loadBook(src: string): SpellBook {
  return parseSpellbook(src);
}
