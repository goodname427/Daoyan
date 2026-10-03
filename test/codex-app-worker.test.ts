import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appWorkerInvocation, runAppServerWorker } from '../scripts/codex-app-worker';
import type { AppApprovalDecision } from '../scripts/worker-app-approval';

const sessionId = '01a0fe61-f920-7df3-ab89-ef6707da36d6';

describe('interactive worker app-server transport', () => {
  it('retains the exact saved session and model, and rejects incomplete/schema invocations', () => {
    expect(
      appWorkerInvocation([
        'exec',
        'resume',
        '-m',
        'gpt-5.6-sol',
        '-c',
        'model_reasoning_effort="medium"',
        '-o',
        'result.md',
        sessionId,
        '-',
      ]),
    ).toEqual({ sessionId, model: 'gpt-5.6-sol', reasoning: 'medium', outputFile: 'result.md' });
    expect(() => appWorkerInvocation(['exec'])).toThrow();
    expect(() =>
      appWorkerInvocation([
        'exec',
        '-m',
        'sol',
        '-c',
        'model_reasoning_effort="low"',
        '-o',
        'a',
        '--output-schema',
        'b',
      ]),
    ).toThrow();
  });

  it('preserves explicit CLI role restrictions without treating full access as an app grant', () => {
    expect(
      appWorkerInvocation([
        '-a',
        'never',
        'exec',
        '-s',
        'read-only',
        '-m',
        'sol',
        '-c',
        'model_reasoning_effort="low"',
        '-o',
        'result.md',
        '-',
      ]),
    ).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      sessionId: null,
    });
    expect(
      appWorkerInvocation([
        'exec',
        'resume',
        '-c',
        'approval_policy="never"',
        '-c',
        'sandbox_mode="read-only"',
        '-m',
        'sol',
        '-c',
        'model_reasoning_effort="low"',
        '-o',
        'result.md',
        sessionId,
        '-',
      ]),
    ).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', sessionId });
    expect(() =>
      appWorkerInvocation([
        '-s',
        'invented',
        'exec',
        '-m',
        'sol',
        '-c',
        'model_reasoning_effort="low"',
        '-o',
        'result.md',
        '-',
      ]),
    ).toThrow('Unsupported worker execution policy');
  });

  it.each(['accept', 'always', 'decline', 'cancel', 'foreign'] as const)(
    'waits for the real %s response and never treats a refusal as successful delivery',
    async (action) => {
      const dir = await mkdtemp(resolve(tmpdir(), 'daoyan-app-worker-'));
      const fixture = resolve(dir, 'server.cjs');
      const outputFile = resolve(dir, 'result.md');
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let respond!: (value: AppApprovalDecision) => void;
      const response = new Promise<AppApprovalDecision>((resolve) => {
        respond = resolve;
      });
      const lines: string[] = [];
      await writeFile(
        fixture,
        `
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>console.log(JSON.stringify(x));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize'){if(!m.params.capabilities.mcpServerOpenaiFormElicitation)process.exit(4);send({id:m.id,result:{}});}
if(m.method==='config/read'){send({id:m.id,result:{config:{approval_policy:'never',sandbox_mode:'danger-full-access'}}});}
if(m.method==='thread/resume'){if(m.params.threadId!==${JSON.stringify(sessionId)}||m.params.approvalPolicy!=='never'||m.params.sandbox!=='danger-full-access')process.exit(5);send({id:m.id,result:{thread:{id:m.params.threadId},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}});}
if(m.method==='turn/start'){if(m.params.approvalPolicy!==undefined||m.params.sandboxPolicy!==undefined)process.exit(6);send({method:'turn/started',params:{threadId:${JSON.stringify(sessionId)},turn:{id:'turn-1'}}});send({id:m.id,result:{turn:{id:'turn-1'}}});send({id:99,method:'mcpServer/elicitation/request',params:{threadId:${JSON.stringify(action === 'foreign' ? 'foreign' : sessionId)},turnId:'turn-1',serverName:'node_repl',mode:'openai/form',message:'Allow electron?',requestedSchema:{type:'object',properties:{}},_meta:{connector_id:'computer-use',codex_approval_kind:'mcp_tool_call',tool_params:{app:'electron'}}}});}
if(m.id===99){fs.writeFileSync(${JSON.stringify(resolve(dir, 'decision.json'))},JSON.stringify(m));send({method:'item/completed',params:{threadId:${JSON.stringify(sessionId)},item:{type:'agentMessage',phase:'final_answer',text:'Role report'}}});send({method:'thread/tokenUsage/updated',params:{threadId:${JSON.stringify(sessionId)},tokenUsage:{last:{totalTokens:19}}}});send({method:'turn/completed',params:{threadId:${JSON.stringify(sessionId)},turn:{id:'turn-1',status:'completed'}}});}
});
`,
      );
      try {
        let completed = false;
        const running = runAppServerWorker({
          command: process.execPath,
          prefixArgs: [fixture],
          cwd: dir,
          invocation: { sessionId, model: 'gpt-5.6-sol', reasoning: 'medium', outputFile },
          input: 'Continue role work',
          onApproval: async () => {
            ready();
            return response;
          },
          onOutput: (line) => lines.push(line),
        }).then((code) => {
          completed = true;
          return code;
        });
        if (action !== 'foreign') {
          await readyPromise;
          expect(completed).toBe(false);
          expect(
            await readFile(resolve(dir, 'decision.json'), 'utf8').catch(() => null),
          ).toBeNull();
          respond(
            action === 'always'
              ? { action: 'accept', content: {}, _meta: { persist: 'always' } }
              : { action, content: action === 'accept' ? {} : null },
          );
        }
        expect(await running).toBe(action === 'accept' || action === 'always' ? 0 : 1);
        expect(await readFile(outputFile, 'utf8')).toBe('Role report\n');
        const decision = JSON.parse(await readFile(resolve(dir, 'decision.json'), 'utf8'));
        if (action === 'foreign') expect(decision.error).toBeTruthy();
        else if (action === 'always')
          expect(decision.result).toEqual({
            action: 'accept',
            content: {},
            _meta: { persist: 'always' },
          });
        else expect(decision.result.action).toBe(action);
        expect(lines.join('')).toContain(`session id: ${sessionId}`);
        expect(lines.join('')).toContain('tokens used\n19');
        if (action !== 'accept' && action !== 'always')
          expect(lines.join('')).toContain('[工作流工具审批阻断]');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['read-only', 'workspace-write', 'mismatch', 'unknown'] as const)(
    'checks effective permissions before starting a %s turn',
    async (mode) => {
      const dir = await mkdtemp(resolve(tmpdir(), 'daoyan-worker-policy-'));
      const fixture = resolve(dir, 'server.cjs');
      const policy = mode === 'read-only' ? 'readOnly' : 'workspaceWrite';
      await writeFile(
        fixture,
        `
const fs=require('node:fs');const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='config/read')send({id:m.id,result:{config:{approval_policy:'never',sandbox_mode:${JSON.stringify(mode === 'unknown' ? 'unknown' : 'workspace-write')}}}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'fresh'},approvalPolicy:${JSON.stringify(mode === 'mismatch' ? 'on-request' : 'never')},sandbox:{type:${JSON.stringify(policy)}}}});
if(m.method==='turn/start'){fs.writeFileSync(${JSON.stringify(resolve(dir, 'turn.json'))},JSON.stringify(m.params));send({method:'turn/started',params:{threadId:'fresh',turn:{id:'t'}}});send({id:m.id,result:{turn:{id:'t'}}});send({method:'turn/completed',params:{threadId:'fresh',turn:{id:'t',status:'completed'}}});}
});`,
      );
      try {
        const running = runAppServerWorker({
          command: process.execPath,
          prefixArgs: [fixture],
          cwd: dir,
          invocation: {
            sessionId: null,
            model: 'sol',
            reasoning: 'low',
            outputFile: resolve(dir, 'out.md'),
            ...(mode === 'read-only' ? { sandbox: 'read-only' as const } : {}),
          },
          input: 'Read only diagnostic',
          onApproval: async () => {
            throw new Error('No app operation requested');
          },
        });
        if (mode === 'mismatch' || mode === 'unknown') {
          await expect(running).rejects.toThrow(/execution policy/);
          expect(await readFile(resolve(dir, 'turn.json'), 'utf8').catch(() => null)).toBeNull();
        } else {
          expect(await running).toBe(0);
          const turn = JSON.parse(await readFile(resolve(dir, 'turn.json'), 'utf8'));
          expect(turn.sandboxPolicy).toBeUndefined();
          expect(turn.approvalPolicy).toBeUndefined();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
