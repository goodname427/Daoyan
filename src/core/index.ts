// 务必最先加载：元函数注册是全局副作用
import './builtins';

export * from './types';
export * from './ast';
export * from './meta';
export * from './world';
export * from './analyzer';
export * from './compiler';
export * from './vm';
export * from './dsl';

import type { SpellBook } from './ast';
import { parseSpellbook } from './dsl';

/** 从 DSL 源码加载一本法术书（节点图产出同一份结构后可直接复用后续流程） */
export function loadBook(src: string): SpellBook {
  return parseSpellbook(src);
}
