import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOwnedProcessAlive } from './process-identity';
import { mergeBacklogCandidatesIntoVersion, type SecretaryState } from './secretary-state';
import { readFormalVersionById } from './version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [versionId, ...requestIds] = process.argv.slice(2);
if (!versionId || requestIds.length === 0) {
  throw new Error(
    '用法：tsx scripts/reconcile-secretary-candidates.ts <version-id> <request-id>...',
  );
}
const version = await readFormalVersionById(root, versionId);
if (!version) throw new Error(`找不到目标版本：${versionId}`);
const statePath = resolve(
  root,
  process.env.DAOYAN_SECRETARY_STATE_DIR ?? '.daoyan-agent/secretary',
  'state.json',
);
const state = JSON.parse(await readFile(statePath, 'utf8')) as SecretaryState;
if (isOwnedProcessAlive(state.pid, state.processIdentity)) {
  throw new Error('秘书仍在运行；先停止秘书，避免并发写入状态');
}
const changed = mergeBacklogCandidatesIntoVersion(state, version.id, requestIds);
if (changed > 0) {
  state.updatedAt = new Date().toISOString();
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, statePath);
}
console.log(`已将 ${changed} 条候选请求并入版本 ${version.id}；纠正通知将在秘书下次启动时发送。`);
