import { buildLocalPlan } from './agent-routing';

export type SecretaryScope = 'feature' | 'version';
export type SecretaryMessageIntent = 'question' | 'direction' | 'reply' | 'continue';
export type SecretaryItemStatus =
  | 'queued'
  | 'tracking'
  | 'active'
  | 'retry-wait'
  | 'waiting-producer'
  | 'backlog'
  | 'answered'
  | 'delivered'
  | 'failed';

export interface ProjectFact {
  kind: 'completed' | 'scheduled' | 'active';
  text: string;
  reference: string;
}

export interface IntakeRequest {
  id: string;
  idea: string;
  createdAt: string;
}

export interface SecretaryItem {
  id: string;
  idea: string;
  scope: SecretaryScope;
  status: SecretaryItemStatus;
  summary: string;
  plannedTasks: string[];
  matchedFact: ProjectFact | null;
  runDirectory: string;
  processPid: number;
  processIdentity: string;
  recoveryAttempts: number;
  retryAt: string;
  producerGuidance: string;
  lastProducerRequestId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  completedTasks: SecretaryTaskCompletion[];
}

export interface SecretaryTaskCompletion {
  key: string;
  taskId: string;
  taskTitle: string;
  parentScope: SecretaryScope;
  parentTitle: string;
  versionTitle: string;
  completedAt: string;
  runDirectory: string;
}

export interface SecretaryConversationMessage {
  id: string;
  role: 'producer' | 'secretary';
  content: string;
  intent: SecretaryMessageIntent;
  createdAt: string;
}

export interface SecretaryState {
  version: 1;
  initializedAt: string;
  status: 'running' | 'stopped';
  pid: number;
  processIdentity: string;
  lastEventAt: string;
  activeItemId: string;
  items: SecretaryItem[];
  messages: SecretaryConversationMessage[];
  updatedAt: string;
}

export interface IntakeDecision {
  action: 'answer-completed' | 'track-active' | 'queue-scheduled' | 'queue-new';
  fact: ProjectFact | null;
}

export function taskCompletionKey(runDirectory: string, taskId: string): string {
  const normalizedDirectory = runDirectory.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${normalizedDirectory}#${taskId}`;
}

export function unrecordedTaskCompletions(
  recorded: SecretaryTaskCompletion[],
  discovered: SecretaryTaskCompletion[],
): SecretaryTaskCompletion[] {
  const known = new Set(recorded.map((completion) => completion.key));
  const pending: SecretaryTaskCompletion[] = [];
  for (const completion of discovered) {
    if (known.has(completion.key)) continue;
    known.add(completion.key);
    pending.push(completion);
  }
  return pending;
}

const COMPLETED_SECTIONS = new Set(['已具备', '当前迭代']);
const SCHEDULED_SECTIONS = new Set(['当前首要任务', '下一阶段候选']);
const GENERIC_TERMS = new Set([
  '一些',
  '一个',
  '我们',
  '现在',
  '这个',
  '那个',
  '希望',
  '需要',
  '功能',
  '支持',
  '新增',
  '项目',
  '可以',
  '应该',
  '进行',
]);

function cleanMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
    .replace(/`/g, '')
    .trim();
}

function intentTokens(value: string): Set<string> {
  const normalized = cleanMarkdown(value)
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:()（）【】[\]"']/g, '');
  const tokens = new Set<string>();
  for (const term of normalized.match(/[a-z0-9_-]{2,}/g) ?? []) tokens.add(term);
  const chinese = normalized.replace(/[^\p{Script=Han}]/gu, '');
  for (let index = 0; index < chinese.length - 1; index += 1) {
    const token = chinese.slice(index, index + 2);
    if (!GENERIC_TERMS.has(token)) tokens.add(token);
  }
  return tokens;
}

export function intentSimilarity(left: string, right: string): number {
  const a = intentTokens(left);
  const b = intentTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function inferMessageIntent(
  message: string,
  hasWaitingItem: boolean,
): SecretaryMessageIntent {
  const normalized = message.trim().toLowerCase();
  if (hasWaitingItem) {
    if (
      /[?？]$/.test(normalized) ||
      /(进度|状态|做到|为什么|为何|怎么|如何|是否|有没有|哪些)/.test(normalized)
    )
      return 'question';
    if (/(继续|接着|恢复|往下|按计划|照常|可以推进|可以开始)/.test(normalized)) return 'continue';
    return 'reply';
  }
  if (
    /[?？]$/.test(normalized) ||
    /^(现在|目前|为什么|为何|怎么|如何|是否|有没有|进度|状态|哪些)/.test(normalized)
  )
    return 'question';
  if (/(继续|接着|恢复|往下|按计划|照常|可以推进|可以开始)/.test(normalized)) return 'continue';
  return 'direction';
}

export function applyWaitingReply(
  state: SecretaryState,
  request: IntakeRequest,
  intent: SecretaryMessageIntent,
): SecretaryItem | null {
  if (intent !== 'reply' && intent !== 'continue') return null;
  const waiting = state.items.find(
    (item) => item.id === state.activeItemId && item.status === 'waiting-producer',
  );
  if (!waiting) return null;
  waiting.producerGuidance = request.idea;
  waiting.lastProducerRequestId = request.id;
  waiting.status = 'retry-wait';
  waiting.retryAt = request.createdAt;
  waiting.summary =
    intent === 'continue'
      ? '已恢复当前工作，将从原恢复点继续。'
      : '已理解你的回复，将从原恢复点继续。';
  state.activeItemId = '';
  return waiting;
}

function bestMatchingFact(idea: string, facts: ProjectFact[]): ProjectFact | null {
  const normalizedIdea = cleanMarkdown(idea).replace(/\s/g, '');
  let best: { fact: ProjectFact; score: number } | null = null;
  for (const fact of facts) {
    const normalizedFact = cleanMarkdown(fact.text).replace(/\s/g, '');
    const contained =
      normalizedIdea.length >= 6 &&
      normalizedFact.length >= 6 &&
      (normalizedIdea.includes(normalizedFact) || normalizedFact.includes(normalizedIdea));
    const score = contained ? 1 : intentSimilarity(idea, fact.text);
    if (score >= 0.68 && (!best || score > best.score)) best = { fact, score };
  }
  return best?.fact ?? null;
}

export function projectFactsFromStatus(markdown: string): ProjectFact[] {
  const facts: ProjectFact[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
    if (!item) continue;
    const kind = COMPLETED_SECTIONS.has(section)
      ? 'completed'
      : SCHEDULED_SECTIONS.has(section)
        ? 'scheduled'
        : null;
    if (kind)
      facts.push({ kind, text: cleanMarkdown(item[1]), reference: `docs/status.md#${section}` });
  }
  return facts;
}

export function projectFactsFromItems(items: SecretaryItem[]): ProjectFact[] {
  return items
    .filter((item) =>
      ['queued', 'backlog', 'active', 'tracking', 'retry-wait', 'waiting-producer'].includes(
        item.status,
      ),
    )
    .map((item) => ({
      kind: item.status === 'queued' || item.status === 'backlog' ? 'scheduled' : 'active',
      text: item.idea,
      reference: `secretary:${item.id}`,
    }));
}

export function decideIntake(idea: string, facts: ProjectFact[]): IntakeDecision {
  const active = bestMatchingFact(
    idea,
    facts.filter((fact) => fact.kind === 'active'),
  );
  if (active) return { action: 'track-active', fact: active };
  const scheduled = bestMatchingFact(
    idea,
    facts.filter((fact) => fact.kind === 'scheduled'),
  );
  if (scheduled) return { action: 'queue-scheduled', fact: scheduled };
  const completed = bestMatchingFact(
    idea,
    facts.filter((fact) => fact.kind === 'completed'),
  );
  if (completed) return { action: 'answer-completed', fact: completed };
  return { action: 'queue-new', fact: null };
}

export function createSecretaryState(now: string): SecretaryState {
  return {
    version: 1,
    initializedAt: now,
    status: 'running',
    pid: 0,
    processIdentity: '',
    lastEventAt: now,
    activeItemId: '',
    items: [],
    messages: [],
    updatedAt: now,
  };
}

export function isRunEligibleForAdoption(
  updatedAt: string,
  initializedAt: string,
  hasLiveProcess: boolean,
  graceMs = 5 * 60_000,
): boolean {
  if (hasLiveProcess) return true;
  const updated = Date.parse(updatedAt);
  const initialized = Date.parse(initializedAt);
  return (
    Number.isFinite(updated) &&
    Number.isFinite(initialized) &&
    updated >= initialized - Math.max(0, graceMs)
  );
}

export function itemFromIntake(
  request: IntakeRequest,
  facts: ProjectFact[],
  scope: SecretaryScope = 'feature',
): { item: SecretaryItem; response: string } {
  const decision = decideIntake(request.idea, facts);
  const plan = buildLocalPlan(decision.fact?.text ?? request.idea);
  const base = {
    id: request.id,
    idea: decision.fact?.text ?? request.idea,
    scope,
    plannedTasks: plan.tasks.map((task) => task.title),
    matchedFact: decision.fact,
    runDirectory: '',
    processPid: 0,
    processIdentity: '',
    recoveryAttempts: 0,
    retryAt: '',
    producerGuidance: '',
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
    completedAt: '',
    completedTasks: [],
  };
  if (decision.action === 'answer-completed') {
    const summary = `该方向已经完成：${decision.fact!.text}`;
    return {
      item: { ...base, status: 'answered', summary, completedAt: request.createdAt },
      response: summary,
    };
  }
  if (decision.action === 'track-active') {
    const summary = `该方向正在执行，已并入现有任务：${decision.fact!.text}`;
    return {
      item: { ...base, status: 'answered', summary, completedAt: request.createdAt },
      response: summary,
    };
  }
  if (decision.action === 'queue-scheduled') {
    const summary = `该方向已在项目排期中，秘书会在当前交付结束后推进：${decision.fact!.text}`;
    return { item: { ...base, status: 'queued', summary }, response: summary };
  }
  const summary = `已加入待办队列，预计由 PM 拆为：${base.plannedTasks.join('、')}`;
  return { item: { ...base, status: 'queued', summary }, response: summary };
}

export function firstUntrackedScheduledFact(
  facts: ProjectFact[],
  items: SecretaryItem[],
): ProjectFact | null {
  return (
    facts.find(
      (fact) =>
        fact.kind === 'scheduled' &&
        !items.some(
          (item) =>
            item.status !== 'answered' &&
            (intentSimilarity(item.idea, fact.text) >= 0.9 ||
              intentSimilarity(item.matchedFact?.text ?? '', fact.text) >= 0.9),
        ),
    ) ?? null
  );
}

export function nextRunnableItem(state: SecretaryState, now: string): SecretaryItem | null {
  if (state.activeItemId) return null;
  const timestamp = Date.parse(now);
  const firstPending = state.items.find((item) =>
    ['queued', 'retry-wait', 'active', 'tracking', 'waiting-producer'].includes(item.status),
  );
  if (!firstPending || firstPending.status === 'waiting-producer') return null;
  if (firstPending.status === 'queued') return firstPending;
  if (firstPending.status !== 'retry-wait') return null;
  return !firstPending.retryAt ||
    Number.isNaN(Date.parse(firstPending.retryAt)) ||
    Date.parse(firstPending.retryAt) <= timestamp
    ? firstPending
    : null;
}

export function publicSecretaryState(state: SecretaryState): object {
  return {
    status: state.status,
    lastEventAt: state.lastEventAt,
    activeItemId: state.activeItemId,
    recentMessages: state.messages.slice(-20),
    items: state.items.map(
      ({ processPid: _processPid, processIdentity: _processIdentity, ...item }) => item,
    ),
  };
}
