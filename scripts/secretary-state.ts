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

export type IntakeDisposition =
  | 'answered'
  | 'resumed'
  | 'draft-created'
  | 'merged-current'
  | 'scope-review'
  | 'next-version-candidate'
  | 'needs-confirmation';

export interface SecretaryIntakeRecord {
  requestId: string;
  intent: SecretaryMessageIntent;
  disposition: IntakeDisposition;
  status: 'pending' | 'completed' | 'blocked';
  targetVersionId: string;
  scopeRevision: number | null;
  reason: string;
  createdAt: string;
  completedAt: string;
}

export interface NextVersionCandidate {
  id: string;
  requestId: string;
  direction: string;
  reason: string;
  sourceVersionId: string;
  createdAt: string;
}

export interface SecretaryReconciliation {
  itemId: string;
  runId: string;
  attempt: number;
  snapshotStatus: string;
  outcome:
    | 'running'
    | 'awaiting-review'
    | 'delivered'
    | 'waiting-producer'
    | 'retry-wait'
    | 'blocked'
    | 'missing';
  reason: string;
  evidence: string[];
  reconciledAt: string;
}

export interface SecretaryOrchestration {
  schemaVersion: 1;
  intakes: SecretaryIntakeRecord[];
  nextVersionCandidates: NextVersionCandidate[];
  reconciliations: SecretaryReconciliation[];
  migratedFrom: 'native' | 'secretary-v1';
}

export interface SecretaryItemOrchestration {
  schemaVersion: 1;
  runId: string;
  attempt: number;
  reconciliationOutcome: SecretaryReconciliation['outcome'] | '';
  awaitingReview: boolean;
  processOccupied: boolean;
  waitingSnapshot?: string;
  acknowledgedWaitingSnapshot?: string;
  formalVersionId?: string;
  formalStage?: string;
  formalScopeRevision?: number;
  formalStageStep?: 'primary' | 'reverification';
  formalStageConsumedAt?: string;
}

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
  orchestration?: SecretaryItemOrchestration;
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
  orchestration?: SecretaryOrchestration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateSecretaryOrchestration(value: unknown): asserts value is SecretaryOrchestration {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('秘书编排扩展损坏；已停止自动写入和派发');
  }
  if (!['native', 'secretary-v1'].includes(String(value.migratedFrom))) {
    throw new Error('秘书编排扩展迁移来源无效；已停止自动写入和派发');
  }
  if (
    !Array.isArray(value.intakes) ||
    !Array.isArray(value.nextVersionCandidates) ||
    !Array.isArray(value.reconciliations)
  ) {
    throw new Error('秘书编排扩展损坏；已停止自动写入和派发');
  }
  const invalidIntake = value.intakes.some(
    (entry) =>
      !isRecord(entry) ||
      !['question', 'direction', 'reply', 'continue'].includes(String(entry.intent)) ||
      ![
        'answered',
        'resumed',
        'draft-created',
        'merged-current',
        'scope-review',
        'next-version-candidate',
        'needs-confirmation',
      ].includes(String(entry.disposition)) ||
      !['pending', 'completed', 'blocked'].includes(String(entry.status)) ||
      !(entry.scopeRevision === null || Number.isSafeInteger(entry.scopeRevision)) ||
      [
        entry.requestId,
        entry.targetVersionId,
        entry.reason,
        entry.createdAt,
        entry.completedAt,
      ].some((field) => typeof field !== 'string'),
  );
  const invalidCandidate = value.nextVersionCandidates.some(
    (entry) =>
      !isRecord(entry) ||
      [
        entry.id,
        entry.requestId,
        entry.direction,
        entry.reason,
        entry.sourceVersionId,
        entry.createdAt,
      ].some((field) => typeof field !== 'string'),
  );
  const invalidReconciliation = value.reconciliations.some(
    (entry) =>
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.attempt) ||
      Number(entry.attempt) < 0 ||
      ![
        'running',
        'awaiting-review',
        'delivered',
        'waiting-producer',
        'retry-wait',
        'blocked',
        'missing',
      ].includes(String(entry.outcome)) ||
      !isStringArray(entry.evidence) ||
      [entry.itemId, entry.runId, entry.snapshotStatus, entry.reason, entry.reconciledAt].some(
        (field) => typeof field !== 'string',
      ),
  );
  if (invalidIntake || invalidCandidate || invalidReconciliation) {
    throw new Error('秘书编排扩展嵌套记录损坏；已停止自动写入和派发');
  }
}

function validateItemOrchestration(item: SecretaryItem): void {
  const value = item.orchestration;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0 ||
    ![
      '',
      'running',
      'awaiting-review',
      'delivered',
      'waiting-producer',
      'retry-wait',
      'blocked',
      'missing',
    ].includes(value.reconciliationOutcome) ||
    typeof value.awaitingReview !== 'boolean' ||
    typeof value.processOccupied !== 'boolean' ||
    ['waitingSnapshot', 'acknowledgedWaitingSnapshot', 'formalStageConsumedAt'].some(
      (field) => Object.hasOwn(value, field) && typeof value[field] !== 'string',
    ) ||
    ['formalVersionId', 'formalStage'].some(
      (field) => Object.hasOwn(value, field) && typeof value[field] !== 'string',
    ) ||
    (Object.hasOwn(value, 'formalStageStep') &&
      !['primary', 'reverification'].includes(String(value.formalStageStep))) ||
    (Object.hasOwn(value, 'formalScopeRevision') &&
      (!Number.isSafeInteger(value.formalScopeRevision) || Number(value.formalScopeRevision) <= 0))
  ) {
    throw new Error(`秘书事项 ${item.id} 的编排扩展损坏；已停止自动写入和派发`);
  }
}

export interface IntakeDecision {
  action: 'answer-completed' | 'track-active' | 'queue-scheduled' | 'queue-new';
  fact: ProjectFact | null;
}

export type ContinueScheduleAction = 'running' | 'resumed' | 'ready' | 'waiting' | 'idle';

export interface ContinueScheduleResult {
  action: ContinueScheduleAction;
  item: SecretaryItem | null;
}

export type DirectionDestination =
  'draft-version' | 'current-version' | 'scope-review' | 'next-version-candidate';

export function directionDestination(
  idea: string,
  current: {
    status: 'drafting' | 'running' | 'waiting-producer' | 'paused' | 'archived';
    currentStage: string;
    scopeFrozen: boolean;
    direction: string;
  } | null,
): DirectionDestination {
  if (!current || current.status === 'archived') return 'draft-version';
  if (current.scopeFrozen) return 'next-version-candidate';
  // Before charter review the draft can absorb direction changes. Afterwards,
  // shared vocabulary proves topic association only, never unchanged promises.
  if (
    ['direction', 'charter-draft'].includes(current.currentStage) ||
    idea.trim() === current.direction.trim()
  ) {
    return 'current-version';
  }
  return 'scope-review';
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

export function messageIsNewDirection(message: string): boolean {
  const normalized = message.replace(/\s/g, '');
  return /(?:新方向|新需求|(?:新增|增加|加入|开发|实现|取消|删除|移除|禁止|替换|改为|调整).{0,12}(?:系统|功能|玩法|模块|视图|目标)|(?:另外|后续|以后).{0,12}(?:系统|功能|玩法|方向)|我希望.{0,12}(?:新增|增加|加入|开发|实现)|不希望|不要|不再|不能|去掉|停止|改成|换成|替换为|调整为|扩展|缩减|限制|允许|不兼容)/.test(
    normalized,
  );
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
    if (messageIsNewDirection(normalized)) return 'direction';
    if (/(继续|接着|恢复|往下|按计划|照常|可以推进|可以开始)/.test(normalized)) return 'continue';
    return 'reply';
  }
  if (
    /[?？]$/.test(normalized) ||
    /^(为什么|为何|怎么|如何|是否|有没有|进度|状态|哪些)/.test(normalized) ||
    /^(?:现在|目前).{0,16}(?:进度|状态|做到|情况)/.test(normalized)
  )
    return 'question';
  if (messageIsNewDirection(normalized)) return 'direction';
  if (/(继续|接着|恢复|往下|按计划|照常|可以推进|可以开始)/.test(normalized)) return 'continue';
  if (
    /^(?:好(?:的|吧)?|收到|知道了|明白了|了解|行|可以|ok|okay|嗯+|对|谢谢(?:你|您)?)(?:[\s，。！？,.!;；]|$)/.test(
      normalized,
    )
  ) {
    return 'reply';
  }
  if (/^(采用|选择|按).{0,24}(方案|做法)|^(通过|批准|确认|同意|退回|不通过)/.test(normalized)) {
    return 'reply';
  }
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
  acknowledgeWaitingSnapshot(waiting);
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

export function acknowledgeWaitingSnapshot(item: SecretaryItem): void {
  if (item.orchestration?.waitingSnapshot) {
    item.orchestration.acknowledgedWaitingSnapshot = item.orchestration.waitingSnapshot;
  }
}

export function applyContinueToSchedule(
  state: SecretaryState,
  request: IntakeRequest,
): ContinueScheduleResult {
  const active = state.activeItemId
    ? state.items.find((item) => item.id === state.activeItemId)
    : state.items.find((item) => item.status === 'active' || item.status === 'tracking');
  if (active && (active.status === 'active' || active.status === 'tracking')) {
    active.lastProducerRequestId = request.id;
    active.updatedAt = request.createdAt;
    return { action: 'running', item: active };
  }

  const pending = state.items.find((item) =>
    ['queued', 'retry-wait', 'active', 'tracking', 'waiting-producer'].includes(item.status),
  );
  if (!pending) return { action: 'idle', item: null };
  pending.lastProducerRequestId = request.id;
  pending.updatedAt = request.createdAt;
  if (pending.status === 'retry-wait') {
    pending.retryAt = request.createdAt;
    pending.summary = '制作人要求立即继续，正在从原恢复点重新启动。';
    return { action: 'resumed', item: pending };
  }
  if (pending.status === 'queued') return { action: 'ready', item: pending };
  if (pending.status === 'waiting-producer') return { action: 'waiting', item: pending };
  return { action: 'running', item: pending };
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
    orchestration: {
      schemaVersion: 1,
      intakes: [],
      nextVersionCandidates: [],
      reconciliations: [],
      migratedFrom: 'native',
    },
  };
}

export function normalizeSecretaryState(state: SecretaryState): boolean {
  let changed = false;
  const hasOrchestration = Object.prototype.hasOwnProperty.call(state, 'orchestration');
  if (hasOrchestration) validateSecretaryOrchestration(state.orchestration);
  if (!hasOrchestration) {
    state.orchestration = {
      schemaVersion: 1,
      intakes: [],
      nextVersionCandidates: [],
      reconciliations: [],
      migratedFrom: 'secretary-v1',
    };
    changed = true;
  }
  for (const item of state.items) {
    const hasItemOrchestration = Object.prototype.hasOwnProperty.call(item, 'orchestration');
    if (hasItemOrchestration) validateItemOrchestration(item);
    if (!hasItemOrchestration) {
      item.orchestration = {
        schemaVersion: 1,
        runId: '',
        attempt: Math.max(0, item.recoveryAttempts),
        reconciliationOutcome: '',
        awaitingReview: false,
        processOccupied: false,
      };
      changed = true;
    }
  }
  return changed;
}

export function reconciliationTargets(state: SecretaryState): SecretaryItem[] {
  const ids = new Set<string>();
  const targets: SecretaryItem[] = [];
  for (const item of state.items) {
    if (
      item.id !== state.activeItemId &&
      !['active', 'tracking', 'retry-wait'].includes(item.status)
    ) {
      continue;
    }
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    targets.push(item);
  }
  return targets;
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
  // Similarity locates a topic; only the same direction can reuse its commitment.
  const matchingFacts =
    inferMessageIntent(request.idea, false) === 'direction'
      ? facts.filter((fact) => fact.text.trim() === request.idea.trim())
      : facts;
  const decision = decideIntake(request.idea, matchingFacts);
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
    orchestration: {
      schemaVersion: 1 as const,
      runId: '',
      attempt: 0,
      reconciliationOutcome: '' as const,
      awaitingReview: false,
      processOccupied: false,
    },
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
  if (state.items.some((item) => item.orchestration?.reconciliationOutcome === 'missing'))
    return null;
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
