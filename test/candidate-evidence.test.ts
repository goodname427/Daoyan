import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  candidateManifestPath,
  parseCandidateEvidence,
  verifyCandidateFiles,
  type CandidatePass,
} from '../scripts/candidate-evidence';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function passed(): CandidatePass {
  return {
    schemaVersion: 1,
    status: 'passed',
    sourceRevision: 'a'.repeat(40),
    build: {
      command: 'npm run build',
      exitCode: 0,
      finishedAt: '2026-09-23T17:00:00.000Z',
      artifacts: [
        { path: 'dist/index.html', sha256: sha('html') },
        { path: 'dist/assets/app.css', sha256: sha('css') },
        { path: 'dist/assets/app.js', sha256: sha('js') },
      ],
    },
    browser: {
      command: 'node scripts/run-playwright.mjs test --config playwright.candidate.config.ts',
      exitCode: 0,
      finishedAt: '2026-09-23T17:01:00.000Z',
      checks: ['candidate-journey', 'candidate-narrow', 'candidate-ledger'],
      evidence: ['docs/versions/release/candidate-browser.json'],
    },
  };
}

describe('candidate evidence', () => {
  it('finds the formal version manifest and stops for a declared environment block', () => {
    expect(candidateManifestPath('写入 docs/versions/draft-2026-09-23-x-/candidate.json')).toBe(
      'docs/versions/draft-2026-09-23-x-/candidate.json',
    );
    expect(candidateManifestPath('普通文档任务')).toBeNull();
    expect(
      parseCandidateEvidence({
        schemaVersion: 1,
        status: 'blocked',
        blocker: 'esbuild spawn EPERM',
        evidence: ['docs/versions/release/candidate.md'],
      }).status,
    ).toBe('blocked');
  });

  it('rejects a documentation-only candidate or an incomplete browser run', () => {
    expect(() => parseCandidateEvidence(null)).toThrow('候选证据格式无效');
    expect(() => parseCandidateEvidence({ schemaVersion: 1, status: 'passed' })).toThrow(
      '候选缺少成功构建',
    );
    expect(() =>
      parseCandidateEvidence({
        ...passed(),
        browser: { ...passed().browser, checks: ['candidate-journey'] },
      }),
    ).toThrow('候选缺少成功构建');
    expect(() =>
      parseCandidateEvidence({ ...passed(), build: { ...passed().build, exitCode: 1 } }),
    ).toThrow('候选缺少成功构建');
  });

  it('checks candidate artifact hashes and browser evidence on disk', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'daoyan-candidate-'));
    try {
      await mkdir(resolve(root, 'dist/assets'), { recursive: true });
      await mkdir(resolve(root, 'docs/versions/release'), { recursive: true });
      await writeFile(resolve(root, 'dist/index.html'), 'html');
      await writeFile(resolve(root, 'dist/assets/app.css'), 'css');
      await writeFile(resolve(root, 'dist/assets/app.js'), 'js');
      await writeFile(resolve(root, 'docs/versions/release/candidate-browser.json'), '{}');
      await expect(verifyCandidateFiles(root, passed())).resolves.toBeUndefined();
      await writeFile(resolve(root, 'dist/assets/app.js'), 'changed');
      await expect(verifyCandidateFiles(root, passed())).rejects.toThrow('哈希不匹配');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
