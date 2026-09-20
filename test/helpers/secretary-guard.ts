import type { ChildProcess } from 'node:child_process';

const STARTUP_TIMEOUT_MS = 20_000;
const RETRY_INTERVAL_MS = 100;
const MAX_CAPTURED_OUTPUT = 8_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function describeExit(child: ChildProcess, output: () => string, reason: string): Error {
  const exit = child.exitCode === null ? '尚未报告退出码' : `退出码 ${child.exitCode}`;
  const signal = child.signalCode ? `，信号 ${child.signalCode}` : '';
  const recentOutput = output();
  return new Error(
    `${reason}（notice guard ${exit}${signal}）${recentOutput ? `\n最近输出：\n${recentOutput}` : ''}`,
  );
}

/**
 * Wait for the guard's HTTP API rather than assuming that spawning Node means
 * the server is ready. Its termination promise makes a configuration or module
 * failure visible immediately, including the guard's recent diagnostic output.
 */
export async function waitForSecretaryDashboard(
  child: ChildProcess,
  url: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let capturedOutput = '';
  const appendOutput = (chunk: Buffer | string) => {
    capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  let rejectExit!: (reason: Error) => void;
  const exited = new Promise<never>((_resolveExit, reject) => {
    rejectExit = reject;
  });
  const rejectIfExited = (error?: Error) =>
    rejectExit(
      describeExit(
        child,
        () => capturedOutput,
        error
          ? `测试 notice guard 在 HTTP 就绪前启动失败：${error.message}`
          : '测试 notice guard 在 HTTP 就绪前退出',
      ),
    );
  child.once('error', rejectIfExited);
  child.once('exit', () => rejectIfExited());
  if (child.exitCode !== null) rejectIfExited();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const response = await Promise.race([
      fetch(`${url}/api/dashboard`, { signal: AbortSignal.timeout(Math.min(1_000, remaining)) })
        .then(async (result) =>
          result.ok ? ((await result.json()) as Record<string, unknown>) : undefined,
        )
        .catch(() => undefined),
      exited,
    ]);
    if (response) return response;
    await Promise.race([delay(Math.min(RETRY_INTERVAL_MS, deadline - Date.now())), exited]);
  }
  throw describeExit(
    child,
    () => capturedOutput,
    `测试 notice guard 未在 ${timeoutMs}ms 内通过 HTTP 就绪`,
  );
}
