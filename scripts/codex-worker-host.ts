import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appWorkerInvocation, runAppServerWorker } from './codex-app-worker';
import { startApplicationApprovalServer } from './worker-app-approval';
import { publishApprovalRelay } from './worker-approval-relay';

async function main() {
  const [command, prefixJson, invocationJson] = process.argv.slice(2);
  if (!command || !prefixJson || !invocationJson) throw new Error('Missing worker invocation');
  const invocation = appWorkerInvocation(JSON.parse(invocationJson) as string[]);
  const outputDirectory = dirname(invocation.outputFile);
  const approvalFile = resolve(outputDirectory, 'application-approval.json');
  const auditFile = resolve(outputDirectory, 'application-approval-audit.jsonl');
  const audit = async (event: object) => {
    const prior = await readFile(auditFile, 'utf8').catch(() => '');
    await writeFile(
      auditFile,
      `${prior}${JSON.stringify({ ...event, recordedAt: new Date().toISOString() })}\n`,
    );
  };
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  let approvalId = '';
  const approvals = await startApplicationApprovalServer({
    onPending: async (url, request) => {
      await writeFile(
        approvalFile,
        JSON.stringify(
          {
            status: 'pending',
            threadId: request.threadId,
            turnId: request.turnId,
            message: request.message,
            app: request._meta.tool_params,
          },
          null,
          2,
        ),
      );
      await audit({
        status: 'requested',
        threadId: request.threadId,
        turnId: request.turnId,
        message: request.message,
        app: request._meta.tool_params,
      });
      approvalId = randomUUID();
      const relayed = await publishApprovalRelay({
        id: approvalId,
        status: 'pending',
        request,
        url,
      });
      process.stdout.write(
        `[审批待处理] ${request.message}${relayed ? '；已通知制作人，等待本机页面选择。' : `\n${url}`}\n`,
      );
    },
    onResolved: async (request, action) => {
      await publishApprovalRelay({ id: approvalId, status: 'resolved', request, action });
      await writeFile(
        approvalFile,
        JSON.stringify(
          { status: 'resolved', action, threadId: request.threadId, turnId: request.turnId },
          null,
          2,
        ),
      );
      await audit({
        status: 'resolved',
        action,
        threadId: request.threadId,
        turnId: request.turnId,
      });
      process.stdout.write(`[审批已处理] ${action}\n`);
    },
  });
  try {
    process.exitCode = await runAppServerWorker({
      command,
      prefixArgs: JSON.parse(prefixJson) as string[],
      cwd: process.cwd(),
      invocation,
      input: `${input}\n\n应用许可由宿主展示真实工具请求并等待制作人选择。不得访问或提交许可页面、发送审批 HTTP、自动点击许可、调整安全设置、改写审批状态文件或把既有工作授权冒充工具已批准。拒绝、取消及展示失败后保留技术阻断，不换应用身份、端口或工具路径绕过。`,
      onApproval: (request) => approvals.request(request),
      onOutput: (text) => process.stdout.write(text),
      onStderr: (text) => process.stderr.write(text),
    });
  } finally {
    await approvals.close();
  }
}

void main().catch((error: Error) => {
  console.error(`[审批宿主失败] ${error.message}`);
  process.exitCode = 1;
});
