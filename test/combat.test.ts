import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeBook, parseSpellbook, TICK_MS } from '../src/core/index';
import { Battle } from '../src/game/battle';
import { importSpellPresets, SPELL_PRESETS } from '../src/app/spellPresets';

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

describe('第二期用户法术预设实战', () => {
  it('减速预设在高频更新下保持法力账户守恒', () => {
    const preset = SPELL_PRESETS.find((entry) => entry.name === '对手减速')!;
    const book = parseSpellbook(`${readFileSync(SRC, 'utf8')}\n${preset.source}`);
    const battle = new Battle(book, {
      autoStart: false,
      playerBindings: { mouse: '对手减速' },
    });
    battle.setPlayerBaseAttr('manaMax', 400, true);
    battle.setPlayerBaseAttr('shenshiMax', 80);
    battle.start();
    const foe = battle.world.actors.find((actor) => actor.faction === 'foe')!;
    foe.x = battle.player.x + 120;
    foe.y = battle.player.y;
    battle.aimAt(foe.x, foe.y);
    battle.pressSlot('mouse');
    for (let i = 0; i < 150; i++) {
      battle.update(0.016);
      expect(battle.world.resourceLedger.manaAccountSnapshot(battle.player.id)?.conserved).toBe(
        true,
      );
    }
  });

  it('默认法术书的三种法球均可绑定，并进入对应运动模式', () => {
    for (const [name, mode] of [
      ['法球·冲量滑行', 'glide'],
      ['法球·持续推进', 'thrust'],
      ['法球·目标追踪', 'track'],
    ] as const) {
      const battle = new Battle(parseSpellbook(readFileSync(SRC, 'utf8')), {
        playerAttrs: { shenshiMax: 80, manaMax: 800 },
      });
      const foe = battle.world.actors.find((actor) => actor.faction === 'foe')!;
      foe.x = battle.player.x + 140;
      foe.y = battle.player.y + 70;
      battle.setBinding('1', name);
      expect(battle.castPlayer('1')).toBe(true);
      run(battle, 0.58);
      const ball = battle.world.projectiles.find((item) => item.ownerId === battle.player.id);
      expect(ball?.behavior).toBe(mode);
      if (ball && mode === 'thrust')
        expect(battle.world.resourceLedger.balance(ball.id).motion).toBeGreaterThan(0);
      if (ball && mode === 'track')
        expect(battle.world.resourceLedger.balance(ball.id).scan).toBeGreaterThan(0);
      expect(battle.stats.backfires).toBe(0);
    }
  });

  for (const preset of SPELL_PRESETS) {
    it(`${preset.name}可从共享法术书绑定并影响获准目标`, () => {
      const imported = importSpellPresets(readFileSync(SRC, 'utf8'), [
        { name: preset.name, importAs: preset.name },
      ]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const battle = new Battle(parseSpellbook(imported.source), {
        playerAttrs: { shenshiMax: 80, manaMax: preset.name === '对手减速' ? 800 : 400 },
      });
      const foe = battle.world.actors.find((actor) => actor.faction === 'foe')!;
      foe.x = battle.player.x + 100;
      foe.y = battle.player.y;
      const originalSpeed = foe.attr.speed;
      const originalArmor = foe.attr.armor;
      battle.setBinding('1', preset.name);
      expect(battle.castPlayer('1')).toBe(true);
      run(battle, 0.4);
      expect(battle.stats.backfires).toBe(0);
      if (preset.name === '对手减速') expect(foe.attr.speed).toBeLessThan(originalSpeed);
      else expect(foe.attr.armor).toBeLessThan(originalArmor);
    });
  }
});

describe('事件法术响应', () => {
  function authorizeNearbyTarget(battle: Battle, target: Battle['player']) {
    target.x = battle.player.x + 140;
    target.y = battle.player.y;
    battle.world.grantSenseField(battle.player.id, target.id, 'events', {
      shenshiUpperBound: target.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
  }

  it('同名双订阅分别记录响应结果和实际费用', () => {
    const battle = new Battle(parseSpellbook('spell 同术 { 瞬移(自身位置()) }'), {
      playerAttrs: { manaMax: 25, manaRegen: 0 },
    });
    const foe = battle.world.actors.find((actor) => actor.faction === 'foe')!;
    authorizeNearbyTarget(battle, foe);
    expect(battle.subscribeSpellEvent(battle.player.id, 'same-1', 'damage', '同术')).not.toBeNull();
    expect(battle.subscribeSpellEvent(battle.player.id, 'same-2', 'damage', '同术')).not.toBeNull();
    battle.world.damage(foe.id, 1);
    battle.world.dispatchWorldEvents();
    run(battle, 0.3);
    expect(battle.eventResponses).toHaveLength(2);
    expect(new Set(battle.eventResponses.map((response) => response.eventId)).size).toBe(1);
    expect(battle.eventResponses.map((response) => response.state).sort()).toEqual([
      'failed',
      'success',
    ]);
    expect(battle.eventResponses[0].mana + battle.eventResponses[1].mana).toBeGreaterThan(0);
  });

  it('同一受击可启动两个独立法术；共享余额使后者失败且不回滚先者', () => {
    const book = parseSpellbook(`
      spell 甲 { 瞬移(自身位置()) }
      spell 乙 { 瞬移(自身位置()) }
    `);
    const battle = new Battle(book, {
      playerAttrs: { manaMax: 25, manaRegen: 0 },
      playerBindings: {},
    });
    const target = battle.world.actors.find((actor) => actor.faction === 'foe')!;
    authorizeNearbyTarget(battle, target);
    expect(
      battle.subscribeSpellEvent(battle.player.id, 'first', 'damage', '甲', {
        targetId: target.id,
      }),
    ).not.toBeNull();
    expect(
      battle.subscribeSpellEvent(battle.player.id, 'second', 'damage', '乙', {
        targetId: target.id,
      }),
    ).not.toBeNull();
    battle.world.damage(target.id, 1);
    battle.world.dispatchWorldEvents();
    run(battle, 0.3);
    expect(battle.player.mana).toBeGreaterThanOrEqual(0);
    expect(battle.player.mana).toBeLessThan(20);
    expect(battle.log.some((line) => line.includes('乙') && line.includes('失败'))).toBe(true);
    expect(battle.log.some((line) => line.includes('甲') && line.includes('失败'))).toBe(false);
    expect(
      battle.eventResponses.map((response) => [response.spell, response.state]).reverse(),
    ).toEqual([
      ['甲', 'success'],
      ['乙', 'failed'],
    ]);
    expect(battle.eventResponses[0].error).toBeTruthy();
    battle.restart();
    expect(battle.eventResponses).toHaveLength(0);
  });
});

describe('法球实战结算', () => {
  it('过期弹道只退款未释放余额且不会从主人未来法力续费', () => {
    const battle = makeBattle();
    const caster = battle.player;
    caster.mana -= 10;
    const p = battle.world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 800,
      y: 800,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
      life: 0.01,
    })!;
    battle.world.injectEntityEnergy(p.id, caster.id, 'damage', 2);
    const afterFunding = caster.mana;
    battle.update(0.02);
    expect(battle.world.projectiles).not.toContain(p);
    expect(battle.world.resourceLedger.balance(p.id).damage).toBe(0);
    expect(battle.world.refundEntityEnergy(p.id)).toBe(1.6);
    expect(caster.mana).toBeGreaterThanOrEqual(afterFunding);
    expect(battle.world.resourceLedger.snapshot().conserved).toBe(true);
  });
});

describe('玩家操作', () => {
  it('实战中保留冲量惯性，降低 speedMax 后才逐渐减速，越权探查拒绝', () => {
    const b = makeBattle();
    const player = b.player;
    expect(b.world.applyImpulse(player.id, { x: 100, y: 0 })).toBe(true);
    const afterImpulse = player.velocity.x;
    expect(afterImpulse).toBeGreaterThan(0);
    player.attr.speed = 20;
    expect(player.velocity.x).toBe(afterImpulse);
    run(b, 0.05);
    expect(player.velocity.x).toBeGreaterThan(0);
    expect(player.velocity.x).toBeLessThan(afterImpulse);

    const foe = b.world.actors.find((actor) => actor.faction === 'foe')!;
    player.x = foe.x - 40;
    player.y = foe.y;
    expect(b.world.senseQuote(player, foe.id, 'position')).not.toBeNull();
    expect(b.world.senseQuote(player, foe.id, 'hp')).toBeNull();
    expect(b.world.senseQuote(player, 999999, 'position')).toBeNull();
  });

  it('鼠标更新基础朝向，覆写到期依次恢复有效下层与最新瞄准', () => {
    const b = makeBattle();
    const actor = b.player;
    expect(b.world.applyEntityControl(actor.id, 'rotation', { x: 0, y: 1 }, 2)).toBe(true);
    expect(
      b.world.applyEntityControl(actor.id, 'rotation', { x: -1, y: 0 }, 1, {
        controllerId: actor.id,
      }),
    ).toBe(true);
    b.aimAt(actor.x, actor.y - 100);
    b.world.recompute(actor);
    expect(actor.baseAim).toEqual({ x: 0, y: -1 });
    expect(actor.aim).toEqual({ x: -1, y: 0 });
    b.world.advanceControlTime(1);
    expect(actor.aim).toEqual({ x: 0, y: 1 });
    b.world.advanceControlTime(1);
    expect(actor.aim).toEqual({ x: 0, y: -1 });
    b.aimAt(actor.x + 100, actor.y);
    expect(actor.aim).toEqual({ x: 1, y: 0 });
  });

  it('妖兽每帧追踪不会覆盖控制朝向，到期使用最新追踪方向', () => {
    const b = makeBattle();
    const foe = b.world.actors.find((actor) => actor.faction === 'foe')!;
    foe.base.speed = 0;
    foe.attackTimer = 100;
    b.world.recompute(foe);
    expect(b.world.applyEntityControl(foe.id, 'rotation', { x: 0, y: 1 }, 1)).toBe(true);
    b.player.x = foe.x - 100;
    b.player.y = foe.y;
    b.update(0.1);
    expect(foe.baseAim).toEqual({ x: -1, y: 0 });
    expect(foe.aim).toEqual({ x: 0, y: 1 });
    b.player.x = foe.x;
    b.player.y = foe.y - 100;
    b.update(0.1);
    expect(foe.baseAim).toEqual({ x: 0, y: -1 });
    expect(foe.aim).toEqual({ x: 0, y: 1 });
    b.world.advanceControlTime(1);
    expect(foe.aim).toEqual({ x: 0, y: -1 });
  });

  it('WASD 能驱动移动', () => {
    const b = makeBattle();
    const x0 = b.player.x;
    b.input.right = true;
    run(b, 0.5);
    b.input.right = false;
    expect(b.player.x).toBeGreaterThan(x0 + 40);
  });

  it('施法需要时间，不是瞬间完成', () => {
    const b = new Battle(parseSpellbook(readFileSync(SRC, 'utf8')), {
      playerAttrs: { manaRegen: 0 },
    });
    // 固定目标位置，关闭攻击，隔离施法耗时与自然回蓝/受击打断。
    for (const a of b.world.actors) {
      if (a.faction !== 'foe') continue;
      a.base.speed = 0;
      a.attackTimer = 100;
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
    expect(cast.vm.spentTicks).toBeLessThanOrEqual(15);
  });

  it('同槽施法中不能重入，结束后无需冷却即可再次施放', () => {
    const b = new Battle(parseSpellbook('spell 连发 @cooldown=60 { 自身位置() }'), {
      playerBindings: { '1': '连发' },
    });

    expect(b.pressSlot('1')).toBe(true);
    expect(b.pressSlot('1')).toBe(false);
    run(b, 0.2);
    expect(b.activeCasts(b.player.id)).toHaveLength(0);
    expect(b.pressSlot('1')).toBe(false);
    b.releaseSlot('1');
    expect(b.pressSlot('1')).toBe(true);
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
    expect(b.activeCasts(b.player.id)[0].fired).toBeGreaterThan(1);
    expect(b.world.controlRecordSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: b.player.id, propertyKey: 'armor', mode: 'maintain' }),
      ]),
    );
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
      playerAttrs: { manaMax: 25, manaRegen: 0 },
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

    // 自身位置现在每次消耗 1 tick；按实际程序工作量等待自然结束。
    const ticks = analyzeBook(book)['甲'].tickWorst;
    run(b, (ticks * TICK_MS) / (1000 * b.player.attr.castSpeed) + 0.1);
    expect(b.activeCasts(b.player.id)).toHaveLength(0);
    expect(b.stats.backfires).toBe(1);
    expect(b.stats.interrupts).toBe(0);
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

describe('控制会话与战斗施法生命周期', () => {
  const spell = 'spell 维持 @kind=duration @period=10 @duration=3 { 调整护体(自身实体(), 3, 0) }';

  function controlledBattle(source = spell, manaMax = 100): Battle {
    const battle = new Battle(parseSpellbook(source), {
      playerAttrs: { manaMax, manaRegen: 0 },
      playerBindings: { '1': '维持' },
    });
    for (const foe of battle.world.actors.filter((actor) => actor.faction === 'foe')) {
      foe.base.speed = 0;
      foe.bindings = {};
      battle.world.recompute(foe);
    }
    return battle;
  }

  function startMaintaining(battle: Battle, slot = '1'): void {
    expect(battle.castPlayer(slot)).toBe(true);
    for (let i = 0; i < 50 && battle.world.controlRecordSnapshot().length === 0; i++) {
      battle.update(0.01);
    }
    expect(battle.world.controlRecordSnapshot().length).toBeGreaterThan(0);
  }

  function advanceToNextPayment(battle: Battle): void {
    const next = Math.min(
      ...battle.world.controlRecordSnapshot().map((record) => record.nextPaymentAt!),
    );
    battle.update(next - battle.world.controlTimeNow);
  }

  it('无限维持按模拟时间持续扣费，耗尽时清理租约并结束施法', () => {
    const battle = controlledBattle(spell, 16);
    startMaintaining(battle);
    const afterStart = battle.player.mana;
    const cast = battle.activeCasts(battle.player.id)[0];
    const paidMana = cast.controlCharge.mana;
    expect(paidMana).toBeGreaterThan(0);
    expect(cast.controlCharge.ticks).toBeGreaterThan(0);
    advanceToNextPayment(battle);
    expect(battle.player.mana).toBeLessThan(afterStart);
    expect(cast.controlCharge.mana).toBeGreaterThan(paidMana);
    expect(battle.world.controlRecordSnapshot()[0].paidPeriods).toBe(2);
    advanceToNextPayment(battle);
    expect(battle.world.controlRecordSnapshot()).toHaveLength(0);
    expect(battle.log.join(' ')).toContain('维持结束');
    expect(battle.log.join(' ')).toContain('法力不足');
    expect(battle.player.attr.armor).toBe(battle.player.base.armor);
    battle.update(0.01);
    expect(battle.activeCasts(battle.player.id)).toHaveLength(0);
    expect(battle.stats.backfires).toBe(1);
  });

  it('暂停不续费，大步长跨过多个周期仍逐次结算', () => {
    const battle = controlledBattle();
    startMaintaining(battle);
    const mana = battle.player.mana;
    battle.setPaused(true);
    battle.update(1);
    expect(battle.player.mana).toBe(mana);
    battle.setPaused(false);
    battle.update(0.75);
    expect(battle.world.controlRecordSnapshot()[0].paidPeriods).toBe(4);
    expect(battle.player.mana).toBeLessThan(mana);
  });

  it('duration 重启 VM 后仍持有同一个控制会话', () => {
    const battle = controlledBattle(
      'spell 维持 @kind=duration @period=0.3 @duration=2 { 调整护体(自身实体(), 3, 0) }',
      300,
    );
    startMaintaining(battle);
    const sessionId = battle.world.controlRecordSnapshot()[0].controllerSessionId;
    battle.update(0.8);
    expect(battle.activeCasts(battle.player.id)[0].fired).toBeGreaterThan(1);
    expect(battle.world.controlRecordSnapshot()[0].controllerSessionId).toBe(sessionId);
    battle.update(1.3);
    expect(battle.activeCasts(battle.player.id)).toHaveLength(0);
    expect(battle.world.controlRecordSnapshot()).toHaveLength(0);
  });

  it('瞬发施法完成时立即释放维持租约', () => {
    const battle = controlledBattle('spell 维持 { 调整护体(自身实体(), 3, 0) }');
    battle.castPlayer('1');
    battle.update(0.25);
    battle.update(0.1);
    expect(battle.activeCasts(battle.player.id)).toHaveLength(0);
    expect(battle.world.controlRecordSnapshot()).toHaveLength(0);
  });

  it('主动结束、受击打断和目标死亡立即释放维持', () => {
    const ending = controlledBattle(
      'spell 维持 @kind=duration @period=10 @duration=3 { 调整护体(自身实体(), 3, 0) 结束施法() }',
    );
    ending.castPlayer('1');
    ending.update(0.25);
    ending.update(0.1);
    expect(ending.world.controlRecordSnapshot()).toHaveLength(0);
    expect(ending.activeCasts(ending.player.id)).toHaveLength(0);

    const interrupted = controlledBattle();
    startMaintaining(interrupted);
    interrupted.world.damage(interrupted.player.id, 1);
    expect(interrupted.world.controlRecordSnapshot()).toHaveLength(0);
    expect(interrupted.activeCasts(interrupted.player.id)).toHaveLength(0);

    const dead = controlledBattle();
    startMaintaining(dead);
    dead.world.damage(dead.player.id, 9999);
    expect(dead.world.controlRecordSnapshot()).toHaveLength(0);
  });

  it('并发会话共用当前法力，周期结算不复制余额', () => {
    const battle = controlledBattle(
      `spell 维持 @kind=duration @period=10 @duration=3 { 调整护体(自身实体(), 3, 0) }
       spell 并行 @kind=duration @period=10 @duration=3 { 调整护体(自身实体(), 3, 0) }`,
      23,
    );
    battle.setBinding('2', '并行');
    expect(battle.castPlayer('1')).toBe(true);
    expect(battle.castPlayer('2')).toBe(true);
    for (let i = 0; i < 50 && battle.world.controlRecordSnapshot().length < 2; i++) {
      battle.update(0.01);
    }
    expect(battle.world.controlRecordSnapshot()).toHaveLength(2);
    advanceToNextPayment(battle);
    expect(battle.world.controlRecordSnapshot()).toHaveLength(1);
    expect(battle.player.mana).toBeGreaterThanOrEqual(0);
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
    b.world.setActorAim(b.player, { x: 1, y: 0 });
  }

  it('蓄力火球：按住蓄力、蓄满后松开则发射', () => {
    const b = makeBattle();
    quiet(b);
    b.setBinding('5', '蓄力火球');

    expect(b.pressSlot('5')).toBe(true); // 按下 → 起手持续施法
    run(b, 1.2); // 蓄力超过 0.8s 阈值
    b.releaseSlot('5'); // 松开
    run(b, 0.4); // 松开边沿后还需支付五参法球的运动与伤害储能 tick

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

describe('显式蓄力会话', () => {
  function chargeBattle(mode: 'prepare' | 'projectile', manaMax = 200): Battle {
    const source =
      mode === 'prepare'
        ? 'spell 蓄时 @charge=prepare @duration=0.5 @period=0.25 { 创建弹道(自身位置(), 准星方向(), 380, 8, 2) }'
        : 'spell 持球 @charge=projectile @chargeMana=10 @duration=2 @period=0.25 { }';
    const battle = new Battle(parseSpellbook(source), {
      playerAttrs: { manaMax, manaRegen: 0 },
      playerBindings: { '5': mode === 'prepare' ? '蓄时' : '持球' },
    });
    for (const foe of battle.world.actors.filter((actor) => actor.faction === 'foe')) {
      foe.base.speed = 0;
      foe.bindings = {};
      battle.world.recompute(foe);
    }
    return battle;
  }

  it('按键先入意图；蓄时提前松开取消，完成后松开只发布一次', () => {
    const battle = chargeBattle('prepare');
    expect(battle.pressSlot('5')).toBe(true);
    expect(battle.chargeSessions.size).toBe(0);
    battle.update(0.01);
    expect(battle.chargeSessions.size).toBe(1);
    battle.releaseSlot('5');
    battle.update(0.01);
    expect(battle.finishedCharges[0].terminal).toBe('early-release');
    expect(battle.world.projectiles).toHaveLength(0);
    battle.pressSlot('5');
    battle.update(0.01);
    run(battle, 0.5);
    expect(battle.world.projectiles).toHaveLength(0);
    expect([...battle.chargeSessions.values()][0].workTicks).toBeGreaterThan(0);
    battle.releaseSlot('5');
    battle.releaseSlot('5');
    battle.update(0.01);
    run(battle, 0.3);
    expect(battle.finishedCharges[1].terminal).toBe('released');
    expect(battle.world.projectiles).toHaveLength(1);
  });

  it('蓄时在取消、打断、死亡、耗尽和超时后不会发布效果', () => {
    for (const reason of ['cancelled', 'interrupted', 'death', 'exhausted', 'expired'] as const) {
      const battle = chargeBattle('prepare', reason === 'exhausted' ? 1 : 200);
      battle.pressSlot('5');
      battle.update(0.01);
      const session = [...battle.chargeSessions.values()][0];
      if (reason === 'cancelled') battle.cancelCharge('5');
      if (reason === 'interrupted') battle.world.damage(battle.player.id, 1);
      if (reason === 'death') battle.world.damage(battle.player.id, 9999);
      if (reason === 'exhausted') run(battle, 0.3);
      if (reason === 'expired') run(battle, 1.1);
      expect(session.terminal).toBe(reason);
      battle.releaseSlot('5');
      battle.update(0.01);
      expect(battle.world.projectiles).toHaveLength(0);
      expect(battle.finishedCharges).toHaveLength(1);
    }
  });

  it('持球周期注能，释放激活一次且账本守恒', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    const session = [...battle.chargeSessions.values()][0];
    const projectile = battle.world.ownedProjectile(battle.player.id, session.projectileId!)!;
    expect(projectile.active).toBe(false);
    run(battle, 0.5);
    expect(session.periods).toBe(2);
    expect(battle.world.resourceLedger.balance(projectile.id).damage).toBe(16);
    battle.releaseSlot('5');
    battle.update(0.01);
    expect(session.terminal).toBe('released');
    expect(projectile.active).toBe(true);
    expect(projectile.damage).toBe(16);
    expect(battle.world.resourceLedger.snapshot().conserved).toBe(true);
    battle.releaseSlot('5');
    expect(battle.finishedCharges).toHaveLength(1);
  });

  it('持球首周期前松开取消且不会发射', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.releaseSlot('5');
    battle.update(0.01);
    expect(battle.finishedCharges[0].terminal).toBe('early-release');
    expect(battle.world.projectiles).toHaveLength(0);
  });

  it('10 M 注成 8 E，做功 3 E 后取消最多退 5 M，重复取消不再退款', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    const session = [...battle.chargeSessions.values()][0];
    run(battle, 0.25);
    const id = session.projectileId!;
    expect(battle.world.resourceLedger.balance(id).damage).toBe(8);
    expect(battle.world.resourceLedger.consume(id, 'damage', 3, 'damage')).toBe(true);
    const before = battle.player.mana;
    battle.cancelCharge('5');
    expect(battle.player.mana - before).toBe(5);
    battle.cancelCharge('5');
    expect(battle.player.mana - before).toBe(5);
    expect(battle.world.resourceLedger.snapshot().conserved).toBe(true);
  });

  it('取消、受击、死亡、耗尽、目标消失均只结算一次', () => {
    for (const reason of [
      'cancelled',
      'interrupted',
      'death',
      'exhausted',
      'target-lost',
    ] as const) {
      const battle = chargeBattle('projectile', reason === 'exhausted' ? 13 : 200);
      battle.pressSlot('5');
      battle.update(0.01);
      const session = [...battle.chargeSessions.values()][0];
      const id = session.projectileId!;
      if (reason === 'cancelled') battle.cancelCharge('5');
      if (reason === 'interrupted') battle.world.damage(battle.player.id, 1);
      if (reason === 'death') battle.world.damage(battle.player.id, 9999);
      if (reason === 'exhausted') run(battle, 0.3);
      if (reason === 'target-lost') battle.world.removeProjectile(id);
      if (reason === 'target-lost') battle.update(0.01);
      expect(session.terminal).toBe(reason);
      battle.cancelCharge('5');
      battle.releaseSlot('5');
      expect(battle.finishedCharges).toHaveLength(1);
      expect(battle.world.resourceLedger.snapshot().conserved).toBe(true);
    }
  });

  it('目标死亡使持球撤销；同刻松开与打断以先提交的原因结算', () => {
    const lost = chargeBattle('projectile');
    lost.pressSlot('5');
    lost.update(0.01);
    const held = [...lost.chargeSessions.values()][0];
    lost.world.damage(held.targetId!, 9999);
    lost.releaseSlot('5');
    lost.update(0.01);
    expect(held.terminal).toBe('target-lost');

    const interrupted = chargeBattle('projectile');
    interrupted.pressSlot('5');
    interrupted.update(0.01);
    run(interrupted, 0.3);
    const session = [...interrupted.chargeSessions.values()][0];
    interrupted.releaseSlot('5');
    interrupted.world.damage(interrupted.player.id, 1);
    interrupted.update(0.01);
    expect(session.terminal).toBe('interrupted');
    expect(interrupted.finishedCharges).toHaveLength(1);
  });

  it('死亡账户不接受持球余额退款', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    const session = [...battle.chargeSessions.values()][0];
    run(battle, 0.3);
    const mana = battle.player.mana;
    battle.world.damage(battle.player.id, 9999);
    expect(session.terminal).toBe('death');
    expect(battle.player.mana).toBe(mana);
    expect(battle.world.resourceLedger.snapshot().conserved).toBe(true);
  });

  it('暂停冻结周期并缓存有序输入，恢复先结算已到期会话', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    const session = [...battle.chargeSessions.values()][0];
    const mana = battle.player.mana;
    battle.setPaused(true);
    battle.releaseSlot('5');
    battle.update(1);
    expect(battle.player.mana).toBe(mana);
    expect(session.terminal).toBeNull();
    session.elapsed = session.duration;
    battle.setPaused(false);
    battle.update(0.01);
    expect(session.terminal).toBe('expired');
    expect(battle.finishedCharges).toHaveLength(1);
  });

  it('暂停中松开会在恢复后只发射一次', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    run(battle, 0.3);
    const session = [...battle.chargeSessions.values()][0];
    const mana = battle.player.mana;
    battle.setPaused(true);
    battle.releaseSlot('5');
    battle.update(1);
    expect(battle.player.mana).toBe(mana);
    battle.setPaused(false);
    battle.update(0.01);
    expect(session.terminal).toBe('released');
    expect(battle.finishedCharges).toHaveLength(1);
  });

  it('暂停输入缓存溢出时取消会话，恢复不重放部分意图', () => {
    const battle = chargeBattle('projectile');
    battle.pressSlot('5');
    battle.update(0.01);
    const session = [...battle.chargeSessions.values()][0];
    battle.setPaused(true);
    for (let i = 0; i < 33; i++) {
      battle.releaseSlot('5');
      battle.pressSlot('5');
    }
    battle.setPaused(false);
    battle.update(0.01);
    expect(session.terminal).toBe('cancelled');
    expect(battle.chargeSessions.size).toBe(0);
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
