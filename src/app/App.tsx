import { useState } from 'react';

import { CombatView } from './CombatView';
import { LabView } from './LabView';

type Tab = 'lab' | 'arena';

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'lab', label: '推演台', hint: '编写与静态分析' },
  { id: 'arena', label: '演武场', hint: '实际战斗' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('lab');

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
