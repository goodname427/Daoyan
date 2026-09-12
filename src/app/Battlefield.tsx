import { useEffect, useRef } from 'react';

export interface BattleEntity {
  id: number;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

interface Props {
  entities: BattleEntity[];
  hitId: number | null;
}

const W = 920;
const H = 400;
const SCALE = 0.5;

export function Battlefield({ entities, hitId }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cx = W / 2;
    const cy = H / 2;
    const toX = (x: number) => cx + x * SCALE;
    const toY = (y: number) => cy + y * SCALE;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, W, H);

    // 网格：每 100 单位一格
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let v = -400; v <= 400; v += 100) {
      ctx.beginPath();
      ctx.moveTo(toX(v), 0);
      ctx.lineTo(toX(v), H);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, toY(v));
      ctx.lineTo(W, toY(v));
      ctx.stroke();
    }

    // 感知半径参考圈
    ctx.strokeStyle = 'rgba(120,180,255,0.15)';
    ctx.setLineDash([4, 6]);
    for (const r of [200, 400]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * SCALE, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 命中射线
    if (hitId !== null) {
      const t = entities.find((e) => e.id === hitId);
      if (t) {
        ctx.strokeStyle = '#e8c37a';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(toX(t.x), toY(t.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 敌人
    for (const e of entities) {
      const x = toX(e.x);
      const y = toY(e.y);
      const isHit = e.id === hitId;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      if (!e.alive) {
        ctx.strokeStyle = '#4a5060';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = isHit ? '#ff7a5c' : '#c0504d';
        ctx.fill();
        if (isHit) {
          ctx.strokeStyle = '#e8c37a';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      ctx.fillStyle = '#9aa4b8';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`#${e.id}`, x, y - 14);
      ctx.fillText(`${Math.max(0, e.hp)}`, x, y + 24);
    }

    // 施法者
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#e8c37a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,195,122,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#e8c37a';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('自身', cx, cy - 22);
  }, [entities, hitId]);

  return <canvas ref={ref} width={W} height={H} className="battlefield" />;
}
