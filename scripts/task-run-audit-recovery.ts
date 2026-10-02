import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface AuditedTaskRun {
  taskId: string;
  outputFile: string;
  logFile: string;
  model: string;
  attempts: number;
  changedFiles: string[];
  completedAt: string;
}

/** Recover a lost Task index only from its persisted output, log and public passed event. */
export async function taskRunsFromAuditedHistory(
  directory: string,
  taskIds: string[],
): Promise<AuditedTaskRun[]> {
  const names = await readdir(directory);
  const events = (await readFile(resolve(directory, 'public-events.jsonl'), 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          eventId?: string;
          createdAt?: string;
          payload?: { status?: string; path?: string };
        },
    );
  const recovered: AuditedTaskRun[] = [];
  for (const taskId of taskIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(taskId)) throw new Error('任务 ID 无法审计');
    const passed = events.filter(
      (event) => event.eventId?.startsWith(`task-${taskId}:`) && event.payload?.status === 'passed',
    );
    const laterFailure = events.some(
      (event) =>
        event.eventId?.startsWith(`task-${taskId}:`) &&
        event.payload?.status !== 'passed' &&
        Date.parse(event.createdAt ?? '') >= Date.parse(passed.at(-1)?.createdAt ?? ''),
    );
    if (
      passed.length !== 1 ||
      laterFailure ||
      !Number.isFinite(Date.parse(passed[0].createdAt ?? ''))
    ) {
      throw new Error(`任务 ${taskId} 缺少唯一的已通过公开事件`);
    }
    const outputNames = names.filter((name) =>
      new RegExp(`^${taskId}-(gpt-[a-z0-9.-]+)-attempt-(\\d+)\\.md$`, 'u').test(name),
    );
    if (outputNames.length !== 1) throw new Error(`任务 ${taskId} 的执行产物不唯一`);
    const outputName = outputNames[0];
    const match = new RegExp(`^${taskId}-(gpt-[a-z0-9.-]+)-attempt-(\\d+)\\.md$`, 'u').exec(
      outputName,
    );
    if (!match) throw new Error(`任务 ${taskId} 的执行产物名称不合法`);
    const logName = outputName.replace(/\.md$/u, '.log');
    if (!names.includes(logName)) throw new Error(`任务 ${taskId} 缺少执行日志`);
    const outputFile = resolve(directory, outputName);
    if (!(await readFile(outputFile, 'utf8')).trim()) throw new Error(`任务 ${taskId} 的输出为空`);
    const changedFiles = [
      ...new Set(
        events
          .filter((event) => event.eventId?.startsWith(`task-${taskId}-file-`))
          .map((event) => event.payload?.path)
          .filter((path): path is string => typeof path === 'string' && path.length > 0),
      ),
    ];
    recovered.push({
      taskId,
      outputFile,
      logFile: resolve(directory, logName),
      model: match[1],
      attempts: Number(match[2]),
      changedFiles,
      completedAt: passed[0].createdAt!,
    });
  }
  return recovered;
}
