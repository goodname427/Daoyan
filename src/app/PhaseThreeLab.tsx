import { useMemo, useState } from 'react';

import { parseSpellbook, World } from '../core/index';
import type { SpellBook, WorldEventType } from '../core/index';
import { Battle } from '../game/battle';

const SAMPLE_SOURCE = `spell 沙盒回响甲 { 瞬移(自身位置()) }
spell 沙盒回响乙 { 瞬移(自身位置()) }
spell 沙盒蓄时 @charge=prepare @duration=0.5 @period=0.25 { 创建弹道(自身位置(), 准星方向(), 380, 8, 2) }
spell 沙盒持球 @charge=projectile @chargeMana=5 @duration=2 @period=0.25 { }`;

const EVENT_NAMES: Record<WorldEventType, string> = {
  damage: '受击',
  collision: '碰撞',
  'mana-exhausted': '法力耗尽',
  disappear: '实体消失',
};
const END_NAMES = {
  released: '合法松开',
  'early-release': '提前松开',
  interrupted: '受击打断',
  cancelled: '主动取消',
  death: '施法者死亡',
  exhausted: '法力耗尽',
  'target-lost': '目标失效',
  expired: '持有到期',
  pause: '暂停并恢复',
} as const;

type EndScenario = keyof typeof END_NAMES;

function sandboxBook(book: SpellBook): SpellBook {
  const samples = parseSpellbook(SAMPLE_SOURCE);
  return { ...samples, ...book };
}

function accountText(battle: Battle): string {
  const account = battle.world.resourceLedger.manaAccountSnapshot(battle.player.id);
  return account
    ? `余额 ${battle.player.mana.toFixed(1)}，累计付款 ${(account.paid / 1_000_000).toFixed(1)}，退款 ${(account.refunded / 1_000_000).toFixed(1)}，账目${account.conserved ? '守恒' : '待核对'}`
    : '账户尚无记录';
}

function freezeFoes(battle: Battle): void {
  for (const foe of battle.world.hostilesOf('player')) {
    foe.base.speed = 0;
    foe.attackTimer = 100;
    battle.world.recompute(foe);
  }
}

export function PhaseThreeLab({ book }: { book: SpellBook | null }) {
  const [type, setType] = useState<WorldEventType>('damage');
  const [first, setFirst] = useState('沙盒回响甲');
  const [second, setSecond] = useState('沙盒回响乙');
  const [chargeSpell, setChargeSpell] = useState('沙盒蓄时');
  const [eventResult, setEventResult] = useState('');
  const [chargeResult, setChargeResult] = useState('');
  const [monitorResult, setMonitorResult] = useState('');
  const available = useMemo(() => (book ? sandboxBook(book) : null), [book]);
  const names = available ? Object.keys(available) : [];
  const chargeNames = available
    ? names.filter(
        (name) =>
          available[name].meta?.charge === 'prepare' ||
          available[name].meta?.charge === 'projectile',
      )
    : [];

  const rehearseEvent = (): void => {
    if (!available) return;
    try {
      const battle = new Battle(available, {
        autoStart: false,
        playerAttrs: { manaMax: 25, manaRegen: 0 },
      });
      battle.start();
      freezeFoes(battle);
      const foe = battle.world.hostilesOf('player')[0];
      if (!foe) throw new Error('沙盒没有可用目标');
      const accepted = [first, second].map((spell, index) =>
        spell
          ? battle.subscribeSpellEvent(battle.player.id, `lab:${type}:${index}`, type, spell)
          : null,
      );
      if (type === 'damage') battle.world.damage(battle.player.id, 2, false, foe.id);
      else if (type === 'collision')
        battle.world.commitActorContacts([
          { sourceId: foe.id, targetId: battle.player.id, x: battle.player.x, y: battle.player.y },
        ]);
      else if (type === 'mana-exhausted')
        battle.world.resourceLedger.payMana(
          battle.player.id,
          battle.player.mana - 0.5,
          'lab-exhaustion',
        );
      else battle.world.damage(foe.id, foe.hp + 1, false, battle.player.id);
      battle.world.dispatchWorldEvents();
      for (
        let step = 0;
        step < 20 && battle.eventResponses.some((response) => response.state === 'running');
        step++
      )
        battle.update(0.05);
      const responses = battle.eventResponses
        .slice()
        .reverse()
        .map(
          (response) =>
            `${response.spell}：${response.state === 'success' ? '成功' : response.state === 'failed' ? `失败 ${response.error}` : '执行中'}，法力 ${response.mana.toFixed(1)} / ${response.ticks} tick`,
        );
      setEventResult(
        `${EVENT_NAMES[type]}已由世界事务提交；获准订阅 ${accepted.filter((id) => id !== null).length} 个。${responses.join('；') || '无响应'}。${accountText(battle)}`,
      );
    } catch (error) {
      setEventResult(`沙盒失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const rehearseCharge = (scenario: EndScenario): void => {
    if (!available || !available[chargeSpell]) return;
    try {
      const battle = new Battle(available, {
        autoStart: true,
        playerAttrs: { manaMax: 120, manaRegen: 0 },
        playerBindings: { '5': chargeSpell },
      });
      freezeFoes(battle);
      battle.pressSlot('5');
      battle.update(0.01);
      const session = battle.chargeSessions.get(`${battle.player.id}:5`);
      if (!session) throw new Error('会话未能启动，请检查法术与起手费用');
      if (scenario === 'released') {
        battle.update(session.mode === 'prepare' ? 0.6 : 0.3);
        battle.releaseSlot('5');
      } else if (scenario === 'early-release') battle.releaseSlot('5');
      else if (scenario === 'interrupted') battle.world.damage(battle.player.id, 1);
      else if (scenario === 'cancelled') battle.cancelCharge('5');
      else if (scenario === 'death') battle.world.damage(battle.player.id, 1000);
      else if (scenario === 'exhausted') {
        battle.world.resourceLedger.payMana(
          battle.player.id,
          Math.max(0, battle.player.mana - 0.5),
          'lab-exhaustion',
        );
        battle.update(0.3);
      } else if (scenario === 'target-lost') {
        const target = session.targetId === null ? null : battle.world.byId(session.targetId);
        if (target) battle.world.damage(target.id, target.hp + 1);
        else if (session.projectileId !== null) battle.world.removeProjectile(session.projectileId);
      } else if (scenario === 'expired') battle.update(session.mode === 'prepare' ? 1.1 : 2.1);
      else {
        battle.setPaused(true);
        const frozen = session.elapsed;
        battle.update(0.5);
        battle.setPaused(false);
        battle.update(0.25);
        setChargeResult(
          `暂停时 ${frozen.toFixed(2)} → ${frozen.toFixed(2)} 秒；恢复后 ${session.elapsed.toFixed(2)} 秒。${accountText(battle)}`,
        );
        return;
      }
      battle.update(0.01);
      setChargeResult(
        `${chargeSpell} · ${END_NAMES[scenario]} → ${session.terminal ?? session.state}；已付工作 ${session.workTicks.toFixed(0)} tick；${accountText(battle)}`,
      );
    } catch (error) {
      setChargeResult(`沙盒失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const rehearseMonitor = (): void => {
    const world = new World();
    const owner = world.spawnActor({ faction: 'player', x: 0, y: 0, attrs: { manaMax: 80 } });
    const target = world.spawnActor({ faction: 'foe', x: 10, y: 0, attrs: { hpMax: 100 } });
    world.grantSenseField(owner.id, target.id, 'position', {
      shenshiUpperBound: target.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    world.resourceLedger.payMana(owner.id, 1, 'monitor-start');
    const id = world.startActiveMonitor({
      ownerId: owner.id,
      payerId: owner.id,
      targetId: target.id,
      field: 'position',
      intervalSeconds: 0.25,
      periods: 2,
    });
    if (id === null) {
      setMonitorResult('监控未获准；起手尝试已付费。');
      return;
    }
    world.advanceControlTime(0.25);
    const snapshot = world.activeMonitorSnapshot(id, owner.id);
    world.stopActiveMonitor(id, owner.id);
    const paid = world.resourceLedger.manaAccountSnapshot(owner.id)?.paid ?? 0;
    world.advanceControlTime(0.5);
    const after = world.resourceLedger.manaAccountSnapshot(owner.id)?.paid ?? 0;
    setMonitorResult(
      `位置快照 ${snapshot?.latest?.ok ? JSON.stringify(snapshot.latest.value) : '尚未扫描'}；扫描已付 ${snapshot?.paidMana.toFixed(1) ?? 0} 法力 / ${snapshot?.paidTicks ?? 0} tick；关闭后新增费用 ${(after - paid) / 1_000_000}。`,
    );
  };

  return (
    <section className="phase-three-lab" aria-label="第三期沙盒复现">
      <h3>第三期沙盒复现</h3>
      <p className="muted small">
        以下操作在隔离世界执行，不修改共享法术书或演武存档。事件沙盒初始 25
        法力，可观察前后响应争用同一账户；示例可替换为当前书中的法术。
      </p>
      <label>
        被动事件
        <select
          aria-label="沙盒事件"
          value={type}
          onChange={(event) => setType(event.target.value as WorldEventType)}
        >
          {Object.entries(EVENT_NAMES).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {[first, second].map((spell, index) => (
        <label key={index}>
          响应法术 {index + 1}
          <select
            aria-label={`沙盒响应法术 ${index + 1}`}
            value={spell}
            onChange={(event) =>
              index === 0 ? setFirst(event.target.value) : setSecond(event.target.value)
            }
          >
            <option value="">—</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button type="button" className="mini" disabled={!available} onClick={rehearseEvent}>
        复现事件与双法术
      </button>
      {eventResult && (
        <p role="status" data-testid="event-rehearsal">
          {eventResult}
        </p>
      )}
      <button type="button" className="mini" onClick={rehearseMonitor}>
        复现付费监控与关闭
      </button>
      {monitorResult && (
        <p role="status" data-testid="monitor-rehearsal">
          {monitorResult}
        </p>
      )}
      <label>
        蓄力法术
        <select
          aria-label="沙盒蓄力法术"
          value={chargeSpell}
          onChange={(event) => setChargeSpell(event.target.value)}
        >
          {chargeNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <div className="phase-three-actions">
        {(Object.entries(END_NAMES) as Array<[EndScenario, string]>).map(([scenario, name]) => (
          <button
            type="button"
            className="mini"
            key={scenario}
            disabled={
              !available ||
              (scenario === 'target-lost' && available[chargeSpell]?.meta?.charge !== 'projectile')
            }
            onClick={() => rehearseCharge(scenario)}
          >
            {name}
          </button>
        ))}
      </div>
      {chargeResult && (
        <p role="status" data-testid="charge-rehearsal">
          {chargeResult}
        </p>
      )}
    </section>
  );
}
