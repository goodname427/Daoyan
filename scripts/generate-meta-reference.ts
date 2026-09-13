import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { allMetas, typeName } from '../src/core/index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'docs/reference/meta-spells.md');
const groupOrder = ['运算符', '按键状态', '状态探查', '实体创建', '实体控制', '施法控制'];

const escapeCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

const metas = [...allMetas()].sort((a, b) => {
  return groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
});

const lines = [
  '# 元法术参考（当前实现）',
  '',
  '> 本页由 `scripts/generate-meta-reference.ts` 从 `src/core/metas/` 自动生成。不要手工修改表格；元法术变化后运行 `npm run docs:generate`。',
  '',
  `当前共有 **${metas.length}** 个元法术、**${new Set(metas.map((meta) => meta.group)).size}** 个职责分组。`,
  '',
  '## 如何读表',
  '',
  '- `法力价格` 是固定价格或动态价格的静态上界。战斗实扣为 `运行时基础价 × 施法者.manaCostMul`。',
  '- `基础 tick` 是该调用本身的执行步数；参数表达式、列表下标和被调用的自定义法术还会继续累加耗时。',
  '- 演武场中约 `1 tick = 10ms / 施法速度`，因此施法速度只改变真实时间，不改变静态 tick 数。',
  '- 返回 `list<类型,?>` 表示元法术返回动态列表；接入 `list<类型,容量>` 变量时按声明容量截断。',
  '- 标为“动态≤N”的调用会按距离或请求效果结算，但运行时基础价绝不超过静态上界 N。',
  '',
];

for (const group of groupOrder) {
  const groupMetas = metas.filter((meta) => meta.group === group);
  if (groupMetas.length === 0) continue;
  lines.push(`## ${group}（${groupMetas.length}）`, '');
  lines.push('| 元法术 | 参数 | 返回 | 法力价格 | 基础 tick | 当前效果 |');
  lines.push('| ------ | ---- | ---- | -------- | --------- | -------- |');
  for (const meta of groupMetas) {
    const params =
      meta.params.length === 0
        ? '无'
        : meta.params.map((param) => `${param.name}: ${typeName(param.t)}`).join('<br>');
    lines.push(
      `| ${escapeCell(meta.name)} | ${escapeCell(params)} | ${typeName(meta.ret)} | ${meta.manaCost ? `动态≤${meta.mana}` : meta.mana} | ${meta.ticks} | ${escapeCell(meta.desc)} |`,
    );
  }
  lines.push('');
}

lines.push(
  '## 分类与定价契约',
  '',
  '- `运算符` 合并数值、逻辑、向量和列表内计算；这些调用不读取世界且不消耗法力。',
  '- `按键状态` 只读取输入；`结束施法` 单列为跨领域的 `施法控制`。',
  '- `状态探查`、`实体创建` 与 `实体控制` 按世界 I/O 职责区分。',
  '- vNext 的稳定分类、统一句柄与动态价格契约见 [`../adr/0009-统一实体句柄与能力判定.md`](../adr/0009-统一实体句柄与能力判定.md) 和 [`../adr/0010-动态元法术价格与静态上界.md`](../adr/0010-动态元法术价格与静态上界.md)。',
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
