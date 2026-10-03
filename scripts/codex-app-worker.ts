import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { withoutApprovalRelay } from './worker-approval-relay';
import {
  applicationApprovalRequest,
  type AppApprovalDecision,
  type AppApprovalRequest,
} from './worker-app-approval';

export interface WorkerInvocation {
  sessionId: string | null;
  model: string;
  reasoning: string;
  outputFile: string;
}

export function appWorkerInvocation(args: string[]): WorkerInvocation {
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const sessionId = args[0] === 'exec' && args[1] === 'resume' ? args.at(-2)! : null;
  const model = value('-m');
  const outputFile = value('-o');
  const reasoning = args
    .find((arg) => /^model_reasoning_effort="(low|medium|high)"$/.test(arg))
    ?.split('"')[1];
  if (
    !model ||
    !outputFile ||
    !reasoning ||
    (sessionId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId))
  ) {
    throw new Error('Interactive worker invocation is incomplete');
  }
  if (
    args.includes('--output-schema') ||
    args.includes('review') ||
    args.includes('--dangerously-bypass-approvals-and-sandbox')
  ) {
    throw new Error('Unsupported interactive worker invocation');
  }
  return { sessionId, model, reasoning, outputFile };
}

/** Supported Codex app-server protocol; no native helper or browser protocol calls. */
export async function runAppServerWorker(options: {
  command: string;
  prefixArgs?: string[];
  cwd: string;
  invocation: WorkerInvocation;
  input: string;
  onApproval: (request: AppApprovalRequest) => Promise<AppApprovalDecision>;
  onOutput?: (text: string) => void;
  onStderr?: (text: string) => void;
}): Promise<number> {
  const child = spawn(
    options.command,
    [...(options.prefixArgs ?? []), 'app-server', '--listen', 'stdio://'],
    {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: withoutApprovalRelay(process.env),
    },
  );
  let nextId = 1;
  const responses = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  let threadId = '';
  let turnId = '';
  let finalText = '';
  let denied = false;
  let tokens: number | null = null;
  let finished = false;
  let finishTurn!: (code: number) => void;
  let failTurn!: (error: Error) => void;
  const completion = new Promise<number>((resolve, reject) => {
    finishTurn = resolve;
    failTurn = reject;
  });
  // A startup failure can precede the first awaited request.
  void completion.catch(() => {});
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      responses.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    for (const response of responses.values()) response.reject(error);
    responses.clear();
    failTurn(error);
  };
  child.on('error', fail);
  child.on('exit', (code) => {
    if (!finished) fail(new Error(`app-server exited before worker completion: ${code}`));
  });
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk: Buffer) => options.onStderr?.(chunk.toString()));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    void (async () => {
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
        result?: Record<string, unknown>;
        error?: { message: string };
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined && !message.method) {
        const response = responses.get(Number(message.id));
        if (!response) return;
        responses.delete(Number(message.id));
        if (message.error) response.reject(new Error(message.error.message));
        else response.resolve(message.result ?? {});
        return;
      }
      const params = message.params ?? {};
      if (message.id !== undefined && message.method) {
        // Requests may arrive before turn/start's response. Bind to the actual thread,
        // and latch the server's turn/started notification before handling them.
        const approval =
          !denied && message.method === 'mcpServer/elicitation/request'
            ? applicationApprovalRequest(params, threadId, turnId)
            : null;
        if (!approval) {
          denied = true;
          send({
            id: message.id,
            error: { code: -32601, message: 'Unsupported approval request; no operation approved' },
          });
          options.onOutput?.(`[审批阻断] 不支持 ${message.method}；未批准操作。\n`);
          send({ id: nextId++, method: 'turn/interrupt', params: { threadId, turnId } });
          return;
        }
        let decision: AppApprovalDecision;
        try {
          decision = await options.onApproval(approval);
        } catch (error) {
          denied = true;
          throw error;
        }
        if (finished) return;
        if (decision.action !== 'accept') denied = true;
        send({ id: message.id, result: decision });
        if (decision.action !== 'accept')
          send({ id: nextId++, method: 'turn/interrupt', params: { threadId, turnId } });
        return;
      }
      if (params.threadId !== threadId) return;
      if (message.method === 'turn/started')
        turnId = String((params.turn as { id?: string })?.id ?? '');
      if (message.method === 'item/completed') {
        const item = params.item as {
          type?: string;
          text?: string;
          phase?: string;
          tool?: string;
          error?: unknown;
        };
        if (item?.type === 'agentMessage') {
          options.onOutput?.(`${item.text ?? ''}\n`);
          if (item.phase !== 'commentary') finalText = item.text ?? '';
        }
        if (item?.type === 'mcpToolCall' && item.error)
          options.onOutput?.(`[工具失败] ${JSON.stringify(item.error)}\n`);
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage as { last?: { totalTokens?: number } };
        if (Number.isSafeInteger(usage?.last?.totalTokens)) tokens = usage.last!.totalTokens!;
      }
      if (message.method === 'turn/completed' && (params.turn as { id?: string })?.id === turnId) {
        finished = true;
        const turn = params.turn as { status?: string; error?: unknown };
        if (turn.error) options.onOutput?.(`[运行失败] ${JSON.stringify(turn.error)}\n`);
        finishTurn(turn.status === 'completed' && !denied ? 0 : 1);
      }
    })().catch((error: Error) => fail(error));
  });
  const startupTimer = setTimeout(
    () => fail(new Error('app-server initialization timed out')),
    30_000,
  );
  try {
    await request('initialize', {
      clientInfo: { name: 'daoyan_workflow', title: '道衍工作流', version: '1' },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    send({ method: 'initialized', params: {} });
    const common = {
      cwd: options.cwd,
      model: options.invocation.model,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: { model_reasoning_effort: options.invocation.reasoning, approvals_reviewer: 'user' },
    };
    const loaded = await request(options.invocation.sessionId ? 'thread/resume' : 'thread/start', {
      ...common,
      ...(options.invocation.sessionId
        ? { threadId: options.invocation.sessionId }
        : { ephemeral: false }),
    });
    threadId = String((loaded.thread as { id?: string })?.id ?? '');
    if (!threadId || (options.invocation.sessionId && threadId !== options.invocation.sessionId))
      throw new Error('app-server did not resume the requested worker session');
    options.onOutput?.(`session id: ${threadId}\n`);
    const started = await request('turn/start', {
      threadId,
      cwd: options.cwd,
      model: options.invocation.model,
      effort: options.invocation.reasoning,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [options.cwd], networkAccess: false },
      input: [{ type: 'text', text: options.input }],
    });
    turnId = String((started.turn as { id?: string })?.id ?? turnId);
    clearTimeout(startupTimer);
    const code = await completion;
    await writeFile(options.invocation.outputFile, `${finalText}\n`, 'utf8');
    if (tokens !== null) options.onOutput?.(`tokens used\n${tokens}\n`);
    return code;
  } finally {
    if (denied)
      options.onOutput?.(
        '[工作流工具审批阻断] 工具许可被拒绝、取消或无法处理；停止恢复重试与模型升级。\n',
      );
    clearTimeout(startupTimer);
    finished = true;
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === 'win32')
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else child.kill();
      }
    }
  }
}
