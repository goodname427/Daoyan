import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  T,
  allMetas,
  analyzeBook,
  assignable,
  compileProgram,
  getMeta,
  parseSpellbook,
  serializeBook,
  typeName,
} from '../core/index';
import type { Expr, Spell, SpellBook, Stmt, Type } from '../core/index';

/**
 * 蓝图编辑器（反向方向：图 → AST）。
 *
 * 节点按类型着色，端口按类型标注，连线即数据流 / 控制流。
 * 编译按钮把图编译成 AST，复用同一套分析器 / VM 管线 ——
 * 与 DSL 编辑器、节点图（只读视图）三者产出同一份 AST。
 *
 * MVP 范围：声明 / 赋值 / 调用(施法) / 调用(取值) / 常量 / 变量引用 /
 *           若(含 then 体) / 遍历(含体) / 返回。完整控制流与撤销重做后续补。
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
  'entry' | 'callstmt' | 'call' | 'const' | 'varref' | 'decl' | 'assign' | 'if' | 'for' | 'return';

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
interface DeclData extends BaseData {
  kind: 'decl';
  name: string;
  dtype: 'num' | 'bool' | 'vec2' | 'entity';
}
interface AssignData extends BaseData {
  kind: 'assign';
  name: string;
}
interface ForData extends BaseData {
  kind: 'for';
  varName: string;
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
}

type Nd =
  | CallData
  | ConstData
  | VarData
  | DeclData
  | AssignData
  | ForData
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
  if (d.kind === 'decl') return primType(d.dtype);
  if (d.kind === 'assign') return T.any;
  if (d.kind === 'if') return T.bool;
  if (d.kind === 'for') return T.list('any');
  if (d.kind === 'return') return T.any;
  return T.any;
}

function primType(k: 'num' | 'bool' | 'vec2' | 'entity'): Type {
  return k === 'num' ? T.num : k === 'bool' ? T.bool : k === 'vec2' ? T.vec2 : T.entity;
}

function isStmtKind(k: NodeKind): boolean {
  return (
    k === 'callstmt' ||
    k === 'decl' ||
    k === 'assign' ||
    k === 'if' ||
    k === 'for' ||
    k === 'return'
  );
}

// ---------------- 节点渲染 ----------------

function Port({ label, t }: { label: string; t: Type }) {
  return (
    <div className="port">
      <Handle type="target" position={Position.Left} id={label} style={{ background: color(t) }} />
      <span style={{ color: color(t) }}>{typeName(t)}</span>
    </div>
  );
}

function SpellNode({ id, data }: NodeProps<Node>) {
  const d = data as unknown as Nd;
  const isStmt = isStmtKind(d.kind) || d.kind === 'entry';
  const outT = outTypeOf({ id, data } as Node);
  const metas = allMetas();

  const setMeta = (m: string): void => {
    (data as unknown as { meta: string }).meta = m;
    // 触发更新：React Flow 不可变更新，这里简单改 data 引用
    (data as unknown as Record<string, unknown>).__v = Date.now();
  };

  return (
    <div
      className="spell-node"
      style={{ borderColor: d.kind === 'entry' ? '#e8c37a' : color(outT) }}
    >
      {isStmt && <Handle type="target" position={Position.Top} id="flow-in" />}
      {d.kind !== 'entry' && d.kind !== 'callstmt' && d.kind !== 'call' && (
        <div className="spell-node-title">{titleOf(d.kind)}</div>
      )}

      {d.kind === 'entry' && (
        <>
          <div className="spell-node-title">法术·入口</div>
          <input
            className="node-input"
            defaultValue={d.name}
            placeholder="法术名"
            onChange={(e) => ((data as unknown as EntryData).name = e.target.value)}
          />
        </>
      )}

      {(d.kind === 'callstmt' || d.kind === 'call') && (
        <>
          <div className="spell-node-title">{d.meta}</div>
          <select
            className="node-input"
            defaultValue={d.meta}
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
            defaultValue={d.ctype}
            onChange={(e) =>
              ((data as unknown as ConstData).ctype = e.target.value as ConstData['ctype'])
            }
          >
            <option value="num">数</option>
            <option value="bool">布尔</option>
            <option value="entity">实体</option>
          </select>
          <input
            className="node-input"
            defaultValue={d.value}
            placeholder={d.ctype === 'bool' ? 'true/false' : d.ctype === 'entity' ? '空' : '0'}
            onChange={(e) => ((data as unknown as ConstData).value = e.target.value)}
          />
        </>
      )}

      {d.kind === 'varref' && (
        <>
          <div className="spell-node-title">变量引用</div>
          <input
            className="node-input"
            defaultValue={d.name}
            placeholder="变量名"
            onChange={(e) => ((data as unknown as VarData).name = e.target.value)}
          />
        </>
      )}

      {d.kind === 'decl' && (
        <>
          <div className="spell-node-title">声明</div>
          <input
            className="node-input"
            defaultValue={d.name}
            placeholder="变量名"
            onChange={(e) => ((data as unknown as DeclData).name = e.target.value)}
          />
          <select
            className="node-input"
            defaultValue={d.dtype}
            onChange={(e) =>
              ((data as unknown as DeclData).dtype = e.target.value as DeclData['dtype'])
            }
          >
            <option value="num">数</option>
            <option value="bool">布尔</option>
            <option value="vec2">向量</option>
            <option value="entity">实体</option>
          </select>
        </>
      )}

      {d.kind === 'assign' && (
        <>
          <div className="spell-node-title">赋值</div>
          <input
            className="node-input"
            defaultValue={d.name}
            placeholder="变量名"
            onChange={(e) => ((data as unknown as AssignData).name = e.target.value)}
          />
        </>
      )}

      {d.kind === 'for' && (
        <>
          <div className="spell-node-title">遍历</div>
          <input
            className="node-input"
            defaultValue={d.varName}
            placeholder="元素变量名"
            onChange={(e) => ((data as unknown as ForData).varName = e.target.value)}
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
            : inLabel(d.kind);
        return <Port key={pid} label={plabel} t={t === T.void ? T.any : t} />;
      })}

      {/* 值输出端口 */}
      {(d.kind === 'call' || d.kind === 'const' || d.kind === 'varref') && (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          style={{ background: color(outT) }}
        />
      )}

      {/* 体端口（if/for） */}
      {(d.kind === 'if' || d.kind === 'for') && (
        <Handle
          type="source"
          position={Position.Right}
          id="body"
          style={{ top: 'auto', bottom: 8, background: '#6aa9ff' }}
        />
      )}

      {isStmt && <Handle type="source" position={Position.Bottom} id="flow-out" />}
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
    case 'entry':
      return '入口';
  }
}

function inLabel(k: NodeKind): string {
  switch (k) {
    case 'decl':
      return '初值';
    case 'assign':
      return '值';
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
    case 'decl': {
      const init = valIn();
      return { ok: true, s: { k: 'decl', name: d.name, t: primType(d.dtype), init } };
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
      const bodyStart = outTarget(edges, nodeId, 'body');
      const thenBody = chain(nodes, edges, bodyStart)
        .map((n) => compileStmt(nodes, edges, n.id))
        .map((r) => (r.ok ? r.s : null))
        .filter(Boolean) as Stmt[];
      return { ok: true, s: { k: 'if', cond, then: thenBody, els: null } };
    }
    case 'for': {
      const list = valIn();
      if (!list) return { ok: false, error: '遍历 缺列表' };
      const bodyStart = outTarget(edges, nodeId, 'body');
      const body = chain(nodes, edges, bodyStart)
        .map((n) => compileStmt(nodes, edges, n.id))
        .map((r) => (r.ok ? r.s : null))
        .filter(Boolean) as Stmt[];
      return { ok: true, s: { k: 'for', name: d.varName, list, body } };
    }
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
    params: [],
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
  { kind: 'decl', label: '声明' },
  { kind: 'assign', label: '赋值' },
  { kind: 'if', label: '若' },
  { kind: 'for', label: '遍历' },
  { kind: 'return', label: '返回' },
];

function makeNode(kind: NodeKind): Node {
  const id = nid();
  const base = {
    id,
    type: 'spell',
    position: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 200 },
  };
  switch (kind) {
    case 'callstmt':
    case 'call':
      return { ...base, data: { kind, meta: allMetas()[0]?.name ?? '加' } } as Node;
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
    default:
      return { ...base, data: { kind: 'entry', name: '新法术', ret: 'void' } } as Node;
  }
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

export function NodeEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialNodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [compileMsg, setCompileMsg] = useState('');
  const [dsl, setDsl] = useState('');

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      const srcNode = nodes.find((n) => n.id === c.source) as unknown as Node | undefined;
      const tgtNode = nodes.find((n) => n.id === c.target) as unknown as Node | undefined;
      if (!srcNode || !tgtNode) return;
      const sKind = (srcNode.data as unknown as Nd).kind;
      const tKind = (tgtNode.data as unknown as Nd).kind;

      // 控制流：flow-out → flow-in（语句→语句）
      if (c.sourceHandle === 'flow-out' && c.targetHandle === 'flow-in') {
        if (!isStmtKind(sKind) || !isStmtKind(tKind)) return;
      } else if (c.sourceHandle === 'body' && c.targetHandle === 'flow-in') {
        // 体端口：if/for → 语句
        if (sKind !== 'if' && sKind !== 'for') return;
        if (!isStmtKind(tKind)) return;
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
      setEdges((eds) => addEdge({ ...c, style: { stroke: '#6aa9ff' } } as Edge, eds));
    },
    [nodes, setEdges],
  );

  const addNode = (kind: NodeKind): void => {
    setNodes((ns) => [...ns, makeNode(kind)]);
  };

  const compile = (): void => {
    const r = compileGraph(nodes as unknown as Node[], edges);
    if (!r.ok) {
      setCompileMsg(`✗ ${r.error}`);
      setDsl('');
      return;
    }
    const book: SpellBook = { [r.spell.name]: r.spell };
    try {
      const costs = analyzeBook(book);
      const c = costs[r.spell.name];
      const errs = c.errors.length > 0 ? `\n静态分析：${c.errors.join('; ')}` : '';
      const ser = serializeBook(book);
      // 验证可重新解析（保证图→AST→DSL 一致）
      parseSpellbook(ser);
      const prog = compileProgram(book);
      void prog;
      setCompileMsg(
        `✓ 编译通过 · 法力≤${c.manaWorst} · 耗时≤${c.tickWorst}tick · 神识峰值${c.shenshiPeak}${errs}`,
      );
      setDsl(ser);
    } catch (e) {
      setCompileMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      setDsl('');
    }
  };

  const palette = useMemo(() => PALETTE, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          道衍<span>蓝图编辑</span>
        </div>
        <div className="hint">拖节点、连线编写法术 → 编译 → 复制 DSL 到推演台/演武场运行</div>
      </header>

      <div className="editor-wrap">
        <aside className="palette">
          <h3>节点</h3>
          {palette.map((p) => (
            <button key={p.kind} className="palette-btn" onClick={() => addNode(p.kind)}>
              + {p.label}
            </button>
          ))}
          <hr />
          <button className="run" onClick={compile}>
            编译法术
          </button>
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
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background color="#262e3a" gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
