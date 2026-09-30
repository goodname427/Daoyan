import { describe, expect, it } from 'vitest';
import {
  classifyScopeAmendmentAdvance,
  scopeAmendmentAdvanceMatches,
} from '../scripts/scope-amendment-advance';

describe('scope amendment after a partial task commit', () => {
  const previousWritePaths = [
    'src/game',
    'docs/reference/spell-authoring.md',
    'docs/versions/pilot/player-implementation.md',
  ];
  const addedWritePaths = ['test/first-batch-player.test.ts'];
  const committedPaths = [
    'docs/reference/spell-authoring.md',
    'docs/versions/pilot/player-implementation.md',
    'scripts/project-secretary.ts',
  ];

  it('allows only committed paths owned by the original task or control plane', () => {
    expect(classifyScopeAmendmentAdvance(committedPaths, previousWritePaths)).toEqual({
      controlPaths: ['scripts/project-secretary.ts'],
      taskPaths: committedPaths.slice(0, 2),
      unrelatedPaths: [],
    });
    expect(
      classifyScopeAmendmentAdvance(['src/game-extra/other.ts'], previousWritePaths).unrelatedPaths,
    ).toEqual(['src/game-extra/other.ts']);
  });

  it('requires the resume audit to match both the committed advance and amended contract', () => {
    const audit = {
      previousWritePaths,
      addedWritePaths,
      interveningControlPaths: ['scripts/project-secretary.ts'],
      interveningTaskPaths: committedPaths.slice(0, 2),
    };
    expect(
      scopeAmendmentAdvanceMatches(audit, committedPaths, [
        ...previousWritePaths,
        ...addedWritePaths,
      ]),
    ).toBe(true);
    expect(
      scopeAmendmentAdvanceMatches(
        audit,
        [...committedPaths, 'docs/status.md'],
        [...previousWritePaths, ...addedWritePaths],
      ),
    ).toBe(false);
    expect(scopeAmendmentAdvanceMatches(audit, committedPaths, previousWritePaths)).toBe(false);
  });
});
