import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { publicMetas, typeName } from '../src/core/index';
import packageJson from '../package.json';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'docs/reference/meta-spells.md');
const groupOrder = ['运算符', '按键状态', '状态探查', '实体创建', '实体控制', '施法控制'];

const escapeCell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

const metas = [...publicMetas()].sort((a, b) => {
  return groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
});

const lines = [
  '# 元法术参考（当前实现）',
  '',
  '> 本页由 `scripts/generate-meta-reference.ts` 从 `src/core/metas/` 自动生成。不要手工修改表格；元法术变化后运行 `npm run docs:generate`。',
  '',
  `参考对应项目版本 **${packageJson.version}**；目录只包含玩家可新建法术时使用的公开元法术，旧语法兼容项不列入。`,
  '',
  '属性控制接受 `(目标, 效果, 时间)`；位置改由独立的 `传送(目标, 落点)` 提交，`施加冲量(目标, 速度变化)` 为一次已付驱动。能力缺失、目标失效、权限不符或效果/时间非法时返回 `false`，不会应用部分效果；VM 资源不足或非法价格仍会终止施法。时间单位为秒，`0` 表示无限，不表示免费。`write` 是写入：`commit` 永久改基础状态，`overlay` 由世界持有至到期、替换或能力失效；两者都不因施法结束而撤销。`maintain` 由本次施法会话持有，按模拟时间每 `0.25` 秒先结算再维持效果，会话结束或控制失效时清理。',
  '',
  `当前共有 **${metas.length}** 个元法术、**${new Set(metas.map((meta) => meta.group)).size}** 个职责分组。`,
  '',
  '## 如何读表',
  '',
  '- `法力价格` 是固定价格或动态价格的基础成本。动态调用会按请求效果或目标状态继续计价；法球创建与三池注能均由世界按实价扣款，不享受法力折扣。',
  '- `基础 tick` 是该调用本身的执行步数；参数表达式、列表下标和被调用的自定义法术还会继续累加耗时。',
  '- 演武场中约 `1 tick = 10ms / 施法速度`，因此施法速度只改变真实时间，不改变静态 tick 数。',
  '- 返回 `list<类型,?>` 表示元法术返回动态列表；接入 `list<类型,容量>` 变量时按声明容量截断。',
  '- 标为“动态”或“基础 + 动态”的调用会按距离、目标关系或请求效果结算；有限请求不会被人为上限截断。',
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
      `| ${escapeCell(meta.name)} | ${escapeCell(params)} | ${typeName(meta.ret)} | ${meta.cost || meta.manaCost ? `基础${meta.mana} + 动态` : meta.mana} | ${meta.cost ? `基础${meta.ticks} + 动态` : meta.ticks} | ${escapeCell(meta.desc)} |`,
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
  '- 统一控制的关系、抗性、效果强度、时间项及完整资源公式见[实体与属性](./entities-and-attributes.md)和[法术编写指南](./spell-authoring.md)。',
  '- 已采纳的统一句柄、动态价格与统一实体控制合同见 [`../adr/0009-统一实体句柄与能力判定.md`](../adr/0009-统一实体句柄与能力判定.md)、[`../adr/0010-动态元法术价格与静态上界.md`](../adr/0010-动态元法术价格与静态上界.md)、[`../adr/0011-无界效果与动态资源预算.md`](../adr/0011-无界效果与动态资源预算.md)、[`../adr/0015-统一实体能力迁移与移除法术冷却.md`](../adr/0015-统一实体能力迁移与移除法术冷却.md) 和 [`../adr/0017-统一实体控制属性模型.md`](../adr/0017-统一实体控制属性模型.md)。这些决策记录设计合同；实现与版本验证状态以对应工作项证据为准。',
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
