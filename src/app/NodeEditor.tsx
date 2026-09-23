import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { controlHelp } from './controlHelp';

import {
  T,
  publicMetas,
  analyzeBook,
  assignable,
  compileProgram,
  getMeta,
  parseSpellbook,
  serializeBook,
  typeName,
} from '../core/index';
import type { Expr, ListElem, Param, Spell, SpellBook, Stmt, Type } from '../core/index';

/**
 * 蓝图编辑器（反向方向：图 → AST）。
 *
 * 节点按类型着色，端口按类型标注，连线即数据流 / 控制流。
 * 编译按钮把图编译成 AST，复用同一套分析器 / VM 管线 ——
 * 与 DSL 编辑器、节点图（只读视图）三者产出同一份 AST。
 *
 * MVP 范围：声明 / 赋值 / 调用(施法) / 调用(取值) / 常量 / 变量引用 /
 *           若（then/else）/ 遍历 / 重复 / 中断 / 释放 / 返回。
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

function color(t: Type | { k: string }): string {
  return TYPE_COLOR[t.k] ?? '#9aa4b8';
}

// ---------------- 节点数据模型 ----------------

type NodeKind =
  | 'entry'
  | 'callstmt'
  | 'expr'
  | 'call'
  | 'const'
  | 'varref'
  | 'index'
  | 'decl'
  | 'assign'
  | 'if'
  | 'for'
  | 'repeat'
  | 'break'
  | 'free'
  | 'return';

interface BaseData {
  kind: NodeKind;
}
interface CallData extends BaseData {
  kind: 'callstmt' | 'call';
  meta: string;
}
interface ConstData extends BaseData {
  kind: 'const';
  value: string;
  ctype: 'num' | 'bool' | 'entity';
}
interface VarData extends BaseData {
  kind: 'varref';
  name: string;
}
interface IndexData extends BaseData {
  kind: 'index';
}
interface BreakData extends BaseData {
  kind: 'break';
}
interface ExprStmtData extends BaseData {
  kind: 'expr';
  expr: Expr;
}
interface DeclData extends BaseData {
  kind: 'decl';
  name: string;
  dtype: 'num' | 'bool' | 'vec2' | 'entity' | 'list';
  elem?: ListElem;
  cap?: number;
}
interface AssignData extends BaseData {
  kind: 'assign';
  name: string;
}
interface ForData extends BaseData {
  kind: 'for';
  varName: string;
}
interface RepeatData extends BaseData {
  kind: 'repeat';
  count: number;
}
interface FreeData extends BaseData {
  kind: 'free';
  name: string;
}
interface ReturnData extends BaseData {
  kind: 'return';
}
interface IfData extends BaseData {
  kind: 'if';
}
interface EntryData extends BaseData {
  kind: 'entry';
  name: string;
  ret: 'num' | 'bool' | 'vec2' | 'entity' | 'void';
  params?: Param[];
}

type Nd =
  | CallData
  | ExprStmtData
  | ConstData
  | VarData
  | IndexData
  | BreakData
  | DeclData
  | AssignData
  | ForData
  | RepeatData
  | FreeData
  | ReturnData
  | IfData
  | EntryData;

let seq = 0;
function nid(): string {
  seq += 1;
  return `e${seq}`;
}

// ---------------- 端口类型推断 ----------------

function outTypeOf(node: Node): Type {
  const d = node.data as unknown as Nd;
  if (d.kind === 'call') {
    return getMeta(d.meta)?.ret ?? T.any;
  }
  if (d.kind === 'const') {
    return d.ctype === 'entity' ? T.entity : d.ctype === 'bool' ? T.bool : T.num;
  }
  if (d.kind === 'varref') return T.any;
  if (d.kind === 'index') return T.any;
  return T.any;
}

/** 某节点 in{index} 端口期望的类型 */
function inTypeOf(node: Node, port: string): Type {
  const d = node.data as unknown as Nd;
  if (d.kind === 'call' || d.kind === 'callstmt') {
    const m = getMeta(d.meta);
    const i = Number(port.replace('in', ''));
    return m?.params[i]?.t ?? T.any;
  }
  if (d.kind === 'decl') return declType(d);
  if (d.kind === 'assign') return T.any;
  if (d.kind === 'index') return port === 'in0' ? T.list('any') : T.num;
  if (d.kind === 'if') return T.bool;
  if (d.kind === 'for') return T.list('any');
  if (d.kind === 'return') return T.any;
  return T.any;
}

function primType(k: 'num' | 'bool' | 'vec2' | 'entity'): Type {
  return k === 'num' ? T.num : k === 'bool' ? T.bool : k === 'vec2' ? T.vec2 : T.entity;
}

function declType(d: DeclData): Type {
  if (d.dtype === 'list') return T.list(d.elem ?? 'any', d.cap ?? 0);
  return primType(d.dtype);
}

function isStmtKind(k: NodeKind): boolean {
  return (
    k === 'callstmt' ||
    k === 'expr' ||
    k === 'decl' ||
    k === 'assign' ||
    k === 'if' ||
    k === 'for' ||
    k === 'repeat' ||
    k === 'break' ||
    k === 'free' ||
    k === 'return'
  );
}

function isFlowSourceKind(k: NodeKind): boolean {
  return k === 'entry' || isStmtKind(k);
}

// ---------------- 节点渲染 ----------------

function Port({ id, label, t, tip }: { id: string; label: string; t: Type; tip: string }) {
  return (
    <div className="port port-value" data-port-id={id} title={tip}>
      <Handle
        className="pin pin-value pin-value-input"
        type="target"
        position={Position.Left}
        id={id}
        aria-label={`值输入：${label}，${typeName(t)}`}
        title={tip}
        style={{ background: color(t) }}
      />
      <span style={{ color: color(t) }}>
        <b>输入</b> {label} · {typeName(t)}
      </span>
    </div>
  );
}

const NodeDataContext = createContext<(id: string, patch: Record<string, unknown>) => void>(
  () => {},
);

function SpellNode({ id, data }: NodeProps<Node>) {
  const d = data as unknown as Nd;
  const isStmt = isStmtKind(d.kind) || d.kind === 'entry';
  const outT = outTypeOf({ id, data } as Node);
  const metas = publicMetas();
  const updateNodeData = useContext(NodeDataContext);
  const nodeTip = descriptionOf(d);

  const setMeta = (m: string): void => {
    updateNodeData(id, { ...data, meta: m });
  };

  return (
    <div
      className={`spell-node node-${d.kind}`}
      title={nodeTip}
      aria-label={`${titleOf(d.kind)}节点：${nodeTip}`}
      style={{ borderColor: d.kind === 'entry' ? '#e8c37a' : color(outT) }}
    >
      {isStmtKind(d.kind) && (
        <Handle
          className="pin pin-flow pin-flow-input"
          type="target"
          position={Position.Top}
          id="flow-in"
          aria-label="控制流入口"
          title="控制流入口：连接上一条要执行的语句"
        />
      )}
      {d.kind !== 'entry' && d.kind !== 'callstmt' && d.kind !== 'call' && (
        <div className="spell-node-title">{titleOf(d.kind)}</div>
      )}

      {d.kind === 'entry' && (
        <>
          <div className="spell-node-title">法术·入口</div>
          <input
            className="node-input"
            value={d.name}
            placeholder="法术名"
            onChange={(e) => updateNodeData(id, { name: e.target.value })}
          />
        </>
      )}

      {(d.kind === 'callstmt' || d.kind === 'call') && (
        <>
          <div className="spell-node-title">{d.meta}</div>
          {controlHelp(d.meta) && (
            <div className="spell-node-sub control-node-help" title={controlHelp(d.meta)!.failure}>
              {controlHelp(d.meta)!.key} · {controlHelp(d.meta)!.effect}
              <br />
              时间 0 = 无限 · {controlHelp(d.meta)!.capability}
              <br />
              起手基础 + 动态；维持每 0.25 秒另付周期法力 / tick
            </div>
          )}
          <select
            className="node-input"
            value={d.meta}
            title={getMeta(d.meta)?.desc}
            onChange={(e) => setMeta(e.target.value)}
          >
            {metas.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {m.group}
              </option>
            ))}
          </select>
        </>
      )}

      {d.kind === 'const' && (
        <>
          <div className="spell-node-title">常量</div>
          <select
            className="node-input"
            value={d.ctype}
            onChange={(e) => updateNodeData(id, { ctype: e.target.value as ConstData['ctype'] })}
          >
            <option value="num">数</option>
            <option value="bool">布尔</option>
            <option value="entity">实体</option>
          </select>
          <input
            className="node-input"
            value={d.value}
            placeholder={d.ctype === 'bool' ? 'true/false' : d.ctype === 'entity' ? '空' : '0'}
            onChange={(e) => updateNodeData(id, { value: e.target.value })}
          />
        </>
      )}

      {d.kind === 'varref' && (
        <>
          <div className="spell-node-title">变量引用</div>
          <input
            className="node-input"
            value={d.name}
            placeholder="变量名"
            onChange={(e) => updateNodeData(id, { name: e.target.value })}
          />
        </>
      )}

      {d.kind === 'decl' && (
        <>
          <div className="spell-node-title">声明</div>
          <input
            className="node-input"
            value={d.name}
            placeholder="变量名"
            onChange={(e) => updateNodeData(id, { name: e.target.value })}
          />
          <select
            className="node-input"
            value={d.dtype}
            onChange={(e) => {
              const dtype = e.target.value as DeclData['dtype'];
              updateNodeData(id, {
                ...data,
                dtype,
                elem: dtype === 'list' ? (d.elem ?? 'any') : undefined,
                cap: dtype === 'list' ? (d.cap ?? 4) : undefined,
              });
            }}
          >
            <option value="num">数</option>
            <option value="bool">布尔</option>
            <option value="vec2">向量</option>
            <option value="entity">实体</option>
            <option value="list">列表</option>
          </select>
          {d.dtype === 'list' && (
            <div className="node-list-type">
              <select
                className="node-input"
                aria-label="列表元素类型"
                value={d.elem ?? 'any'}
                onChange={(e) => updateNodeData(id, { ...data, elem: e.target.value as ListElem })}
              >
                <option value="any">任意</option>
                <option value="num">数</option>
                <option value="bool">布尔</option>
                <option value="vec2">向量</option>
                <option value="entity">实体</option>
              </select>
              <input
                className="node-input"
                type="number"
                min={1}
                aria-label="列表容量"
                value={d.cap ?? 4}
                onChange={(e) =>
                  updateNodeData(id, { ...data, cap: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </div>
          )}
        </>
      )}

      {d.kind === 'assign' && (
        <>
          <div className="spell-node-title">赋值</div>
          <input
            className="node-input"
            value={d.name}
            placeholder="变量名"
            onChange={(e) => updateNodeData(id, { name: e.target.value })}
          />
        </>
      )}

      {d.kind === 'for' && (
        <>
          <div className="spell-node-title">遍历</div>
          <input
            className="node-input"
            value={d.varName}
            placeholder="元素变量名"
            onChange={(e) => updateNodeData(id, { varName: e.target.value })}
          />
        </>
      )}

      {d.kind === 'repeat' && (
        <>
          <div className="spell-node-title">重复</div>
          <input
            className="node-input"
            type="number"
            min={0}
            aria-label="重复次数"
            value={d.count}
            onChange={(e) =>
              updateNodeData(id, { count: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </>
      )}
      {d.kind === 'free' && (
        <>
          <div className="spell-node-title">释放</div>
          <input
            className="node-input"
            value={d.name}
            placeholder="变量名"
            onChange={(e) => updateNodeData(id, { name: e.target.value })}
          />
        </>
      )}

      {d.kind === 'if' && <div className="spell-node-title">若</div>}
      {d.kind === 'return' && <div className="spell-node-title">返回</div>}

      {/* 值输入端口 */}
      {inputPortIds(d).map((pid) => {
        const t = inTypeOf({ id, data } as Node, pid);
        const m = getMeta(d.kind === 'call' || d.kind === 'callstmt' ? d.meta : '');
        const plabel =
          d.kind === 'call' || d.kind === 'callstmt'
            ? (m?.params[Number(pid.replace('in', ''))]?.name ?? pid)
            : d.kind === 'index'
              ? pid === 'in0'
                ? '列表'
                : '索引'
              : inLabel(d.kind);
        const inputType = t === T.void ? T.any : t;
        const tip = `${plabel}：${typeName(inputType)}。连接一个兼容类型的值输出。`;
        return <Port key={pid} id={pid} label={plabel} t={inputType} tip={tip} />;
      })}

      {/* 值输出端口 */}
      {(d.kind === 'call' || d.kind === 'const' || d.kind === 'varref' || d.kind === 'index') && (
        <Handle
          className="pin pin-value pin-value-output"
          type="source"
          position={Position.Right}
          id="out"
          aria-label={`值输出：${typeName(outT)}`}
          title={`值输出：产生 ${typeName(outT)}，可连接到同类型输入`}
          style={{ background: color(outT) }}
        />
      )}

      {/* 体端口（if/for） */}
      {(d.kind === 'if' || d.kind === 'for' || d.kind === 'repeat') && (
        <Handle
          className="pin pin-body"
          type="source"
          position={Position.Right}
          id="body"
          aria-label={d.kind === 'if' ? '条件成立分支出口' : '循环体出口'}
          title={
            d.kind === 'if' ? '条件成立时从此处连接首先执行的语句' : '连接循环内部首先执行的语句'
          }
          style={{ top: 'auto', bottom: 8, background: '#6aa9ff' }}
        />
      )}
      {d.kind === 'if' && (
        <Handle
          className="pin pin-body"
          type="source"
          position={Position.Right}
          id="else"
          aria-label="条件不成立分支出口"
          title="条件不成立时从此处连接首先执行的语句"
          style={{ top: 28, background: '#c39bff' }}
        />
      )}

      {isStmt && (
        <Handle
          className="pin pin-flow pin-flow-output"
          type="source"
          position={Position.Bottom}
          id="flow-out"
          aria-label="控制流出口"
          title="控制流出口：连接下一条要执行的语句"
        />
      )}
    </div>
  );
}

function titleOf(k: NodeKind): string {
  switch (k) {
    case 'decl':
      return '声明';
    case 'assign':
      return '赋值';
    case 'if':
      return '若';
    case 'for':
      return '遍历';
    case 'return':
      return '返回';
    case 'callstmt':
      return '调用(施法)';
    case 'call':
      return '调用(取值)';
    case 'const':
      return '常量';
    case 'varref':
      return '变量引用';
    case 'expr':
      return '表达式';
    case 'index':
      return '列表索引';
    case 'repeat':
      return '重复';
    case 'break':
      return '中断';
    case 'free':
      return '释放';
    case 'entry':
      return '入口';
  }
}

function descriptionOf(d: Nd): string {
  if (d.kind === 'call' || d.kind === 'callstmt') {
    return getMeta(d.meta)?.desc ?? '调用一个元法术';
  }
  return NODE_DESCRIPTIONS[d.kind];
}

const NODE_DESCRIPTIONS: Record<NodeKind, string> = {
  entry: '法术执行的起点；从底部控制流出口连接第一条语句',
  callstmt: '执行一个不返回值的元法术',
  expr: '执行一个表达式',
  call: '调用元法术并从右侧输出返回值',
  const: '产生一个固定值',
  varref: '读取已经声明的变量值',
  index: '按索引读取列表中的值',
  decl: '声明变量，可从左侧接入初始值',
  assign: '把左侧输入写入指定变量',
  if: '条件成立或不成立时，分别执行对应分支体',
  for: '遍历左侧输入的列表，并执行右侧循环体',
  repeat: '按固定次数重复执行右侧循环体',
  break: '立即结束当前循环',
  free: '提前释放变量占用的神识',
  return: '结束法术，并可返回左侧输入值',
};

function inLabel(k: NodeKind): string {
  switch (k) {
    case 'decl':
      return '初值';
    case 'assign':
      return '值';
    case 'index':
      return '列表';
    case 'repeat':
      return '次数';
    case 'if':
      return '条件';
    case 'for':
      return '列表';
    case 'return':
      return '值';
    default:
      return '入';
  }
}

function inputPortIds(d: Nd): string[] {
  if (d.kind === 'call' || d.kind === 'callstmt') {
    const m = getMeta(d.meta);
    return m ? m.params.map((_, i) => `in${i}`) : [];
  }
  if (d.kind === 'index') return ['in0', 'in1'];
  if (
    d.kind === 'decl' ||
    d.kind === 'assign' ||
    d.kind === 'if' ||
    d.kind === 'for' ||
    d.kind === 'return'
  ) {
    return ['in0'];
  }
  return [];
}

const nodeTypes = { spell: SpellNode };

// ---------------- 图 → AST 编译 ----------------

function findEntry(nodes: Node[]): Node | null {
  return nodes.find((n) => (n.data as unknown as Nd).kind === 'entry') ?? null;
}

function outTarget(edges: Edge[], nodeId: string, handle: string): string | null {
  const e = edges.find((ed) => ed.source === nodeId && ed.sourceHandle === handle);
  return e ? e.target : null;
}

function inSource(edges: Edge[], nodeId: string, handle: string): string | null {
  const e = edges.find((ed) => ed.target === nodeId && ed.targetHandle === handle);
  return e ? e.source : null;
}

/** 从 startId 沿 flow-out 链收集语句 */
function chain(nodes: Node[], edges: Edge[], startId: string | null): Node[] {
  const out: Node[] = [];
  let cur = startId;
  let guard = 0;
  while (cur && guard++ < 200) {
    const node = nodes.find((n) => n.id === cur);
    if (!node) break;
    out.push(node);
    cur = outTarget(edges, node.id, 'flow-out');
  }
  return out;
}

function compileStmtChain(
  nodes: Node[],
  edges: Edge[],
  startId: string | null,
): { ok: true; body: Stmt[] } | { ok: false; error: string } {
  const body: Stmt[] = [];
  for (const node of chain(nodes, edges, startId)) {
    const result = compileStmt(nodes, edges, node.id);
    if (!result.ok) return result;
    body.push(result.s);
  }
  return { ok: true, body };
}

function compileExpr(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
): { ok: true; e: Expr } | { ok: false; error: string } {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: `找不到节点 ${nodeId}` };
  const d = node.data as unknown as Nd;
  if (d.kind === 'const') {
    const t = d.ctype === 'entity' ? T.entity : d.ctype === 'bool' ? T.bool : T.num;
    let v: number | boolean | null;
    if (d.ctype === 'entity') v = null;
    else if (d.ctype === 'bool') v = d.value === 'true';
    else v = Number(d.value) || 0;
    return { ok: true, e: { k: 'lit', v, t } };
  }
  if (d.kind === 'varref') return { ok: true, e: { k: 'var', name: d.name } };
  if (d.kind === 'index') {
    const arr = inSource(edges, nodeId, 'in0');
    const index = inSource(edges, nodeId, 'in1');
    if (!arr || !index) return { ok: false, error: `节点 ${nodeId} 缺少列表或索引参数` };
    const arrResult = compileExpr(nodes, edges, arr);
    const indexResult = compileExpr(nodes, edges, index);
    if (!arrResult.ok) return arrResult;
    if (!indexResult.ok) return indexResult;
    return { ok: true, e: { k: 'index', arr: arrResult.e, i: indexResult.e } };
  }
  if (d.kind === 'call') {
    const m = getMeta(d.meta);
    if (!m) return { ok: false, error: `未知元函数 ${d.meta}` };
    const args: Expr[] = [];
    for (let i = 0; i < m.params.length; i++) {
      const src = inSource(edges, nodeId, `in${i}`);
      if (!src) return { ok: false, error: `${d.meta} 缺第 ${i + 1} 个参数` };
      const r = compileExpr(nodes, edges, src);
      if (!r.ok) return r;
      args.push(r.e);
    }
    return { ok: true, e: { k: 'call', name: d.meta, args } };
  }
  return { ok: false, error: `节点 ${nodeId} 不是表达式` };
}

function compileStmt(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
): { ok: true; s: Stmt } | { ok: false; error: string } {
  const node = nodes.find((n) => n.id === nodeId)!;
  const d = node.data as unknown as Nd;

  const valIn = (handle = 'in0'): Expr | null => {
    const src = inSource(edges, nodeId, handle);
    if (!src) return null;
    const r = compileExpr(nodes, edges, src);
    return r.ok ? r.e : null;
  };

  switch (d.kind) {
    case 'callstmt': {
      const m = getMeta(d.meta);
      if (!m) return { ok: false, error: `未知元函数 ${d.meta}` };
      const args: Expr[] = [];
      for (let i = 0; i < m.params.length; i++) {
        const src = inSource(edges, nodeId, `in${i}`);
        if (!src) return { ok: false, error: `${d.meta} 缺第 ${i + 1} 个参数` };
        const r = compileExpr(nodes, edges, src);
        if (!r.ok) return r;
        args.push(r.e);
      }
      return { ok: true, s: { k: 'expr', e: { k: 'call', name: d.meta, args } } };
    }
    case 'expr':
      return { ok: true, s: { k: 'expr', e: d.expr } };
    case 'decl': {
      const init = valIn();
      return { ok: true, s: { k: 'decl', name: d.name, t: declType(d), init } };
    }
    case 'assign': {
      const e = valIn();
      if (!e) return { ok: false, error: '赋值缺右值' };
      return { ok: true, s: { k: 'assign', target: { k: 'var', name: d.name }, e } };
    }
    case 'return': {
      return { ok: true, s: { k: 'return', e: valIn() } };
    }
    case 'if': {
      const cond = valIn();
      if (!cond) return { ok: false, error: '若 缺条件' };
      const thenResult = compileStmtChain(nodes, edges, outTarget(edges, nodeId, 'body'));
      if (!thenResult.ok) return thenResult;
      const elseResult = compileStmtChain(nodes, edges, outTarget(edges, nodeId, 'else'));
      if (!elseResult.ok) return elseResult;
      return {
        ok: true,
        s: {
          k: 'if',
          cond,
          then: thenResult.body,
          els: elseResult.body.length ? elseResult.body : null,
        },
      };
    }
    case 'for': {
      const list = valIn();
      if (!list) return { ok: false, error: '遍历 缺列表' };
      const result = compileStmtChain(nodes, edges, outTarget(edges, nodeId, 'body'));
      if (!result.ok) return result;
      return { ok: true, s: { k: 'for', name: d.varName, list, body: result.body } };
    }
    case 'repeat': {
      const result = compileStmtChain(nodes, edges, outTarget(edges, nodeId, 'body'));
      if (!result.ok) return result;
      return { ok: true, s: { k: 'repeat', count: d.count, body: result.body } };
    }
    case 'break':
      return { ok: true, s: { k: 'break' } };
    case 'free':
      return { ok: true, s: { k: 'free', name: d.name } };
    default:
      return { ok: false, error: `节点 ${nodeId} 不是语句` };
  }
}

function compileGraph(
  nodes: Node[],
  edges: Edge[],
): { ok: true; spell: Spell } | { ok: false; error: string } {
  const entry = findEntry(nodes);
  if (!entry) return { ok: false, error: '缺少入口节点' };
  const ed = entry.data as unknown as EntryData;
  const first = outTarget(edges, entry.id, 'flow-out');
  const stmts = chain(nodes, edges, first);
  const body: Stmt[] = [];
  for (const sn of stmts) {
    const r = compileStmt(nodes, edges, sn.id);
    if (!r.ok) return { ok: false, error: r.error };
    body.push(r.s);
  }
  const spell: Spell = {
    name: ed.name || '未命名',
    params: ed.params ?? [],
    ret: ed.ret === 'void' ? null : primType(ed.ret as 'num' | 'bool' | 'vec2' | 'entity'),
    body,
    tags: [],
  };
  return { ok: true, spell };
}

// ---------------- 调色板 ----------------

const PALETTE: Array<{ kind: NodeKind; label: string }> = [
  { kind: 'callstmt', label: '调用(施法)' },
  { kind: 'call', label: '调用(取值)' },
  { kind: 'const', label: '常量' },
  { kind: 'varref', label: '变量引用' },
  { kind: 'index', label: '列表索引' },
  { kind: 'decl', label: '声明' },
  { kind: 'assign', label: '赋值' },
  { kind: 'if', label: '若' },
  { kind: 'for', label: '遍历' },
  { kind: 'repeat', label: '重复' },
  { kind: 'break', label: '中断' },
  { kind: 'free', label: '释放变量' },
  { kind: 'return', label: '返回' },
];

function nextNodePosition(nodes: Node[]): { x: number; y: number } {
  const horizontalGap = 240;
  const verticalGap = 170;
  const columns = 4;

  for (let index = 0; index < 200; index++) {
    const candidate = {
      x: 120 + (index % columns) * horizontalGap,
      y: 80 + Math.floor(index / columns) * verticalGap,
    };
    const overlaps = nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < horizontalGap * 0.8 &&
        Math.abs(node.position.y - candidate.y) < verticalGap * 0.8,
    );
    if (!overlaps) return candidate;
  }

  return { x: 120, y: 80 + Math.ceil(nodes.length / columns) * verticalGap };
}

function makeNode(kind: NodeKind, position: { x: number; y: number }): Node {
  const id = nid();
  const base = {
    id,
    type: 'spell',
    position,
  };
  switch (kind) {
    case 'callstmt':
    case 'call':
      return { ...base, data: { kind, meta: publicMetas()[0]?.name ?? '加' } } as Node;
    case 'const':
      return { ...base, data: { kind: 'const', value: '0', ctype: 'num' } } as Node;
    case 'varref':
      return { ...base, data: { kind: 'varref', name: '' } } as Node;
    case 'decl':
      return { ...base, data: { kind: 'decl', name: '', dtype: 'num' } } as Node;
    case 'assign':
      return { ...base, data: { kind: 'assign', name: '' } } as Node;
    case 'for':
      return { ...base, data: { kind: 'for', varName: 'e' } } as Node;
    case 'if':
      return { ...base, data: { kind: 'if' } } as Node;
    case 'return':
      return { ...base, data: { kind: 'return' } } as Node;
    case 'expr':
      return { ...base, data: { kind: 'expr', expr: { k: 'lit', v: 0, t: T.num } } } as Node;
    case 'index':
      return { ...base, data: { kind: 'index' } } as Node;
    case 'repeat':
      return { ...base, data: { kind: 'repeat', count: 1 } } as Node;
    case 'break':
      return { ...base, data: { kind: 'break' } } as Node;
    case 'free':
      return { ...base, data: { kind: 'free', name: '' } } as Node;
    default:
      return { ...base, data: { kind: 'entry', name: '新法术', ret: 'void' } } as Node;
  }
}

function declDataOf(name: string, t: Type | null): DeclData {
  if (t?.k === 'list') {
    return { kind: 'decl', name, dtype: 'list', elem: t.elem, cap: t.cap };
  }
  const dtype = !t || t.k === 'void' || t.k === 'any' ? 'num' : t.k;
  return { kind: 'decl', name, dtype };
}

function entryRetOf(t: Type | null): EntryData['ret'] {
  if (!t || t.k === 'void') return 'void';
  return t.k === 'list' || t.k === 'any' ? 'void' : t.k;
}

function graphFromSpell(spell: Spell): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nextId = 0;
  let exprY = 80;
  const statementDepth = (stmts: Stmt[], depth = 0): number =>
    stmts.reduce((max, stmt) => {
      const child =
        stmt.k === 'if'
          ? [...stmt.then, ...(stmt.els ?? [])]
          : stmt.k === 'for' || stmt.k === 'repeat'
            ? stmt.body
            : [];
      return Math.max(max, child.length > 0 ? statementDepth(child, depth + 1) : depth);
    }, depth);
  const expressionX = 430 + statementDepth(spell.body) * 330;
  const statementSpan = (stmt: Stmt): number => {
    const child =
      stmt.k === 'if'
        ? [...stmt.then, ...(stmt.els ?? [])]
        : stmt.k === 'for' || stmt.k === 'repeat'
          ? stmt.body
          : [];
    return Math.max(
      145,
      child.reduce((sum, nested) => sum + statementSpan(nested), 0),
    );
  };

  const next = (prefix: string): string => `${prefix}-${nextId++}`;
  const pushEdge = (
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
    stroke = '#6aa9ff',
  ): void => {
    edges.push({
      id: next('edge'),
      source,
      sourceHandle,
      target,
      targetHandle,
      style: { stroke },
    });
  };

  const addExpr = (expr: Expr, depth: number): string => {
    const id = next('expr');
    let data: Nd;
    let children: Expr[] = [];
    if (expr.k === 'lit') {
      data = {
        kind: 'const',
        value: expr.v === null ? '' : String(expr.v),
        ctype: expr.t.k === 'bool' ? 'bool' : expr.v === null ? 'entity' : 'num',
      };
    } else if (expr.k === 'var') {
      data = { kind: 'varref', name: expr.name };
    } else if (expr.k === 'index') {
      data = { kind: 'index' };
      children = [expr.arr, expr.i];
    } else {
      data = { kind: 'call', meta: expr.name };
      children = expr.args;
    }
    nodes.push({
      id,
      type: 'spell',
      position: { x: expressionX + depth * 230, y: exprY },
      data: data as unknown as Record<string, unknown>,
    });
    exprY += 105;
    children.forEach((child, i) => {
      const childId = addExpr(child, depth + 1);
      pushEdge(
        childId,
        'out',
        id,
        `in${i}`,
        color(inTypeOf({ id, data } as unknown as Node, `in${i}`)),
      );
    });
    return id;
  };

  // The statement builder references this callback recursively for nested bodies.
  // eslint-disable-next-line prefer-const
  let addStmtList: (
    stmts: Stmt[],
    x: number,
    y: number,
  ) => { first: string | null; last: string | null };
  const addStmt = (stmt: Stmt, index: number, x: number, y: number): string => {
    const id = next(`stmt-${index}`);
    let data: Nd;
    let value: Expr | null = null;
    switch (stmt.k) {
      case 'decl':
        data = declDataOf(stmt.name, stmt.t);
        value = stmt.init;
        break;
      case 'assign':
        data = { kind: 'assign', name: stmt.target.k === 'var' ? stmt.target.name : '' };
        value = stmt.e;
        break;
      case 'expr':
        data =
          stmt.e.k === 'call'
            ? { kind: 'callstmt', meta: stmt.e.name }
            : { kind: 'expr', expr: stmt.e };
        value = stmt.e.k === 'call' ? null : stmt.e;
        break;
      case 'if':
        data = { kind: 'if' };
        value = stmt.cond;
        break;
      case 'for':
        data = { kind: 'for', varName: stmt.name };
        value = stmt.list;
        break;
      case 'repeat':
        data = { kind: 'repeat', count: stmt.count };
        break;
      case 'break':
        data = { kind: 'break' };
        break;
      case 'free':
        data = { kind: 'free', name: stmt.name };
        break;
      case 'return':
        data = { kind: 'return' };
        value = stmt.e;
        break;
    }
    nodes.push({
      id,
      type: 'spell',
      position: { x, y },
      data: data as unknown as Record<string, unknown>,
    });
    if (value) pushEdge(addExpr(value, 0), 'out', id, 'in0', '#e8c37a');
    if (stmt.k === 'expr' && stmt.e.k === 'call') {
      stmt.e.args.forEach((arg, i) => {
        pushEdge(
          addExpr(arg, 0),
          'out',
          id,
          `in${i}`,
          color(inTypeOf({ id, data } as unknown as Node, `in${i}`)),
        );
      });
    }
    if (stmt.k === 'if' || stmt.k === 'for' || stmt.k === 'repeat') {
      const child = stmt.k === 'if' ? stmt.then : stmt.body;
      const body = addStmtList(child, x + 330, y + 20);
      if (body.first) pushEdge(id, 'body', body.first, 'flow-in', '#7bd88f');
      if (stmt.k === 'if' && stmt.els) {
        const thenSpan = Math.max(
          145,
          stmt.then.reduce((sum, nested) => sum + statementSpan(nested), 0),
        );
        const elseBody = addStmtList(stmt.els, x + 330, y + thenSpan + 20);
        if (elseBody.first) pushEdge(id, 'else', elseBody.first, 'flow-in', '#c39bff');
      }
    }
    return id;
  };

  addStmtList = (stmts, x, y) => {
    let first: string | null = null;
    let last: string | null = null;
    let cursorY = y;
    stmts.forEach((stmt, i) => {
      const id = addStmt(stmt, i, x, cursorY);
      if (!first) first = id;
      if (last) pushEdge(last, 'flow-out', id, 'flow-in', '#4a5060');
      last = id;
      cursorY += statementSpan(stmt);
    });
    return { first, last };
  };

  const entry = 'entry';
  nodes.push({
    id: entry,
    type: 'spell',
    position: { x: 80, y: 40 },
    data: {
      kind: 'entry',
      name: spell.name,
      ret: entryRetOf(spell.ret),
      params: spell.params,
    } as unknown as Record<string, unknown>,
  });
  const body = addStmtList(spell.body, 80, 180);
  if (body.first) pushEdge(entry, 'flow-out', body.first, 'flow-in', '#e8c37a');
  return { nodes, edges };
}

const initialNodes: Node[] = [
  {
    id: 'entry',
    type: 'spell',
    position: { x: 80, y: 40 },
    data: { kind: 'entry', name: '新法术', ret: 'void' },
  },
];

// ---------------- 组件 ----------------

interface NodeEditorProps {
  source: string;
  spell: Spell | null;
  onSourceChange: (source: string) => void;
  onSpellNameChange?: (name: string) => void;
}

export function NodeEditor({ source, spell, onSourceChange, onSpellNameChange }: NodeEditorProps) {
  const graph = useMemo(
    () => (spell ? graphFromSpell(spell) : { nodes: initialNodes, edges: [] as Edge[] }),
    [spell],
  );
  const [nodes, setNodes] = useNodesState<Node>(graph.nodes as Node[]);
  const [edges, setEdges] = useEdgesState<Edge>(graph.edges);
  const [compileMsg, setCompileMsg] = useState('');
  const [dsl, setDsl] = useState('');
  const [search, setSearch] = useState('');
  const [historyIndex, setHistoryIndex] = useState(0);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const loadedSpellName = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const historyRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([{ nodes, edges }]);
  const historyIndexRef = useRef(0);
  const deletionHistoryQueuedRef = useRef(false);

  const clone = (nextNodes: Node[], nextEdges: Edge[]) => ({
    nodes: nextNodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...node.data },
    })),
    edges: nextEdges.map((edge) => ({
      ...edge,
      style: edge.style ? { ...edge.style } : undefined,
    })),
  });
  const appendHistory = (nextNodes: Node[], nextEdges: Edge[]): void => {
    const next = [
      ...historyRef.current.slice(0, historyIndexRef.current + 1),
      clone(nextNodes, nextEdges),
    ].slice(-60);
    historyRef.current = next;
    historyIndexRef.current = next.length - 1;
    setHistoryIndex(next.length - 1);
  };
  const restoreHistory = (index: number): void => {
    const saved = historyRef.current[index];
    if (!saved) return;
    const restored = clone(saved.nodes, saved.edges);
    nodesRef.current = restored.nodes;
    edgesRef.current = restored.edges;
    setNodes(restored.nodes);
    setEdges(restored.edges);
    historyIndexRef.current = index;
    setHistoryIndex(index);
  };
  const scheduleDeletionHistory = (): void => {
    if (deletionHistoryQueuedRef.current) return;
    deletionHistoryQueuedRef.current = true;
    queueMicrotask(() => {
      deletionHistoryQueuedRef.current = false;
      // React Flow removes connected edges and their node in separate callbacks.
      // Wait until that transaction has settled, so one undo restores the whole graph.
      appendHistory(nodesRef.current, edgesRef.current);
    });
  };

  useEffect(() => {
    const nextName = spell?.name ?? null;
    if (loadedSpellName.current === nextName) return;
    loadedSpellName.current = nextName;
    setNodes(graph.nodes as Node[]);
    setEdges(graph.edges);
    nodesRef.current = graph.nodes as Node[];
    edgesRef.current = graph.edges;
    historyRef.current = [clone(graph.nodes as Node[], graph.edges)];
    historyIndexRef.current = 0;
    setHistoryIndex(0);
    setCompileMsg('');
    setDsl('');
  }, [graph, setEdges, setNodes, spell?.name]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeChanges(changes, nodesRef.current);
      nodesRef.current = next;
      setNodes(next);
      if (changes.some((change) => change.type === 'remove')) scheduleDeletionHistory();
    },
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, edgesRef.current);
      edgesRef.current = next;
      setEdges(next);
      if (changes.some((change) => change.type === 'remove')) scheduleDeletionHistory();
    },
    [setEdges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const srcNode = nodesRef.current.find((n) => n.id === c.source) as unknown as
        Node | undefined;
      const tgtNode = nodesRef.current.find((n) => n.id === c.target) as unknown as
        Node | undefined;
      if (!srcNode || !tgtNode) return;
      const sKind = (srcNode.data as unknown as Nd).kind;
      const tKind = (tgtNode.data as unknown as Nd).kind;

      // 控制流：flow-out → flow-in（语句→语句）
      if (c.sourceHandle === 'flow-out' && c.targetHandle === 'flow-in') {
        if (!isFlowSourceKind(sKind) || !isStmtKind(tKind)) return;
      } else if (c.sourceHandle === 'body' && c.targetHandle === 'flow-in') {
        // 体端口：if/for → 语句
        if (sKind !== 'if' && sKind !== 'for' && sKind !== 'repeat') return;
        if (!isStmtKind(tKind)) return;
      } else if (c.sourceHandle === 'else' && c.targetHandle === 'flow-in') {
        if (sKind !== 'if' || !isStmtKind(tKind)) return;
      } else if (c.sourceHandle === 'out' && c.targetHandle.startsWith('in')) {
        // 值连接：类型校验
        const st = outTypeOf(srcNode);
        const tt = inTypeOf(tgtNode, c.targetHandle);
        if (!assignable(st, tt)) {
          setCompileMsg(`类型不符：${typeName(st)} 不能接入 ${typeName(tt)}`);
          return;
        }
      } else {
        return;
      }
      setCompileMsg('');
      const next = addEdge({ ...c, style: { stroke: '#6aa9ff' } } as Edge, edgesRef.current);
      edgesRef.current = next;
      setEdges(next);
      appendHistory(nodesRef.current, next);
    },
    [setEdges],
  );

  const addNode = (kind: NodeKind): void => {
    const next = [...nodesRef.current, makeNode(kind, nextNodePosition(nodesRef.current))];
    nodesRef.current = next;
    setNodes(next);
    appendHistory(next, edgesRef.current);
  };

  const updateNodeData = useCallback(
    (id: string, patch: Record<string, unknown>): void => {
      const next = nodesRef.current.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
      );
      nodesRef.current = next;
      setNodes(next);
      appendHistory(next, edgesRef.current);
    },
    [setNodes],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        restoreHistory(event.shiftKey ? historyIndex + 1 : historyIndex - 1);
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        restoreHistory(historyIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [historyIndex]);

  const compile = (): void => {
    const r = compileGraph(nodes as unknown as Node[], edges);
    if (!r.ok) {
      setCompileMsg(`✗ ${r.error}`);
      setDsl('');
      return;
    }
    let current: SpellBook = {};
    try {
      current = parseSpellbook(source);
    } catch {
      // The graph can still replace the selected invalid spell.
    }
    const book: SpellBook = { ...current, [r.spell.name]: r.spell };
    if (spell && spell.name !== r.spell.name) delete book[spell.name];
    try {
      const costs = analyzeBook(book);
      const c = costs[r.spell.name];
      const errs = c.errors.length > 0 ? `\n静态分析：${c.errors.join('; ')}` : '';
      const ser = serializeBook(book);
      // 验证可重新解析（保证图→AST→DSL 一致）
      parseSpellbook(ser);
      const prog = compileProgram(book);
      void prog;
      const mana = c.manaBudget.dynamic ? `${c.manaBudget.value}+动态` : `${c.manaWorst}`;
      const ticks = c.tickBudget.dynamic ? `${c.tickBudget.value}+动态` : `${c.tickWorst}`;
      setCompileMsg(
        `✓ 编译通过 · 法力${mana} · 耗时${ticks}tick · 神识峰值${c.shenshiPeak}${errs}`,
      );
      setDsl(ser);
      onSourceChange(ser);
      if (spell?.name !== r.spell.name) onSpellNameChange?.(r.spell.name);
    } catch (e) {
      setCompileMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      setDsl('');
    }
  };

  const palette = useMemo(
    () => PALETTE.filter((item) => item.label.includes(search.trim())),
    [search],
  );
  const matches = useMemo(
    () =>
      search.trim()
        ? nodes.filter((node) =>
            `${titleOf((node.data as unknown as Nd).kind)} ${descriptionOf(node.data as unknown as Nd)}`.includes(
              search.trim(),
            ),
          )
        : [],
    [nodes, search],
  );
  const selectNode = (id: string): void => {
    const next = nodesRef.current.map((node) => ({ ...node, selected: node.id === id }));
    nodesRef.current = next;
    setNodes(next);
    const node = next.find((item) => item.id === id);
    if (node) void flow?.setCenter(node.position.x + 90, node.position.y + 48, { zoom: 1 });
  };

  return (
    <NodeDataContext.Provider value={updateNodeData}>
      <div className="blueprint-editor">
        <div className="blueprint-toolbar">
          <strong>{spell?.name ?? 'BluePrint'}</strong>
          <span className="muted small">修改当前法术，编译后同步回法术书</span>
          <button
            onClick={() => restoreHistory(historyIndex - 1)}
            disabled={historyIndex === 0}
            title="Ctrl/Cmd + Z"
          >
            撤销
          </button>
          <button
            onClick={() => restoreHistory(historyIndex + 1)}
            disabled={historyIndex >= historyRef.current.length - 1}
            title="Ctrl/Cmd + Shift + Z"
          >
            重做
          </button>
          <button className="run" onClick={compile} disabled={!spell}>
            编译并写回
          </button>
        </div>

        <div className="editor-wrap">
          <aside className="palette">
            <h3>节点</h3>
            <input
              className="node-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索节点或调色板"
              aria-label="搜索节点"
            />
            {matches.length > 0 && (
              <div className="node-search-results" aria-label="节点搜索结果">
                {matches.map((node) => (
                  <button key={node.id} data-node-id={node.id} onClick={() => selectNode(node.id)}>
                    定位 {titleOf((node.data as unknown as Nd).kind)}
                  </button>
                ))}
              </div>
            )}
            {palette.map((p) => (
              <button
                key={p.kind}
                className="palette-btn"
                title={NODE_DESCRIPTIONS[p.kind]}
                onClick={() => addNode(p.kind)}
              >
                + {p.label}
              </button>
            ))}
            {compileMsg && <pre className="errors">{compileMsg}</pre>}
            {dsl && (
              <details>
                <summary>生成的 DSL（点击展开，可复制）</summary>
                <textarea className="editor" value={dsl} readOnly rows={14} />
              </details>
            )}
          </aside>

          <div className="graph-wrap">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStop={() => appendHistory(nodesRef.current, edgesRef.current)}
              onInit={setFlow}
              nodeTypes={nodeTypes}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              // React Flow gives panning priority when both props are enabled.
              // This editor reserves a bare drag on the pane for box selection;
              // search-to-center and the controls remain available for navigation.
              panOnDrag={false}
              minZoom={0.45}
              maxZoom={1.5}
              defaultViewport={{ x: 28, y: 16, zoom: 0.68 }}
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background color="#262e3a" gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </div>
      </div>
    </NodeDataContext.Provider>
  );
}
