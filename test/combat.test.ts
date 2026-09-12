import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseSpellbook } from '../src/core/index';
import { Battle } from '../src/game/battle';

const SRC = join(process.cwd(), 'src', 'game', 'spells.dy');

function makeBattle(): Battle {
  return new Battle(parseSpellbook(readFileSync(SRC, 'utf8')));
}

/** 推进指定秒数 */
function run(battle: Battle, seconds: number, dt = 1 / 60): void {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) battle.update(dt);
}

describe('战斗初始化', () => {
  it('生成玩家与第一波妖兽', () => {
    const b = makeBattle();
    expect(b.player.faction).toBe('player');
    expect(b.player.alive).toBe(true);
    expect(b.foesLeft()).toBe(3);
    expect(b.state).toBe('fighting');
  });
});

describe('玩家操作', () => {
  it('WASD 能驱动移动', () => {
    const b = makeBattle();
    const x0 = b.player.x;
    b.input.right = true;
    run(b, 0.5);
    b.input.right = false;
    expect(b.player.x).toBeGreaterThan(x0 + 40);
  });

  it('施法需要时间，不是瞬间完成', () => {
    const b = makeBattle();
    // 把妖兽定在身边（速度归零），保证三连剑真的要跑满循环
    for (const a of b.world.actors) {
      if (a.faction !== 'foe') continue;
      a.speed = 0;
      a.x = b.player.x + 120;
      a.y = b.player.y + 20;
    }

    b.setBinding('2', '三连剑');
    expect(b.castPlayer('2')).toBe(true);
    expect(b.casts.has(b.player.id)).toBe(true);

    run(b, 0.1); // 100ms 只有约 10 tick，远不够
    expect(b.casts.has(b.player.id)).toBe(true);

    run(b, 3);
    expect(b.casts.has(b.player.id)).toBe(false);
    expect(b.player.mana).toBeLessThan(b.player.manaMax);
  });

  it('施法中不能分心二用', () => {
    const b = makeBattle();
    b.setBinding('1', '疾风步');
    expect(b.castPlayer('1')).toBe(true);
    // 疾风步很短，立刻再触发一次应被拒绝
    run(b, 0.01);
    const second = b.castPlayer('1');
    expect(second).toBe(false);
  });

  it('受击会打断施法', () => {
    const b = makeBattle();
    b.setBinding('2', '三连剑');
    b.castPlayer('2');
    expect(b.casts.has(b.player.id)).toBe(true);

    b.world.damage(b.player.id, 10);
    expect(b.casts.has(b.player.id)).toBe(false);
    expect(b.stats.interrupts).toBe(1);
  });
});

describe('弹道与命中', () => {
  it('飞剑能命中正前方的妖兽', () => {
    const b = makeBattle();
    const foe = b.world.actors.find((a) => a.faction === 'foe');
    expect(foe).toBeDefined();
    if (!foe) return;

    // 挪到玩家正前方并定住（否则它会绕圈走位把飞剑躲开——那正是设计意图）
    foe.speed = 0;
    foe.x = b.player.x + 220;
    foe.y = b.player.y;
    b.aimAt(foe.x, foe.y);

    b.setBinding('5', '御剑·手动');
    expect(b.castPlayer('5')).toBe(true);
    run(b, 1.5);

    expect(foe.hp).toBeLessThan(foe.hpMax);
  });

  it('妖兽会被动施法（AI 走同一条施法管线）', () => {
    const b = makeBattle();
    const before = b.stats.casts;
    run(b, 6);
    expect(b.stats.casts).toBeGreaterThan(before);
  });
});

describe('波次与胜负', () => {
  it('清空当前波会进入下一波', () => {
    const b = makeBattle();
    for (const a of b.world.actors) {
      if (a.faction === 'foe') b.world.damage(a.id, 9999);
    }
    b.update(1 / 60);
    expect(b.waveIndex).toBe(1);
    expect(b.foesLeft()).toBeGreaterThan(0);
  });

  it('玩家阵亡即失败', () => {
    const b = makeBattle();
    b.world.damage(b.player.id, 9999);
    b.update(1 / 60);
    expect(b.state).toBe('defeat');
  });
});
