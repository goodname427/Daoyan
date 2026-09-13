/**
 * 无头沙盒：验证「资源约束能否逼出更优雅的写法」。
 *
 * 运行： npm run sandbox
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VM, World, analyzeBook, compileProgram, parseSpellbook } from '../core/index';

const SRC = join(process.cwd(), 'src', 'demo', 'spells.dy');

const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

/** 从弹道方向推断法术瞄向了谁 */
function aimedAt(world: World): string {
  const pr = world.projectiles[0];
  if (!pr) return '未出手';
  let best: number | null = null;
  let bestT = Infinity;
  for (const a of world.hostilesOf(pr.faction)) {
    const t = (a.x - pr.x) * pr.dx + (a.y - pr.y) * pr.dy;
    if (t < 0 || t > 800) continue;
    const px = pr.x + pr.dx * t;
    const py = pr.y + pr.dy * t;
    if (Math.hypot(a.x - px, a.y - py) <= pr.radius + a.radius && t < bestT) {
      bestT = t;
      best = a.id;
    }
  }
  return best === null ? '未命中' : `#${best}`;
}

/**
 * 布阵：先生成远的、后生成近的。
 * 这样「列表容量小」的法术会只看到最远的几个敌人，从而暴露「看漏目标」的代价。
 */
function setupWorld(n: number): World {
  const world = new World();
  for (let i = 0; i < n; i++) {
    const ang = i * 0.55;
    const r = 110 + (n - 1 - i) * 28;
    world.spawnActor({
      faction: 'foe',
      x: Math.cos(ang) * r,
      y: Math.sin(ang) * r,
      attrs: { hpMax: 100 },
    });
  }
  return world;
}

function main(): void {
  const book = parseSpellbook(readFileSync(SRC, 'utf8'));
  const program = compileProgram(book, '御剑术·朴');

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  道衍 · 资源模型验证沙盒');
  console.log('══════════════════════════════════════════════════════════════');

  // ---------- 1. 静态分析 ----------
  console.log('\n【一】静态分析 —— 创建法术时玩家就能看到的代价\n');
  console.log(pad('法术', 16), pad('法力上界', 10), pad('耗时上界', 10), '神识峰值');
  console.log('─'.repeat(58));
  for (const [name, c] of Object.entries(analyzeBook(book))) {
    console.log(
      pad(name, 16),
      pad(String(c.manaWorst), 10),
      pad(`${c.tickWorst} tick`, 10),
      String(c.shenshiPeak),
    );
    for (const e of c.errors) console.log('   ✗', e);
  }
  console.log('\n  注：上界按「列表容量」算，实测按真实敌人数算。');

  // ---------- 2. 敌人数变化 ----------
  const spells = ['御剑术·朴', '御剑术·慧', '御剑术·微'];
  const measuredMana = new Map<string, number>();
  console.log('\n【二】敌人数变化 —— 谁更划算？\n');
  console.log(
    pad('敌人', 6),
    pad('法术', 16),
    pad('法力', 6),
    pad('神识', 6),
    pad('耗时', 9),
    pad('瞄向', 8),
    '备注',
  );
  console.log('─'.repeat(80));

  for (const n of [1, 2, 3, 8]) {
    for (const name of spells) {
      const world = setupWorld(n);
      const caster = world.spawnActor({
        name: '推演者',
        faction: 'player',
        x: 0,
        y: 0,
        attrs: { manaMax: 400, shenshiMax: 64 },
      });
      const r = new VM(program, world, caster).run(name);
      measuredMana.set(`${n}:${name}`, r.mana);
      const aim = aimedAt(world);
      const nearest = `#${n}`; // 最后生成的敌人最近
      const note = !r.ok ? (r.error ?? '') : aim === nearest ? '' : `看漏了（最近的是 ${nearest}）`;
      console.log(
        pad(String(n), 6),
        pad(name, 16),
        pad(formatNumber(r.mana), 6),
        pad(String(r.shenshiPeak), 6),
        pad(`${r.ticks} tick`, 9),
        pad(aim, 8),
        note,
      );
    }
    console.log('─'.repeat(80));
  }

  // ---------- 3. 境界 ----------
  console.log('\n【三】境界 = 神识容量 —— 同一个法术，低境界放不出来\n');
  console.log(pad('神识上限', 12), pad('法术', 16), '结果');
  console.log('─'.repeat(64));
  for (const cap of [24, 39, 64]) {
    for (const name of spells) {
      const world = setupWorld(6);
      const caster = world.spawnActor({
        name: '推演者',
        faction: 'player',
        x: 0,
        y: 0,
        attrs: { manaMax: 400, shenshiMax: cap },
      });
      const r = new VM(program, world, caster).run(name);
      console.log(
        pad(String(cap), 12),
        pad(name, 16),
        r.ok
          ? `成功（法力 ${formatNumber(r.mana)}，神识 ${r.shenshiPeak}）`
          : `走火入魔：${r.error}`,
      );
    }
    console.log('─'.repeat(64));
  }

  const mana = (enemyCount: number, spell: string) =>
    formatNumber(measuredMana.get(`${enemyCount}:${spell}`) ?? 0);
  console.log('\n结论：');
  console.log(
    `  · 法力：敌人 1 个时朴素版更省（${mana(1, '御剑术·朴')} < ${mana(1, '御剑术·慧')}），` +
      `3 个时慧剑开始占优（${mana(3, '御剑术·朴')} > ${mana(3, '御剑术·慧')}）`,
  );
  console.log('  · 神识：慧剑要付 15 点「租金」，神识上限 39 以下根本撑不起来');
  console.log('  · 容量：微剑把容量压到 4，神识只要 15，代价是场上超过 4 人时看漏最近的目标');
  console.log('  · 三个维度互相制衡，没有单一最优解 —— 玩家必须按自己的境界和战场选择写法');
}

main();
