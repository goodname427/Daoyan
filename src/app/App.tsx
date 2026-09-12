import { useEffect, useState } from 'react';

import { CombatView } from './CombatView';
import { LabView } from './LabView';
import { loadExternalMetas } from '../game/externalMetas';

type Tab = 'lab' | 'arena';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'lab', label: '推演台', hint: '编写与静态分析' },
  { id: 'arena', label: '演武场', hint: '实际战斗' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('lab');

  useEffect(() => {
    // 外部元法术：打包后从 exe 旁的 metas/ 目录加载（见 docs/扩展元法术.md）
    loadExternalMetas().then((names) => {
      if (names.length > 0) console.log(`[元法术] 已加载外部扩展: ${names.join(', ')}`);
    });
  }, []);

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
      </nav>
      {tab === 'lab' ? <LabView /> : <CombatView />}
    </>
  );
}
