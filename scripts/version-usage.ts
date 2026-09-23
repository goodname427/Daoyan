import { open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SecretaryItem } from './secretary-state';
import type { VersionStage } from './version-lifecycle';

export interface VersionStageUsage {
  observedCalls: number;
  knownTokens: number | null;
  missingUsageCalls: number;
  unavailableRunDirectories: number;
  referenceTokens: number;
  overReference: boolean;
  source: 'invocation-logs';
}

const REFERENCES: Partial<Record<VersionStage, number>> = {
  development: 1_000_000,
  qa: 150_000,
  bugfix: 250_000,
  candidate: 120_000,
};

export function parseInvocationTokens(output: string): number | null {
  const matches = [...output.matchAll(/tokens used\s*\r?\n\s*([\d,]+)/gi)];
  const value = matches.at(-1)?.[1];
  if (!value) return null;
  const tokens = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
}

function isInvocationLog(name: string): boolean {
  return /-gpt-[a-z0-9.-]+-attempt-\d+\.log$/i.test(name) || name === 'planner.log';
}

export async function runInvocationUsage(directory: string): Promise<{
  observedCalls: number;
  knownTokens: number | null;
  missingUsageCalls: number;
  unavailableRunDirectories: number;
}> {
  const names = await readdir(directory).catch(() => null);
  if (!names) {
    return {
      observedCalls: 0,
      knownTokens: null,
      missingUsageCalls: 0,
      unavailableRunDirectories: 1,
    };
  }
  let observedCalls = 0;
  let missingUsageCalls = 0;
  let knownTokens = 0;
  let knownCalls = 0;
  for (const name of names.filter(isInvocationLog)) {
    observedCalls += 1;
    const tokens = await tokenFooter(resolve(directory, name));
    if (tokens === null) missingUsageCalls += 1;
    else {
      knownTokens += tokens;
      knownCalls += 1;
    }
  }
  return {
    observedCalls,
    knownTokens: knownCalls > 0 ? knownTokens : null,
    missingUsageCalls,
    unavailableRunDirectories: 0,
  };
}

async function tokenFooter(path: string): Promise<number | null> {
  try {
    const file = await open(path, 'r');
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, 16_384);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return parseInvocationTokens(buffer.toString('utf8'));
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export async function versionStageUsage(
  versionId: string,
  stage: VersionStage,
  items: SecretaryItem[],
): Promise<VersionStageUsage> {
  const runDirectories = [
    ...new Set(
      items
        .filter(
          (item) =>
            item.orchestration?.formalVersionId === versionId &&
            item.orchestration.formalStage === stage &&
            item.runDirectory,
        )
        .map((item) => resolve(item.runDirectory)),
    ),
  ];
  let observedCalls = 0;
  let missingUsageCalls = 0;
  let unavailableRunDirectories = 0;
  let knownTokens = 0;
  let knownCalls = 0;
  for (const directory of runDirectories) {
    const run = await runInvocationUsage(directory);
    observedCalls += run.observedCalls;
    missingUsageCalls += run.missingUsageCalls;
    unavailableRunDirectories += run.unavailableRunDirectories;
    if (run.knownTokens !== null) {
      knownTokens += run.knownTokens;
      knownCalls += 1;
    }
  }
  const referenceTokens = REFERENCES[stage] ?? 100_000;
  return {
    observedCalls,
    knownTokens: knownCalls > 0 ? knownTokens : null,
    missingUsageCalls,
    unavailableRunDirectories,
    referenceTokens,
    overReference: knownTokens > referenceTokens,
    source: 'invocation-logs',
  };
}
