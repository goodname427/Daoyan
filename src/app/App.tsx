import { useEffect, useRef, useState } from 'react';

import { CombatView } from './CombatView';
import { LabView } from './LabView';
import type { Attributes } from '../core/index';
import { loadExternalMetas } from '../game/externalMetas';
import { DEFAULT_PLAYER_ATTRS, DEFAULT_PLAYER_BINDINGS } from '../game/battle';
import INITIAL_SPELLS from '../game/spells.dy?raw';
import {
  decodePlayerState,
  encodePlayerState,
  loadPlayerState,
  savePlayerState,
  type PlayerState,
} from './persistence';

type Tab = 'lab' | 'arena';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'lab', label: '推演台', hint: '编写与静态分析' },
  { id: 'arena', label: '演武场', hint: '实际战斗' },
];

const DEFAULT_PLAYER_STATE: PlayerState = {
  spellSource: INITIAL_SPELLS,
  arenaAttrs: { ...DEFAULT_PLAYER_ATTRS },
  arenaBindings: { ...DEFAULT_PLAYER_BINDINGS },
};

export function App() {
  const [tab, setTab] = useState<Tab>('lab');
  const [initial] = useState(() => {
    const loaded = loadPlayerState(DEFAULT_PLAYER_STATE);
    return loaded.ok
      ? {
          state: loaded.state,
          notice: loaded.migrated ? '已迁移本地旧存档。' : '',
          loaded: true,
        }
      : {
          state: DEFAULT_PLAYER_STATE,
          notice: `${loaded.message} 已使用默认配置。`,
          loaded: false,
        };
  });
  const [spellSource, setSpellSource] = useState(initial.state.spellSource);
  const [arenaAttrs, setArenaAttrs] = useState<Attributes>(initial.state.arenaAttrs);
  const [arenaBindings, setArenaBindings] = useState<Record<string, string>>(
    initial.state.arenaBindings,
  );
  const [saveNotice, setSaveNotice] = useState(initial.notice);
  const importRef = useRef<HTMLInputElement>(null);
  // 拒绝的本地存档必须留在原处，不能被本次启动的默认状态立即覆盖。
  const skipInitialAutoSave = useRef(!initial.loaded);

  const playerState = (): PlayerState => ({ spellSource, arenaAttrs, arenaBindings });

  useEffect(() => {
    // 编辑器允许短暂的语法错误；仅在法术书恢复有效时更新自动存档。
    // 初始读取失败时，保留被拒绝的数据；之后玩家的有效修改仍可正常保存。
    if (skipInitialAutoSave.current) {
      skipInitialAutoSave.current = false;
      return;
    }
    savePlayerState(playerState());
  }, [spellSource, arenaAttrs, arenaBindings]);

  useEffect(() => {
    // 外部元法术：打包后从 exe 旁的 metas/ 目录加载（见 docs/扩展元法术.md）
    loadExternalMetas().then((names) => {
      if (names.length > 0) console.log(`[元法术] 已加载外部扩展: ${names.join(', ')}`);
    });
  }, []);

  const exportSave = (): void => {
    const saved = savePlayerState(playerState());
    if (!saved.ok) {
      setSaveNotice(`导出失败：${saved.message}`);
      return;
    }
    const blob = new Blob([encodePlayerState(saved.state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'daoyan-save.json';
    link.click();
    URL.revokeObjectURL(url);
    setSaveNotice('已导出法术书与演武配置。');
  };

  const importSave = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setSaveNotice('导入失败：无法读取存档文件。');
      return;
    }
    const loaded = decodePlayerState(text, DEFAULT_PLAYER_STATE);
    if (!loaded.ok) {
      setSaveNotice(`导入失败：${loaded.message}`);
      return;
    }
    setSpellSource(loaded.state.spellSource);
    setArenaAttrs(loaded.state.arenaAttrs);
    setArenaBindings(loaded.state.arenaBindings);
    setSaveNotice(loaded.migrated ? '已导入并迁移旧版本存档。' : '已导入存档。');
  };

  return (
    <>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <small>{t.hint}</small>
          </button>
        ))}
        <div className="persistence-controls" aria-label="存档管理">
          <button type="button" className="mini" onClick={exportSave}>
            导出存档
          </button>
          <button type="button" className="mini" onClick={() => importRef.current?.click()}>
            导入存档
          </button>
          <input
            ref={importRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            aria-label="选择存档文件"
            onChange={(event) => {
              void importSave(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </nav>
      {saveNotice && (
        <p className="save-notice" role="status">
          {saveNotice}
        </p>
      )}
      {tab === 'lab' ? (
        <LabView source={spellSource} onSourceChange={setSpellSource} />
      ) : (
        <CombatView
          source={spellSource}
          attrs={arenaAttrs}
          bindings={arenaBindings}
          onAttrsChange={setArenaAttrs}
          onBindingsChange={setArenaBindings}
        />
      )}
    </>
  );
}
