import { describe, expect, it } from 'vitest';
import { formalTaskContract } from '../scripts/formal-task-contract';
import { formalStageWritePaths } from '../scripts/agent-routing';

const envelope = (body: string, guidance = '') =>
  `[formal-stage-deliverable:development:task]\n只完成本合同：\n${body}\n${guidance}\n直接前驱的有限证据索引：[]`;

describe('formal task contract boundaries', () => {
  it('reads only the first contract despite runtime guidance and a second scope object', () => {
    const contract = {
      writePaths: ['src/game/battle.ts'],
      nested: { text: 'quote " and brace } and slash \\' },
    };
    const direction = envelope(
      JSON.stringify(contract),
      '正常 Computer Use 指导\n{"writePaths":["docs/status.md"]}',
    );
    expect(formalStageWritePaths(direction)).toEqual(['src/game/battle.ts']);
    const parsed = formalTaskContract(direction)!;
    expect(parsed.value).toEqual(contract);
    const replaced =
      direction.slice(0, parsed.start) +
      JSON.stringify({ ...contract, writePaths: ['test/combat.test.ts'] }) +
      direction.slice(parsed.end);
    expect(replaced.endsWith(direction.slice(parsed.end))).toBe(true);
    expect(formalStageWritePaths(replaced)).toEqual(['test/combat.test.ts']);
  });

  it.each([
    'null',
    '[]',
    '{"writePaths": }',
    '{"writePaths":["src/game/battle.ts"]',
    'instruction\n{"writePaths":["src/game/battle.ts"]}',
  ])('refuses a malformed first contract %s instead of adopting later JSON', (body) => {
    expect(formalTaskContract(envelope(body, '{"writePaths":["docs/status.md"]}'))).toBeNull();
  });

  it('requires both the formal header and predecessor boundary', () => {
    const direction = envelope('{"writePaths":["src/game/battle.ts"]}');
    expect(
      formalTaskContract(
        direction.replace('[formal-stage-deliverable:development:task]', 'ordinary'),
      ),
    ).toBeNull();
    expect(formalTaskContract(direction.split('\n直接前驱')[0])).toBeNull();
  });
});
