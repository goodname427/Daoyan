/**
 * 无头沙盒：验证「资源约束能否逼出更优雅的写法」。
 *
 * 运行： npm run dev
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  analyzeBook,
  castSpell,
  compileProgram,
  makeCaster,
  parseSpellbook,
  World,
} from '../core/index';

const SRC = join(process.cwd(), 'src', 'demo', 'spells.dy');

const pad = (s: string, n: number): string => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

/** 从剑气日志里取出命中目标编号 */
function hitTarget(log: string[]): string {
  for (const l of log) {
    const m = /剑气命中 #(\d+)/.exec(l);
    if (m) return `#${m[1]}`;
  }
  return '未命中';
}

/**
 * 布阵：先生成远的、后生成近的。
 * 这样「列表容量小」的法术会只看到最远的几个敌人，从而暴露「看漏目标」的代价。
 */
function setupWorld(n: number): World {
  const world = new World();
  for (let i = 0; i < n; i++) {
    const ang = i * 0.55;
    const r = 110 + (n - 1 - i) * 28; // 越晚生成越近
    world.spawn(Math.cos(ang) * r, Math.sin(ang) * r, 100);
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
  console.log('\n【二】敌人数变化 —— 谁更划算？\n');
  console.log(
    pad('敌人', 6),
    pad('法术', 16),
    pad('法力', 6),
    pad('神识', 6),
    pad('耗时', 9),
    pad('命中', 8),
    '备注',
  );
  console.log('─'.repeat(80));

  for (const n of [1, 2, 3, 8]) {
    for (const name of spells) {
      const world = setupWorld(n);
      const caster = makeCaster(0, 0, 400, 64);
      const r = castSpell(program, name, world, caster);
      const hit = hitTarget(r.log);
      const nearest = `#${n}`; // 最后生成的敌人最近
      const note = !r.ok ? (r.error ?? '') : hit === nearest ? '' : `看漏了（最近的是 ${nearest}）`;
      console.log(
        pad(String(n), 6),
        pad(name, 16),
        pad(String(r.mana), 6),
        pad(String(r.shenshiPeak), 6),
        pad(`${r.ticks} tick`, 9),
        pad(hit, 8),
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
      const caster = makeCaster(0, 0, 400, cap);
      const r = castSpell(program, name, world, caster);
      console.log(
        pad(String(cap), 12),
        pad(name, 16),
        r.ok ? `成功（法力 ${r.mana}，神识 ${r.shenshiPeak}）` : `走火入魔：${r.error}`,
      );
    }
    console.log('─'.repeat(64));
  }

  console.log('\n结论：');
  console.log('  · 法力：敌人 1 个时朴素版更省（87 < 97），3 个以上慧剑完胜（法力恒定）');
  console.log('  · 神识：慧剑要付 15 点「租金」，神识上限 39 以下根本撑不起来');
  console.log('  · 容量：微剑把容量压到 4，神识只要 15，代价是场上超过 4 人时看漏最近的目标');
  console.log('  · 三个维度互相制衡，没有单一最优解 —— 玩家必须按自己的境界和战场选择写法');
}

main();
