import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const REQUIRED_CHECKS = ['candidate-journey', 'candidate-narrow', 'candidate-ledger'] as const;

export interface CandidatePass {
  schemaVersion: 1;
  status: 'passed';
  sourceRevision: string;
  build: {
    command: 'npm run build';
    exitCode: 0;
    finishedAt: string;
    artifacts: { path: string; sha256: string }[];
  };
  browser: {
    command: 'node scripts/run-playwright.mjs test --config playwright.candidate.config.ts';
    exitCode: 0;
    finishedAt: string;
    checks: string[];
    evidence: string[];
  };
}

export interface CandidateBlock {
  schemaVersion: 1;
  status: 'blocked';
  blocker: string;
  evidence: string[];
}

export type CandidateEvidence = CandidatePass | CandidateBlock;

export function candidateManifestPath(objective: string): string | null {
  return objective.match(/docs\/versions\/[a-zA-Z0-9_-]+\/candidate\.json/)?.[0] ?? null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && !!entry.trim())
  );
}

function hasRequiredChecks(value: unknown): value is string[] {
  return stringArray(value) && REQUIRED_CHECKS.every((check) => value.includes(check));
}

export function parseCandidateEvidence(value: unknown): CandidateEvidence {
  if (!record(value) || value.schemaVersion !== 1) throw new Error('候选证据格式无效');
  if (value.status === 'blocked') {
    if (
      typeof value.blocker !== 'string' ||
      !value.blocker.trim() ||
      !stringArray(value.evidence)
    ) {
      throw new Error('候选环境阻断必须说明原因并保留公开证据');
    }
    return value as unknown as CandidateBlock;
  }
  const build = value.build;
  const browser = value.browser;
  if (
    value.status !== 'passed' ||
    typeof value.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(value.sourceRevision) ||
    !record(build) ||
    build.command !== 'npm run build' ||
    build.exitCode !== 0 ||
    typeof build.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(build.finishedAt)) ||
    !Array.isArray(build.artifacts) ||
    build.artifacts.length < 3 ||
    !build.artifacts.every(
      (item) =>
        record(item) &&
        typeof item.path === 'string' &&
        typeof item.sha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(item.sha256),
    ) ||
    !record(browser) ||
    browser.command !==
      'node scripts/run-playwright.mjs test --config playwright.candidate.config.ts' ||
    browser.exitCode !== 0 ||
    typeof browser.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(browser.finishedAt)) ||
    !hasRequiredChecks(browser.checks) ||
    !stringArray(browser.evidence) ||
    browser.evidence.length === 0 ||
    Date.parse(browser.finishedAt) < Date.parse(build.finishedAt)
  ) {
    throw new Error('候选缺少成功构建、完整浏览器体验或修订证据');
  }
  return value as unknown as CandidatePass;
}

export async function verifyCandidateFiles(root: string, evidence: CandidatePass): Promise<void> {
  const paths = new Set(
    evidence.build.artifacts.map((artifact) => artifact.path.replaceAll('\\', '/')),
  );
  if (
    !paths.has('dist/index.html') ||
    ![...paths].some((path) => /^dist\/assets\/[^/]+\.css$/.test(path)) ||
    ![...paths].some((path) => /^dist\/assets\/[^/]+\.js$/.test(path))
  ) {
    throw new Error('候选构建缺少 HTML、CSS 或 JavaScript 产物');
  }
  for (const artifact of evidence.build.artifacts) {
    const path = resolve(root, artifact.path);
    const inRoot = relative(root, path);
    if (isAbsolute(artifact.path) || inRoot.startsWith('..') || isAbsolute(inRoot)) {
      throw new Error(`候选产物路径越界：${artifact.path}`);
    }
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error(`候选产物哈希不匹配：${artifact.path}`);
    }
  }
  for (const evidencePath of evidence.browser.evidence) {
    const path = resolve(root, evidencePath);
    const inRoot = relative(root, path);
    if (isAbsolute(evidencePath) || inRoot.startsWith('..') || isAbsolute(inRoot)) {
      throw new Error(`候选浏览器证据路径越界：${evidencePath}`);
    }
    if (!(await stat(path)).isFile()) throw new Error(`候选浏览器证据不是文件：${evidencePath}`);
  }
}
