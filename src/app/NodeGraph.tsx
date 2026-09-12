import { useCallback } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Expr, Spell, Stmt } from '../core/index';
import { T, getMeta, typeName } from '../core/index';

/**
 * 蓝图视图（阶段一：AST → 图，只读渲染）。
 *
 * 先把「图 ⇄ AST」的渲染方向打通 —— 节点按类型着色、端口按类型标注，
 * 连线即数据流。下一步才是反向编辑（拖节点 / 连线 → 产出 AST）。
 *
 * 即便只读，它也已经是有用的：直观展示法术结构，配合 DSL 编辑器一起看。
 */

const TYPE_COLOR: Record<string, string> = {
  num: '#6aa9ff',
  bool: '#7bd88f',
  vec2: '#e8c37a',
  entity: '#ff9a6a',
  list: '#c39bff',
  any: '#9aa4b8',
  void: '#4a5060',
};

function colorFor(t: { k: string }): string {
  return TYPE_COLOR[t.k] ?? '#9aa4b8';
}

interface NodeData {
  label: string;
  sub?: string;
  outType?: string;
  outColor?: string;
  inputs?: Array<{ id: string; label: string; type: string }>;
  kind: 'stmt' | 'expr';
}

function SpellNode({ data }: NodeProps<Node>) {
  const d = data as unknown as NodeData;
  const isStmt = d.kind === 'stmt';
  return (
    <div className="spell-node" style={{ borderColor: d.outColor ?? colorFor(T.any) }}>
      {isStmt && <Handle type="target" position={Position.Top} id="flow-in" />}
      {!isStmt && (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          style={{ background: d.outColor ?? colorFor(T.any) }}
        />
      )}
      <div className="spell-node-title">{d.label}</div>
      {d.sub && <div className="spell-node-sub">{d.sub}</div>}
      {d.inputs && d.inputs.length > 0 && (
        <div className="spell-node-ports">
          {d.inputs.map((p) => (
            <div key={p.id} className="port">
              <Handle
                type="target"
                position={Position.Left}
                id={p.id}
                style={{ background: colorFor({ k: p.type }) }}
              />
              <span style={{ color: colorFor({ k: p.type }) }}>{p.label}</span>
            </div>
          ))}
        </div>
      )}
      {isStmt && <Handle type="source" position={Position.Bottom} id="flow-out" />}
    </div>
  );
}

const nodeTypes = { spell: SpellNode };

/** 简单递归布局：语句纵向排列，表达式按深度向右展开 */
interface LayoutCtx {
  nodes: Node[];
  edges: Edge[];
  y: number;
}

function exprLabel(e: Expr): string {
  switch (e.k) {
    case 'lit':
      return e.v === null ? '空' : String(e.v);
    case 'var':
      return e.name;
    case 'index':
      return '取下标';
    case 'call':
      return e.name;
  }
}

function exprType(e: Expr): string {
  // call / var / index 节点没有 t 字段，需要按结构推断，否则读 undefined.k 崩
  switch (e.k) {
    case 'lit':
      return (e as unknown as { t: { k: string } }).t.k;
    case 'call':
      return getMeta(e.name)?.ret.k ?? 'any';
    case 'var':
      return 'any';
    case 'index':
      return 'any';
  }
}

let counter = 0;
function id(): string {
  counter += 1;
  return `n${counter}`;
}

/** 递归把一个表达式铺成节点，返回该表达式的节点 id（输出端口） */
function layExpr(
  e: Expr,
  depth: number,
  ctx: LayoutCtx,
  consumerHandle?: { target: string; handle: string },
): string {
  const myId = id();
  const inputs: NodeData['inputs'] = [];
  const childIds: string[] = [];

  if (e.k === 'call') {
    e.args.forEach((arg, i) => {
      const cid = layExpr(arg, depth + 1, ctx);
      childIds.push(cid);
      inputs!.push({ id: `in${i}`, label: `参数${i}`, type: exprType(arg) });
    });
  } else if (e.k === 'index') {
    const aId = layExpr(e.arr, depth + 1, ctx);
    const iId = layExpr(e.i, depth + 1, ctx);
    childIds.push(aId, iId);
    inputs!.push(
      { id: 'in0', label: '列表', type: 'list' },
      { id: 'in1', label: '下标', type: 'num' },
    );
  }

  const col = colorFor({ k: exprType(e) });
  ctx.nodes.push({
    id: myId,
    type: 'spell',
    position: { x: 240 + depth * 200, y: ctx.y },
    data: {
      kind: 'expr',
      label: exprLabel(e),
      outType: exprType(e),
      outColor: col,
      inputs,
    } as unknown as Record<string, unknown>,
  });
  ctx.y += 70;

  childIds.forEach((cid, i) => {
    ctx.edges.push({
      id: `e${counter}`,
      source: cid,
      sourceHandle: 'out',
      target: myId,
      targetHandle: `in${i}`,
      style: { stroke: colorFor({ k: inputs![i].type }) },
    });
    counter += 1;
  });

  if (consumerHandle) {
    ctx.edges.push({
      id: `e${counter}`,
      source: myId,
      sourceHandle: 'out',
      target: consumerHandle.target,
      targetHandle: consumerHandle.handle,
    });
    counter += 1;
  }

  return myId;
}

function stmtSummary(s: Stmt): string {
  switch (s.k) {
    case 'decl':
      return `${s.name}${s.t ? ': ' + typeName(s.t) : ''}`;
    case 'assign':
      return s.target.k === 'var' ? s.target.name : '列表元素';
    case 'expr':
      return '';
    case 'if':
      return '';
    case 'for':
      return `遍历 ${s.name}`;
    case 'repeat':
      return `${s.count} 次`;
    case 'break':
      return '';
    case 'free':
      return s.name;
    case 'return':
      return '';
  }
}

function stmtKind(s: Stmt): string {
  switch (s.k) {
    case 'decl':
      return '声明';
    case 'assign':
      return '赋值';
    case 'expr':
      return '执行';
    case 'if':
      return '若';
    case 'for':
      return '遍历';
    case 'repeat':
      return '重复';
    case 'break':
      return '中断';
    case 'free':
      return '释放';
    case 'return':
      return '返回';
  }
}

function layStmt(s: Stmt, idx: number, ctx: LayoutCtx, nextId?: string): string {
  const myId = id();
  const label = stmtKind(s);
  const sub = stmtSummary(s);
  let inputs: NodeData['inputs'] | undefined;
  let consumerHandle: { target: string; handle: string } | undefined = undefined;

  ctx.nodes.push({
    id: myId,
    type: 'spell',
    position: { x: 40, y: idx * 110 },
    data: {
      kind: 'stmt',
      label,
      sub,
      inputs,
    } as unknown as Record<string, unknown>,
  });

  // 给语句一个值输入端口（赋值/声明的初值 / 表达式语句 / return 的值 / if 的条件）
  let valueExpr: Expr | null = null;
  if (s.k === 'decl' && s.init) valueExpr = s.init;
  else if (s.k === 'assign') valueExpr = s.e;
  else if (s.k === 'expr') valueExpr = s.e;
  else if (s.k === 'return' && s.e) valueExpr = s.e;
  else if (s.k === 'if') valueExpr = s.cond;
  else if (s.k === 'for') valueExpr = s.list;

  if (valueExpr) {
    inputs = [{ id: 'in0', label: '值', type: exprType(valueExpr) }];
    (ctx.nodes[ctx.nodes.length - 1].data as unknown as NodeData).inputs = inputs;
    consumerHandle = { target: myId, handle: 'in0' };
    layExpr(valueExpr, 1, ctx, consumerHandle);
  }

  if (nextId) {
    ctx.edges.push({
      id: `e${counter}`,
      source: myId,
      sourceHandle: 'flow-out',
      target: nextId,
      targetHandle: 'flow-in',
      style: { stroke: '#4a5060' },
    });
    counter += 1;
  }

  return myId;
}

function buildGraph(spell: Spell): { nodes: Node[]; edges: Edge[] } {
  counter = 0;
  const ctx: LayoutCtx = { nodes: [], edges: [], y: 0 };

  // 入口节点
  const entryId = id();
  ctx.nodes.push({
    id: entryId,
    type: 'spell',
    position: { x: 40, y: -120 },
    data: {
      kind: 'stmt',
      label: `法术·${spell.name}`,
      sub: spell.params.map((p) => `${p.name}:${typeName(p.t)}`).join(' '),
    } as unknown as Record<string, unknown>,
  });

  // 逆序构建，便于把「下一个」指针连上
  let nextId: string | undefined = entryId;
  for (let i = spell.body.length - 1; i >= 0; i--) {
    nextId = layStmt(spell.body[i], i, ctx, nextId);
  }
  // 入口 → 第一条语句
  if (spell.body.length > 0) {
    ctx.edges.push({
      id: `e${counter}`,
      source: entryId,
      sourceHandle: 'flow-out',
      target: nextId!,
      targetHandle: 'flow-in',
      style: { stroke: '#4a5060' },
    });
  }

  return { nodes: ctx.nodes, edges: ctx.edges };
}

export function NodeGraph({ spell }: { spell: Spell | null }) {
  const { nodes, edges } = spell ? buildGraph(spell) : { nodes: [], edges: [] };

  const onInit = useCallback(() => {
    /* React Flow 初始化后可在这里 fitView，组件自身已设 fitView */
  }, []);

  if (!spell) {
    return (
      <div className="panel wide">
        <p className="muted">无可显示的法术</p>
      </div>
    );
  }

  return (
    <div className="panel wide graph-panel">
      <h2>节点图 · {spell.name}</h2>
      <div className="graph-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={onInit}
          fitView
          nodesDraggable
          nodesConnectable={false}
        >
          <Background color="#262e3a" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="muted small">
        当前为只读视图（AST → 图）。反向编辑（拖节点 / 连线产出 AST）是下一个迭代。
      </p>
    </div>
  );
}
