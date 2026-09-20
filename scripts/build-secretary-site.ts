import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardRoot = resolve(root, 'secretary-dashboard');
const outputRoot = resolve(root, '.output/public');

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function sanitizedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[A-Za-z]:[\\/][^\s，。；;]+/g, '[本机路径]')
    .replace(/(?:\.daoyan-agent|node_modules)[\\/][^\s，。；;]+/g, '[运行记录]');
}

export function sanitizeDashboardForSite(value: unknown): JsonRecord {
  const source = structuredClone(record(value));
  const agents = Array.isArray(source.agents) ? source.agents : [];
  source.agents = agents.map((entry) => {
    const agent = record(entry);
    const wasRunning = agent.running === true;
    return {
      ...agent,
      pid: 0,
      runDirectory: '',
      running: false,
      status: wasRunning ? 'waiting' : agent.status,
      phase: wasRunning ? `快照时：${sanitizedText(agent.phase)}` : sanitizedText(agent.phase),
      recentOutput: [],
      error:
        typeof agent.error === 'string' && agent.error
          ? '执行曾遇到错误，请回到实时中枢查看。'
          : '',
    };
  });

  const secretary = record(source.secretary);
  source.secretary = {
    status: 'snapshot',
    lastEventAt: secretary.lastEventAt ?? '',
    recentMessages: Array.isArray(secretary.recentMessages) ? secretary.recentMessages : [],
  };
  const todos = Array.isArray(source.todos) ? source.todos : [];
  source.todos = todos.map((entry) => {
    const todo = record(entry);
    const solutions = Array.isArray(todo.solutions) ? todo.solutions : [];
    return {
      source: todo.source,
      id: todo.id,
      title: sanitizedText(todo.title),
      detail: sanitizedText(todo.detail),
      recommendedAction: todo.recommendedAction,
      recommendedLabel: sanitizedText(todo.recommendedLabel),
      solutions: solutions.map((entry) => {
        const solution = record(entry);
        return {
          id: solution.id,
          label: sanitizedText(solution.label),
          description: sanitizedText(solution.description),
        };
      }),
    };
  });
  return source;
}

async function readJson(url: string): Promise<JsonRecord> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
  return record(await response.json());
}

export async function artifactContent(
  baseUrl: string,
  versionId: string,
  path: string,
): Promise<string> {
  const query = new URLSearchParams({ version: versionId, path });
  const response = await fetch(`${baseUrl}/api/artifact?${query}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`文档 ${path} 导出失败（${response.status}）`);
  const body = record(await response.json());
  if (typeof body.content !== 'string') throw new Error(`文档 ${path} 返回格式无效`);
  return body.content;
}

export async function buildSecretarySite(baseUrl = 'http://127.0.0.1:4317'): Promise<void> {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const initial = await readJson(`${normalizedBase}/api/dashboard`);
  const listedVersions = Array.isArray(initial.versions) ? initial.versions : [];
  const currentVersion = record(initial.version);
  const firstVersion = record(listedVersions[0]);
  const defaultVersionId =
    typeof currentVersion.id === 'string'
      ? currentVersion.id
      : typeof firstVersion.id === 'string'
        ? firstVersion.id
        : '';
  if (!defaultVersionId) throw new Error('项目中枢没有可导出的正式版本');

  const versionIds = listedVersions
    .map((entry) => record(entry).id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!versionIds.includes(defaultVersionId)) versionIds.unshift(defaultVersionId);

  const dashboards: Record<string, JsonRecord> = {};
  for (const versionId of versionIds) {
    const query = new URLSearchParams({ version: versionId });
    const dashboard = sanitizeDashboardForSite(
      await readJson(`${normalizedBase}/api/dashboard?${query}`),
    );
    const version = record(dashboard.version);
    const documents = Array.isArray(version.documents) ? version.documents : [];
    const artifacts: Record<string, string> = {};
    for (const entry of documents) {
      const document = record(entry);
      if (typeof document.path !== 'string') continue;
      artifacts[document.path] = await artifactContent(normalizedBase, versionId, document.path);
    }
    dashboard.artifacts = artifacts;
    dashboards[versionId] = dashboard;
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  for (const file of [
    'index.html',
    'dashboard.css',
    'dashboard.js',
    'manifest.webmanifest',
    'app-icon.png',
  ]) {
    await cp(resolve(dashboardRoot, file), resolve(outputRoot, file));
  }
  await writeFile(
    resolve(outputRoot, 'snapshot.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        defaultVersionId,
        dashboards,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const manifest = JSON.parse(
    await readFile(resolve(dashboardRoot, 'manifest.webmanifest'), 'utf8'),
  ) as JsonRecord;
  if (manifest.name !== '道衍项目中枢') throw new Error('站点清单校验失败');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  buildSecretarySite(process.env.DAOYAN_SECRETARY_SITE_URL).catch((error: unknown) => {
    console.error(`[手机版中枢构建失败] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
