import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { allMetas, typeName } from '../src/core/index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'docs/reference/meta-spells.md');
const groupOrder = ['运算', '向量', '按键', '感知', '操控', '属性'];

const escapeCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

const metas = [...allMetas()].sort((a, b) => {
  return groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
});

const lines = [
  '# 元法术参考（当前实现）',
  '',
  '> 本页由 `scripts/generate-meta-reference.ts` 从 `src/core/metas/` 自动生成。不要手工修改表格；元法术变化后运行 `npm run docs:generate`。',
  '',
  `当前共有 **${metas.length}** 个元法术、**${new Set(metas.map((meta) => meta.group)).size}** 个实现分组。这里记录的是 0.2 现状，不代表 vNext 分类已经确定。`,
  '',
  '## 如何读表',
  '',
  '- `基础法力` 是注册表中的固定价格。战斗实扣为 `基础法力 × 施法者.manaCostMul`。',
  '- `基础 tick` 是该调用本身的执行步数；参数表达式、列表下标和被调用的自定义法术还会继续累加耗时。',
  '- 演武场中约 `1 tick = 10ms / 施法速度`，因此施法速度只改变真实时间，不改变静态 tick 数。',
  '- 返回 `list<类型,?>` 表示元法术返回动态列表；接入 `list<类型,容量>` 变量时按声明容量截断。',
  '- 当前距离、目标神识强度和投入强度都不会动态改变元法术价格；这是现状限制，不是 vNext 结论。',
  '',
];

for (const group of groupOrder) {
  const groupMetas = metas.filter((meta) => meta.group === group);
  if (groupMetas.length === 0) continue;
  lines.push(`## ${group}（${groupMetas.length}）`, '');
  lines.push('| 元法术 | 参数 | 返回 | 基础法力 | 基础 tick | 当前效果 |');
  lines.push('| ------ | ---- | ---- | -------- | --------- | -------- |');
  for (const meta of groupMetas) {
    const params =
      meta.params.length === 0
        ? '无'
        : meta.params.map((param) => `${param.name}: ${typeName(param.t)}`).join('<br>');
    lines.push(
      `| ${escapeCell(meta.name)} | ${escapeCell(params)} | ${typeName(meta.ret)} | ${meta.mana} | ${meta.ticks} | ${escapeCell(meta.desc)} |`,
    );
  }
  lines.push('');
}

lines.push(
  '## 当前分组边界',
  '',
  '- `运算` 与 `向量` 都是神识内计算，均不消耗法力。',
  '- `长度` 目前放在 `感知`，但它只读取已在神识中的列表，也不消耗法力。',
  '- `结束施法` 目前放在 `按键`，实际职责是控制施法生命周期。',
  '- `操控` 同时包含生成弹道、直接伤害、自身位移与瞬移；`属性` 同时包含自身增益和目标减益。',
  '- 新分类方向及其风险见 [`../proposals/meta-spell-and-entity-model-vnext.md`](../proposals/meta-spell-and-entity-model-vnext.md)。',
  '',
);

const output = await prettier.format(`${lines.join('\n')}\n`, { parser: 'markdown' });

if (process.argv.includes('--check')) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current !== output) {
    console.error('元法术参考已过期，请运行 npm run docs:generate');
    process.exit(1);
  }
  console.log(`元法术参考检查通过：${metas.length} 个元法术`);
} else {
  writeFileSync(outputPath, output, 'utf8');
  console.log(`已生成 docs/reference/meta-spells.md：${metas.length} 个元法术`);
}
