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
  | 'cancelled'
  | 'superseded'
  | 'merged'
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

export interface SecretaryItemResolution {
  id: string;
  stableKey: string;
  itemId: string;
  status: 'delivered' | 'cancelled' | 'superseded' | 'merged';
  reason: string;
  reference: string;
  relatedItemIds: string[];
  correctionNoticeId: string;
  correctionSentAt: string;
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
    | 'bootstrapping'
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
  itemResolutions?: SecretaryItemResolution[];
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
  lastProgressPhase?: string;
  lastProgressNoticeAt?: string;
  takeoverReason?: string;
  takeoverOnResume?: boolean;
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
  const itemResolutions = Object.hasOwn(value, 'itemResolutions') ? value.itemResolutions : [];
  if (
    !Array.isArray(itemResolutions) ||
    itemResolutions.some(
      (entry) =>
        !isRecord(entry) ||
        !['delivered', 'cancelled', 'superseded', 'merged'].includes(String(entry.status)) ||
        !isStringArray(entry.relatedItemIds) ||
        [
          entry.id,
          entry.stableKey,
          entry.itemId,
          entry.reason,
          entry.reference,
          entry.correctionNoticeId,
          entry.correctionSentAt,
          entry.createdAt,
        ].some((field) => typeof field !== 'string'),
    )
  ) {
    throw new Error('秘书事项对账记录损坏；已停止自动写入和派发');
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
        'bootstrapping',
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
      'bootstrapping',
      'missing',
    ].includes(value.reconciliationOutcome) ||
    typeof value.awaitingReview !== 'boolean' ||
    typeof value.processOccupied !== 'boolean' ||
    ['waitingSnapshot', 'acknowledgedWaitingSnapshot', 'formalStageConsumedAt'].some(
      (field) => Object.hasOwn(value, field) && typeof value[field] !== 'string',
    ) ||
    ['lastProgressPhase', 'lastProgressNoticeAt'].some(
      (field) => Object.hasOwn(value, field) && typeof value[field] !== 'string',
    ) ||
    ['formalVersionId', 'formalStage'].some(
      (field) => Object.hasOwn(value, field) && typeof value[field] !== 'string',
    ) ||
    (Object.hasOwn(value, 'formalStageStep') &&
      !['primary', 'reverification'].includes(String(value.formalStageStep))) ||
    (Object.hasOwn(value, 'formalScopeRevision') &&
      (!Number.isSafeInteger(value.formalScopeRevision) ||
        Number(value.formalScopeRevision) <= 0)) ||
    (Object.hasOwn(value, 'takeoverOnResume') && typeof value.takeoverOnResume !== 'boolean')
  ) {
    throw new Error(`秘书事项 ${item.id} 的编排扩展损坏；已停止自动写入和派发`);
  }
}

export interface IntakeDecision {
  action: 'answer-completed' | 'track-active' | 'queue-scheduled' | 'queue-new';
  fact: ProjectFact | null;
}

/** Workflow control-plane changes must never be delegated back into that control plane. */
export function isWorkflowControlPlaneRequest(value: string): boolean {
  const clauses = value
    .toLowerCase()
    .split(/[\r\n。！？!?；;]+/u)
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return clauses.some(
    (clause) =>
      /(常驻秘书|秘书(?:系统|功能|看板|中枢)|notice\s*guard|agent\s*workflow|agent\s*调度|feature\s*pm|版本调度器|任务调度器|项目中枢|工作流)/i.test(
        clause,
      ) &&
      /(修复|开发|新增|增加|调整|改进|优化|重构|排查|检查|卡住|阻塞|失效|不工作|没反应|异常|问题)/i.test(
        clause,
      ),
  );
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
  return /(?:新方向|新需求|新(?:的)?正式版本|下(?:一|个)版本|版本方向|(?:新增|增加|加入|开发|实现|取消|删除|移除|禁止|替换|改为|调整).{0,12}(?:系统|功能|玩法|模块|视图|目标)|(?:另外|后续|以后).{0,12}(?:系统|功能|玩法|方向)|我希望.{0,12}(?:新增|增加|加入|开发|实现)|不希望|不要|不再|不能|去掉|停止|改成|换成|替换为|调整为|扩展|缩减|限制|允许|不兼容)/.test(
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
      /(进度|状态|做到|为什么|为何|为啥|怎么|如何|是否|有没有|哪些|还有多少任务|剩余多少任务)/.test(
        normalized,
      )
    )
      return 'question';
    if (messageIsNewDirection(normalized)) return 'direction';
    if (/(继续|接着|恢复|往下|按计划|照常|可以推进|可以开始)/.test(normalized)) return 'continue';
    return 'reply';
  }
  if (
    /[?？]$/.test(normalized) ||
    /^(为什么|为何|为啥|怎么|如何|是否|有没有|进度|状态|哪些)/.test(normalized) ||
    /(为什么|为何|为啥|怎么).{0,32}(审查|门禁|卡住|进度|阶段)/.test(normalized) ||
    /(?:还有|剩余|完成).{0,8}(?:多少|几).{0,8}(?:任务|工作项)/.test(normalized) ||
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
  const seen = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item]));
  const secretaryReferenceId = (item: SecretaryItem): string | null => {
    const match = /^secretary:(.+)$/.exec(item.matchedFact?.reference ?? '');
    return match?.[1] || null;
  };
  const referencedIds = new Set(items.map(secretaryReferenceId).filter((id): id is string => !!id));
  const stableReference = (item: SecretaryItem): string => {
    let current = item;
    const visited = new Set<string>();
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const targetId = secretaryReferenceId(current);
      if (!targetId || targetId === current.id) break;
      const target = byId.get(targetId);
      if (!target) return `secretary:${targetId}`;
      current = target;
    }
    if (referencedIds.has(current.id) || current.id !== item.id) return `secretary:${current.id}`;
    return `secretary:${item.id}`;
  };
  const priority = (item: SecretaryItem): number =>
    ['active', 'tracking', 'retry-wait', 'waiting-producer'].includes(item.status) ? 0 : 1;
  return [...items]
    .sort((left, right) => priority(left) - priority(right))
    .filter((item) =>
      ['queued', 'backlog', 'active', 'tracking', 'retry-wait', 'waiting-producer'].includes(
        item.status,
      ),
    )
    .filter((item) => {
      const reference = stableReference(item);
      if (seen.has(reference)) return false;
      seen.add(reference);
      return true;
    })
    .map((item) => ({
      kind: item.status === 'queued' || item.status === 'backlog' ? 'scheduled' : 'active',
      text: item.idea,
      reference: stableReference(item),
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
      itemResolutions: [],
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
      itemResolutions: [],
      migratedFrom: 'secretary-v1',
    };
    changed = true;
  }
  if (!Object.hasOwn(state.orchestration!, 'itemResolutions')) {
    state.orchestration!.itemResolutions = [];
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
  if (reconcileSecretaryBacklog(state)) changed = true;
  return changed;
}

function stableIdeaKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:()（）【】[\]"']/g, '')
    .slice(0, 160);
}

function addItemResolution(
  state: SecretaryState,
  item: SecretaryItem,
  input: Omit<
    SecretaryItemResolution,
    'id' | 'stableKey' | 'itemId' | 'createdAt' | 'correctionSentAt'
  >,
): boolean {
  const records = state.orchestration!.itemResolutions!;
  const stableKey = stableIdeaKey(item.idea);
  if (records.some((entry) => entry.itemId === item.id && entry.status === input.status))
    return false;
  const createdAt = state.updatedAt || item.updatedAt || new Date().toISOString();
  records.push({
    id: `resolution-${item.id}-${input.status}`,
    stableKey,
    itemId: item.id,
    ...input,
    correctionSentAt: '',
    createdAt,
  });
  return true;
}

/** Compatible, auditable migration for candidate facts that were already superseded or delivered. */
export function reconcileSecretaryBacklog(state: SecretaryState): boolean {
  state.orchestration ??= {
    schemaVersion: 1,
    intakes: [],
    nextVersionCandidates: [],
    reconciliations: [],
    itemResolutions: [],
    migratedFrom: 'secretary-v1',
  };
  state.orchestration.itemResolutions ??= [];
  let changed = false;
  const legacyCandidates = new Map<
    string,
    {
      status: 'delivered' | 'superseded';
      summary: string;
      reason: string;
      reference: string;
    }
  >([
    [
      '42c7e743-2bdc-4152-aaf4-c8cd979df279',
      {
        status: 'superseded',
        summary: '该候选已被钉钉常驻秘书移动入口替代，不再进入开发排期。',
        reason: '移动入口已由钉钉常驻秘书替代。',
        reference: 'docs/dev/2026-09-20-dingtalk-secretary-channel.md',
      },
    ],
    [
      '85d190db-9843-4f83-a35f-ea0608fa9d7c',
      {
        status: 'delivered',
        summary: '桌面项目中枢工作台增强已经交付，已从候选排期反向闭合。',
        reason: '桌面项目中枢工作台增强已经交付。',
        reference: 'commit:fddcdcb; docs/dev/2026-09-21-adaptive-project-office-vertical-slice.md',
      },
    ],
  ]);
  for (const item of state.items) {
    const migration = legacyCandidates.get(item.id);
    if (!migration || !['queued', 'backlog'].includes(item.status)) continue;
    if (migration.status === 'superseded') {
      item.status = 'superseded';
      item.summary = migration.summary;
      item.completedAt ||= state.updatedAt || item.updatedAt;
      changed =
        addItemResolution(state, item, {
          status: 'superseded',
          reason: migration.reason,
          reference: migration.reference,
          relatedItemIds: [],
          correctionNoticeId: `schedule-correction-${item.id}-superseded`,
        }) || changed;
    } else {
      item.status = 'delivered';
      item.summary = migration.summary;
      item.completedAt ||= state.updatedAt || item.updatedAt;
      changed =
        addItemResolution(state, item, {
          status: 'delivered',
          reason: migration.reason,
          reference: migration.reference,
          relatedItemIds: [],
          correctionNoticeId: `schedule-correction-${item.id}-delivered`,
        }) || changed;
    }
  }

  // A terminal successor closes the entire stable secretary:<id> chain. Iterate
  // to a fixed point because state.items is ordered by creation, so A/B/C is the
  // common order even though closure must flow from terminal C back through B to A.
  const itemsById = new Map(state.items.map((item) => [item.id, item]));
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const successor of state.items) {
      const reference = successor.matchedFact?.reference ?? '';
      if (!reference.startsWith('secretary:')) continue;
      const original = itemsById.get(reference.slice('secretary:'.length));
      if (!original || original.id === successor.id) continue;
      if (!['delivered', 'cancelled', 'superseded', 'merged'].includes(successor.status)) continue;
      const status = successor.status as 'delivered' | 'cancelled' | 'superseded' | 'merged';
      if (original.status !== status) {
        original.status = status;
        original.completedAt ||= successor.completedAt || state.updatedAt;
        original.summary = `已由关联事项 ${successor.id} 反向闭合：${successor.summary}`;
        changed = true;
        propagated = true;
      }
      changed =
        addItemResolution(state, original, {
          status,
          reason: original.summary,
          reference: `secretary:${successor.id}`,
          relatedItemIds: [successor.id],
          correctionNoticeId: `schedule-correction-${original.id}-${status}`,
        }) || changed;
    }
  }
  return changed;
}

/** Explicitly associate known queued requests with a newly drafted version. */
export function mergeBacklogCandidatesIntoVersion(
  state: SecretaryState,
  versionId: string,
  requestIds: string[],
): number {
  if (
    !versionId.trim() ||
    requestIds.length === 0 ||
    new Set(requestIds).size !== requestIds.length
  ) {
    throw new Error('版本和来源请求必须明确且不能重复');
  }
  normalizeSecretaryState(state);
  const candidates = requestIds.map((requestId) => {
    const candidate = state.orchestration!.nextVersionCandidates.find(
      (entry) => entry.requestId === requestId,
    );
    const item = state.items.find((entry) => entry.id === requestId);
    if (!candidate || !item || !['backlog', 'merged'].includes(item.status)) {
      throw new Error(`找不到可合并的候选请求：${requestId}`);
    }
    const prior = state.orchestration!.itemResolutions!.find(
      (resolution) => resolution.itemId === item.id && resolution.status === 'merged',
    );
    if (prior && prior.reference !== `version:${versionId}`) {
      throw new Error(`候选请求 ${requestId} 已并入其他版本：${prior.reference}`);
    }
    if (item.status === 'merged' && !prior) {
      throw new Error(`候选请求 ${requestId} 已标记合并但缺少目标版本证据`);
    }
    return item;
  });
  let changed = 0;
  for (const item of candidates) {
    if (item.status === 'merged') continue;
    item.status = 'merged';
    item.summary = `已明确并入正式版本 ${versionId} 的策划范围；不再单独排期。`;
    item.completedAt = state.updatedAt || new Date().toISOString();
    if (
      addItemResolution(state, item, {
        status: 'merged',
        reason: item.summary,
        reference: `version:${versionId}`,
        relatedItemIds: [],
        correctionNoticeId: `schedule-correction-${item.id}-merged`,
      })
    )
      changed += 1;
  }
  return changed;
}

export function pendingScheduleCorrections(state: SecretaryState): SecretaryItemResolution[] {
  return (state.orchestration?.itemResolutions ?? []).filter(
    (resolution) => resolution.correctionNoticeId && !resolution.correctionSentAt,
  );
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

/** Close stale PM items after a control-plane formal version is retired or archived. */
export function closeArchivedVersionItems(
  state: SecretaryState,
  versionId: string,
  now: string,
): boolean {
  let changed = false;
  for (const item of state.items) {
    if (
      item.orchestration?.formalVersionId !== versionId ||
      !['queued', 'active', 'tracking', 'retry-wait', 'waiting-producer'].includes(item.status)
    ) {
      continue;
    }
    item.status = 'superseded';
    item.summary = '该工作流控制面阶段已由主 Agent 直接收口，旧 PM 事项不再恢复或派发。';
    item.completedAt ||= now;
    item.updatedAt = now;
    item.retryAt = '';
    item.processPid = 0;
    item.processIdentity = '';
    item.orchestration.processOccupied = false;
    item.orchestration.awaitingReview = false;
    item.orchestration.reconciliationOutcome = 'delivered';
    if (state.activeItemId === item.id) state.activeItemId = '';
    changed = true;
  }
  return changed;
}

/** Replace pre-migration development runs that collapsed a formal work-item graph into one task. */
export function supersedeCollapsedDevelopmentItems(
  state: SecretaryState,
  versionId: string,
  expectedTaskCount: number,
  now: string,
  eligibleItemIds?: ReadonlySet<string>,
): boolean {
  if (expectedTaskCount <= 1) return false;
  let changed = false;
  for (const item of state.items) {
    if (
      item.orchestration?.formalVersionId !== versionId ||
      item.orchestration.formalStage !== 'development' ||
      (eligibleItemIds && !eligibleItemIds.has(item.id)) ||
      !['queued', 'active', 'tracking', 'retry-wait'].includes(item.status) ||
      item.plannedTasks.length !== 1 ||
      item.plannedTasks[0] !== '执行版本开发'
    ) {
      continue;
    }
    item.status = 'superseded';
    item.summary = '旧开发计划把正式工作项压缩为单体任务，已由多任务依赖计划替代。';
    item.completedAt ||= now;
    item.updatedAt = now;
    item.retryAt = '';
    item.processPid = 0;
    item.processIdentity = '';
    item.orchestration.processOccupied = false;
    item.orchestration.awaitingReview = false;
    item.orchestration.reconciliationOutcome = 'delivered';
    if (state.activeItemId === item.id) state.activeItemId = '';
    changed = true;
  }
  return changed;
}

/** Replace stopped development runs that copied stage-wide reporting into every Task. */
export function supersedeRedundantDevelopmentItems(
  state: SecretaryState,
  versionId: string,
  now: string,
  eligibleItemIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const item of state.items) {
    if (
      item.orchestration?.formalVersionId !== versionId ||
      item.orchestration.formalStage !== 'development' ||
      !eligibleItemIds.has(item.id) ||
      !['queued', 'active', 'tracking', 'retry-wait'].includes(item.status)
    ) {
      continue;
    }
    item.status = 'superseded';
    item.summary =
      '旧开发计划把阶段报告复制给每个执行 Agent，已由“工作项执行 + Feature PM 一次汇总”计划替代。';
    item.completedAt ||= now;
    item.updatedAt = now;
    item.retryAt = '';
    item.processPid = 0;
    item.processIdentity = '';
    item.orchestration.processOccupied = false;
    item.orchestration.awaitingReview = false;
    item.orchestration.reconciliationOutcome = 'delivered';
    if (state.activeItemId === item.id) state.activeItemId = '';
    changed = true;
  }
  return changed;
}

/** Retire a migration attempt that exited before it could write a recovery snapshot. */
export function supersedeDevelopmentMigrationBootstrapFailures(
  state: SecretaryState,
  versionId: string,
  now: string,
  eligibleItemIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const item of state.items) {
    if (
      item.orchestration?.formalVersionId !== versionId ||
      item.orchestration.formalStage !== 'development' ||
      !eligibleItemIds.has(item.id) ||
      !['active', 'tracking', 'retry-wait', 'waiting-producer'].includes(item.status)
    ) {
      continue;
    }
    item.status = 'superseded';
    item.summary =
      '计划迁移后的首次启动未声明接管旧现场，已保留改动并改由显式 takeover 新尝试继续。';
    item.completedAt ||= now;
    item.updatedAt = now;
    item.retryAt = '';
    item.processPid = 0;
    item.processIdentity = '';
    item.orchestration.processOccupied = false;
    item.orchestration.awaitingReview = false;
    item.orchestration.reconciliationOutcome = 'delivered';
    if (state.activeItemId === item.id) state.activeItemId = '';
    changed = true;
  }
  return changed;
}

/** Reuse an already delivered batch when its rejected replacement did no work. */
export function reopenVerifiedDevelopmentDelivery(
  state: SecretaryState,
  versionId: string,
  emptyStoppedAttemptIds: ReadonlySet<string>,
  now: string,
): boolean {
  return reopenVerifiedStageDelivery(state, versionId, 'development', emptyStoppedAttemptIds, now);
}

/** A separately verified QA rerun may reuse a delivered report after an empty retry. */
export function reopenVerifiedQaDelivery(
  state: SecretaryState,
  versionId: string,
  emptyStoppedAttemptIds: ReadonlySet<string>,
  now: string,
): boolean {
  return reopenVerifiedStageDelivery(state, versionId, 'qa', emptyStoppedAttemptIds, now);
}

/** Recheck an environment-blocked QA report only after separate host evidence is supplied. */
export function reopenEnvironmentBlockedQaDelivery(
  state: SecretaryState,
  versionId: string,
  now: string,
): boolean {
  const item = [...state.items]
    .reverse()
    .find(
      (candidate) =>
        candidate.status === 'failed' &&
        candidate.summary.startsWith('版本测试环境阻断：') &&
        candidate.orchestration?.formalVersionId === versionId &&
        candidate.orchestration.formalStage === 'qa' &&
        Boolean(candidate.orchestration.formalStageConsumedAt),
    );
  if (!item) return false;
  item.status = 'delivered';
  item.summary = '独立宿主补验已通过，等待正式版本阶段重新核验。';
  item.updatedAt = now;
  delete item.orchestration!.formalStageConsumedAt;
  return true;
}

function reopenVerifiedStageDelivery(
  state: SecretaryState,
  versionId: string,
  stage: 'development' | 'qa',
  emptyStoppedAttemptIds: ReadonlySet<string>,
  now: string,
): boolean {
  const delivered = [...state.items]
    .reverse()
    .find(
      (item) =>
        item.status === 'delivered' &&
        item.orchestration?.formalVersionId === versionId &&
        item.orchestration.formalStage === stage &&
        Boolean(item.orchestration.formalStageConsumedAt) &&
        item.summary.startsWith('阶段交付未能写入正式版本'),
    );
  if (!delivered) return false;
  const replacements = state.items.filter(
    (item) =>
      emptyStoppedAttemptIds.has(item.id) &&
      item.orchestration?.formalVersionId === versionId &&
      item.orchestration.formalStage === stage &&
      item.orchestration.formalStageStep === delivered.orchestration?.formalStageStep &&
      item.orchestration.formalScopeRevision === delivered.orchestration?.formalScopeRevision &&
      ['active', 'tracking', 'retry-wait'].includes(item.status),
  );
  if (replacements.length === 0) return false;
  for (const item of replacements) {
    item.status = 'superseded';
    item.summary = '该阶段重试尚无已完成工作项；改为重新验收上一轮已交付且证据仍匹配的批次。';
    item.completedAt ||= now;
    item.updatedAt = now;
    item.retryAt = '';
    item.processPid = 0;
    item.processIdentity = '';
    item.orchestration!.processOccupied = false;
    item.orchestration!.awaitingReview = false;
    item.orchestration!.reconciliationOutcome = 'delivered';
    if (state.activeItemId === item.id) state.activeItemId = '';
  }
  delete delivered.orchestration!.formalStageConsumedAt;
  delivered.summary = '旧阶段批次的同树验证证据已重新核对，等待正式版本阶段验收。';
  delivered.updatedAt = now;
  return true;
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
  if (
    state.items.some(
      (item) =>
        item.status !== 'superseded' && item.orchestration?.reconciliationOutcome === 'missing',
    )
  )
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
  const pending = state.items.filter((item) =>
    ['queued', 'backlog', 'active', 'tracking', 'retry-wait', 'waiting-producer'].includes(
      item.status,
    ),
  );
  const effectiveFacts = projectFactsFromItems(pending);
  return {
    status: state.status,
    lastEventAt: state.lastEventAt,
    activeItemId: state.activeItemId,
    recentMessages: state.messages.slice(-20),
    items: state.items.map(
      ({ processPid: _processPid, processIdentity: _processIdentity, ...item }) => item,
    ),
    schedule: {
      pendingCount: effectiveFacts.length,
      activeCount: effectiveFacts.filter((fact) => fact.kind === 'active').length,
      backlogCount: effectiveFacts.filter((fact) => fact.kind === 'scheduled').length,
    },
    itemResolutions: state.orchestration?.itemResolutions ?? [],
  };
}
