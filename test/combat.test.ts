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
      a.base.speed = 0;
      b.world.recompute(a);
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
    expect(b.player.mana).toBeLessThan(b.player.attr.manaMax);
  });

  it('低施法速度会跨帧积累并偿还 tick 预算', () => {
    const b = new Battle(parseSpellbook(readFileSync(SRC, 'utf8')), {
      playerAttrs: { castSpeed: 0.1 },
    });
    b.setBinding('2', '三连剑');

    expect(b.castPlayer('2')).toBe(true);
    run(b, 0.5);

    const cast = b.activeCasts(b.player.id)[0];
    expect(cast).toBeDefined();
    expect(cast.vm.spentTicks).toBeLessThan(15);
  });

  it('冷却期间无法再次施放', () => {
    const b = makeBattle();
    b.setBinding('3', '爆炎咒'); // 冷却 6s
    expect(b.castPlayer('3')).toBe(true);
    run(b, 3); // 等它放完
    expect(b.cooldownLeft(b.player.id, '爆炎咒')).toBeGreaterThan(0);
    expect(b.castPlayer('3')).toBe(false);
  });

  it('持续类法术会周期性重复执行', () => {
    const b = makeBattle();
    // 让妖兽既不动也不攻击，避免打断玩家的护体金光
    for (const a of b.world.actors) {
      if (a.faction !== 'foe') continue;
      a.base.speed = 0;
      a.bindings = {};
      b.world.recompute(a);
    }

    b.setBinding('5', '护体金光'); // duration 6s / period 1.5s
    expect(b.castPlayer('5')).toBe(true);
    expect(b.metaOf('护体金光').kind).toBe('duration');

    run(b, 5);
    // 6 秒内按 1.5 秒周期应触发多次
    expect(b.player.mods.length).toBeGreaterThan(0);
    expect(b.player.attr.armor).toBeGreaterThan(0);
  });

  it('属性增益会影响实际效果（护体减伤）', () => {
    const b = makeBattle();
    b.world.addModifier(b.player, 'armor', 'add', 20, 10, '测试');
    expect(b.player.attr.armor).toBe(20);

    const before = b.player.hp;
    b.world.damage(b.player.id, 50);
    // 50 伤害被 20 护体削掉
    expect(before - b.player.hp).toBe(30);
  });

  it('术法威力属性会放大伤害', () => {
    const b = makeBattle();
    const foe = b.world.actors.find((a) => a.faction === 'foe');
    expect(foe).toBeDefined();
    if (!foe) return;
    foe.base.speed = 0;
    b.world.recompute(foe);
    foe.x = b.player.x + 220;
    foe.y = b.player.y;
    b.aimAt(foe.x, foe.y);

    b.player.base.power = 2;
    b.world.recompute(b.player);

    b.setBinding('5', '御剑·手动');
    b.castPlayer('5');
    run(b, 1.5);
    // 基础 22 伤害 × 威力 2 = 44
    expect(foe.attr.hpMax - foe.hp).toBeGreaterThan(30);
  });

  it('同一槽位在施法结束前不能重入', () => {
    const b = makeBattle();
    b.setBinding('1', '疾风步');
    expect(b.castPlayer('1')).toBe(true);
    // 同一物理槽位的重复事件不能制造多个实例
    run(b, 0.01);
    const second = b.castPlayer('1');
    expect(second).toBe(false);
  });

  it('不同槽位可以同时释放法术', () => {
    const b = makeBattle();
    b.setBinding('2', '三连剑');
    b.setBinding('3', '爆炎咒');

    expect(b.castPlayer('2')).toBe(true);
    expect(b.castPlayer('3')).toBe(true);
    expect(b.activeCasts(b.player.id).map((cast) => cast.triggerSlot)).toEqual(['2', '3']);

    run(b, 0.01);
    expect(b.activeCasts(b.player.id)).toHaveLength(2);
  });

  it('并发法术从同一当前法力池扣费', () => {
    const book = parseSpellbook(`
      spell 甲 { 瞬移(自身位置()) }
      spell 乙 { 瞬移(自身位置()) }
    `);
    const b = new Battle(book, {
      playerAttrs: { manaMax: 60, manaRegen: 0 },
      playerBindings: { '1': '甲', '2': '乙' },
    });

    expect(b.castPlayer('1')).toBe(true);
    expect(b.castPlayer('2')).toBe(true);
    run(b, 0.1);

    expect(b.stats.backfires).toBe(1);
    expect(b.player.mana).toBeGreaterThanOrEqual(0);
    expect(b.player.mana).toBeLessThan(20);
  });

  it('并发法术共享实时神识并在结束后归还', () => {
    const book = parseSpellbook(`
      spell 甲 {
        var hold: list<num, 40>
        repeat 100 {
          长度(hold)
          自身位置()
        }
      }
      spell 乙 {
        var hold: list<num, 40>
        repeat 100 {
          长度(hold)
          自身位置()
        }
      }
    `);
    const b = new Battle(book, {
      playerAttrs: { shenshiMax: 64 },
      playerBindings: { '1': '甲', '2': '乙' },
    });

    b.castPlayer('1');
    b.castPlayer('2');
    run(b, 0.01);

    expect(b.stats.backfires).toBe(1);
    expect(b.activeCasts(b.player.id)).toHaveLength(1);
    expect(b.shenshiInUse(b.player.id)).toBe(41);

    run(b, 2);
    expect(b.shenshiInUse(b.player.id)).toBe(0);
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

  it('受击会打断全部可打断法术并归还共享神识', () => {
    const book = parseSpellbook(`
      spell 甲 {
        var hold: list<num, 20>
        repeat 100 {
          长度(hold)
          自身位置()
        }
      }
      spell 乙 {
        var hold: list<num, 20>
        repeat 100 {
          长度(hold)
          自身位置()
        }
      }
    `);
    const b = new Battle(book, { playerBindings: { '1': '甲', '2': '乙' } });

    b.castPlayer('1');
    b.castPlayer('2');
    run(b, 0.01);
    expect(b.shenshiInUse(b.player.id)).toBe(42);

    b.world.damage(b.player.id, 10);
    expect(b.activeCasts(b.player.id)).toHaveLength(0);
    expect(b.shenshiInUse(b.player.id)).toBe(0);
    expect(b.stats.interrupts).toBe(2);
  });
});

describe('弹道与命中', () => {
  it('飞剑能命中正前方的妖兽', () => {
    const b = makeBattle();
    const foe = b.world.actors.find((a) => a.faction === 'foe');
    expect(foe).toBeDefined();
    if (!foe) return;

    // 挪到玩家正前方并定住（否则它会绕圈走位把飞剑躲开——那正是设计意图）
    foe.base.speed = 0;
    b.world.recompute(foe);
    foe.x = b.player.x + 220;
    foe.y = b.player.y;
    b.aimAt(foe.x, foe.y);

    b.setBinding('5', '御剑·手动');
    expect(b.castPlayer('5')).toBe(true);
    run(b, 1.5);

    expect(foe.hp).toBeLessThan(foe.attr.hpMax);
  });

  it('妖兽会被动施法（AI 走同一条施法管线）', () => {
    const b = makeBattle();
    const before = b.stats.casts;
    run(b, 6);
    expect(b.stats.casts).toBeGreaterThan(before);
  });
});

describe('按键状态接入法术', () => {
  function quiet(b: Battle): void {
    for (const a of b.world.actors) {
      if (a.faction !== 'foe') continue;
      a.base.speed = 0;
      a.bindings = {};
      b.world.recompute(a);
    }
    b.player.aim = { x: 1, y: 0 };
  }

  it('蓄力火球：按住蓄力、蓄满后松开则发射', () => {
    const b = makeBattle();
    quiet(b);
    b.setBinding('5', '蓄力火球');

    expect(b.pressSlot('5')).toBe(true); // 按下 → 起手持续施法
    run(b, 1.2); // 蓄力超过 0.8s 阈值
    b.releaseSlot('5'); // 松开
    run(b, 0.2); // 下一个周期轮询捕获松开边沿 → 发射 + 结束施法

    expect(b.casts.has(b.player.id)).toBe(false);
    expect(b.world.projectiles.length).toBeGreaterThanOrEqual(1);
    // 威力 = 20 + min(1.2, 2) * 40 = 68
    expect(b.world.projectiles[0].damage).toBeGreaterThan(40);
  });

  it('蓄力火球：提前松开则不发射', () => {
    const b = makeBattle();
    quiet(b);
    b.setBinding('5', '蓄力火球');

    b.pressSlot('5');
    run(b, 0.3); // 蓄力不足 0.8s
    b.releaseSlot('5');
    run(b, 0.2);

    expect(b.casts.has(b.player.id)).toBe(false);
    expect(b.world.projectiles.length).toBe(0);
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
