import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { allMetas, parseSpellbook, serializeBook } from '../core/index';

interface SpellEditorProps {
  source: string;
  spellName: string;
  onSourceChange: (source: string) => void;
  onSpellNameChange?: (name: string) => void;
}

const KEYWORDS = new Set([
  'spell',
  'var',
  'if',
  'else',
  'for',
  'in',
  'repeat',
  'break',
  'free',
  'return',
  'true',
  'false',
  'null',
]);
const TYPES = new Set(['num', 'bool', 'vec2', 'entity', 'list']);
const TOKEN_RE =
  /(\/\/[^\n]*|@[A-Za-z]+(?:=[^\s{}]+)?|\b\d+(?:\.\d+)?\b|[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff·]+|[{}()[\],:=])/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSpellBlock(source: string, name: string): { start: number; end: number } | null {
  if (!name) return null;
  const match = new RegExp(`\\bspell\\s+${escapeRegExp(name)}(?=\\s|\\{)`).exec(source);
  if (!match) return null;
  const open = source.indexOf('{', match.index + match[0].length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
  }
  return null;
}

function blockFor(source: string, name: string): string {
  const block = findSpellBlock(source, name);
  return block ? source.slice(block.start, block.end) : source;
}

function tokenClass(token: string): string {
  if (token.startsWith('//')) return 'tok-comment';
  if (token.startsWith('@')) return 'tok-annotation';
  if (/^\d/.test(token)) return 'tok-number';
  if (KEYWORDS.has(token)) return 'tok-keyword';
  if (TYPES.has(token)) return 'tok-type';
  if (allMetas().some((m) => m.name === token)) return 'tok-builtin';
  if (/^[{}()[\],:=]$/.test(token)) return 'tok-punctuation';
  return 'tok-name';
}

function highlight(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of source.matchAll(TOKEN_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) out.push(source.slice(last, start));
    out.push(
      <span className={tokenClass(token)} key={`${start}-${index++}`}>
        {token}
      </span>,
    );
    last = start + token.length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

function parseError(source: string): string {
  try {
    const book = parseSpellbook(source);
    if (Object.keys(book).length !== 1) return '此编辑区应只包含一个完整法术';
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function SpellEditor({
  source,
  spellName,
  onSourceChange,
  onSpellNameChange,
}: SpellEditorProps) {
  const initial = useMemo(() => blockFor(source, spellName), [source, spellName]);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const lineCount = Math.max(1, draft.split('\n').length);

  useEffect(() => {
    setDraft(initial);
    setError(parseError(initial));
  }, [initial]);

  const onChange = (value: string): void => {
    setDraft(value);
    const errorMessage = parseError(value);
    setError(errorMessage);
    if (errorMessage) return;

    try {
      const edited = parseSpellbook(value);
      const current = parseSpellbook(source);
      const editedName = Object.keys(edited)[0];
      const next = { ...current, ...edited };
      if (spellName && spellName !== editedName) delete next[spellName];
      onSourceChange(serializeBook(next));
      if (editedName && spellName !== editedName) onSpellNameChange?.(editedName);
    } catch {
      // parseError already reports the editor-local error.
    }
  };

  const syncScroll = (): void => {
    const text = textRef.current;
    const code = codeRef.current;
    if (!text || !code) return;
    code.scrollTop = text.scrollTop;
    code.scrollLeft = text.scrollLeft;
  };

  return (
    <div className="spell-editor-layout">
      <div className="spell-editor">
        <div className="editor-heading">
          <div>
            <strong>{spellName || '法术源码'}</strong>
            <span className={error ? 'editor-status bad' : 'editor-status'}>
              {error ? '语法检查中' : '语法通过，修改会同步到法术书'}
            </span>
          </div>
          <span className="muted small">当前只编辑选中的法术</span>
        </div>
        <div className="code-editor">
          <div className="line-numbers" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <div className="code-layer">
            <pre ref={codeRef} className="code-highlight" aria-hidden="true">
              {highlight(draft)}
              {'\n'}
            </pre>
            <textarea
              ref={textRef}
              className="code-input"
              aria-label={spellName ? `${spellName} 法术源码` : '法术源码'}
              value={draft}
              spellCheck={false}
              onScroll={syncScroll}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        </div>
        {error && <pre className="errors editor-error">{error}</pre>}
      </div>
      <LanguageGuide />
    </div>
  );
}

export function LanguageGuide() {
  return (
    <aside className="syntax-guide">
      <h3>语句说明</h3>
      <dl>
        <div>
          <dt className="tok-keyword">spell</dt>
          <dd>定义一个可以被绑定和施放的法术。</dd>
        </div>
        <div>
          <dt className="tok-keyword">var</dt>
          <dd>声明变量并支付对应的神识占用。</dd>
        </div>
        <div>
          <dt className="tok-keyword">if / else</dt>
          <dd>根据条件选择是否执行一段语句。</dd>
        </div>
        <div>
          <dt className="tok-keyword">for</dt>
          <dd>遍历定容列表，容量决定静态神识上界。</dd>
        </div>
        <div>
          <dt className="tok-keyword">repeat</dt>
          <dd>按字面量次数重复执行，次数可被静态分析。</dd>
        </div>
        <div>
          <dt className="tok-keyword">free</dt>
          <dd>提前释放变量占用的神识。</dd>
        </div>
        <div>
          <dt className="tok-builtin">元法术()</dt>
          <dd>读取或改变世界，会产生法力和耗时成本。</dd>
        </div>
      </dl>
      <div className="legend">
        <span>
          <i className="tok-keyword">关键字</i>
        </span>
        <span>
          <i className="tok-builtin">元法术</i>
        </span>
        <span>
          <i className="tok-number">数字</i>
        </span>
        <span>
          <i className="tok-comment">注释</i>
        </span>
      </div>
    </aside>
  );
}
