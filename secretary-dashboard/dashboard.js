const $ = (selector) => document.querySelector(selector);
const empty = () => document.querySelector('#empty-template').content.cloneNode(true);
const statusLabels = {
  pending: '待开始',
  active: '进行中',
  blocked: '受阻',
  backlog: '后续版本',
  completed: '已完成',
  skipped: '已跳过',
};
const agentStatusLabels = {
  running: '执行中',
  sleeping: '休眠',
  waiting: '等待',
  paused: '已暂停',
};

let selectedStage = '';
let selectedVersionId = '';
let selectedDocument = '';
let selectedAgentId = '';
let selectedItem = { type: 'stage', id: '' };
let loadedDocument = '';
let latestData = null;
let dashboardRequest = 0;
let documentRequest = 0;
let snapshotBundle = null;
let snapshotMode = false;
const pendingMessageKey = 'daoyan-secretary-pending-messages-v1';
const workspaceLayoutKey = 'daoyan-secretary-workspace-layout-v1';

function workspaceLayout() {
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(workspaceLayoutKey) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function saveWorkspaceLayout(layout) {
  globalThis.localStorage.setItem(workspaceLayoutKey, JSON.stringify(layout));
}

function pendingMessages() {
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(pendingMessageKey) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function setSnapshotMode(enabled, generatedAt = '') {
  snapshotMode = enabled;
  document.body.classList.toggle('snapshot-view', enabled);
  $('.dashboard-shell').classList.toggle('snapshot-mode', enabled);
  $('#site-mode-banner').hidden = !enabled;
  if (enabled) {
    text($('#snapshot-time'), `同步于 ${formatTime(generatedAt)}`);
    $('#send-button').textContent = '保存留言';
  } else {
    $('#send-button').textContent = '发送';
  }
}

async function snapshotDashboard(versionId) {
  if (!snapshotBundle) {
    const response = await fetch('./snapshot.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`快照接口 ${response.status}`);
    snapshotBundle = await response.json();
  }
  const targetId = versionId || snapshotBundle.defaultVersionId;
  const data =
    snapshotBundle.dashboards?.[targetId] ??
    snapshotBundle.dashboards?.[snapshotBundle.defaultVersionId];
  if (!data) throw new Error('快照中没有可查看的正式版本');
  setSnapshotMode(true, snapshotBundle.generatedAt);
  return data;
}

function formatTime(value) {
  if (!value) return '尚未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未计时';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function text(element, value) {
  element.textContent = value ?? '';
}

function appendDefinition(root, key, value) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = key;
  dd.textContent = value;
  wrapper.append(dt, dd);
  root.append(wrapper);
}

function renderVersionSelector(data) {
  const selects = [$('#sidebar-version-select')];
  const versions = data.versions ?? [];
  const desired = selectedVersionId || data.version?.id || '';
  for (const select of selects) {
    select.replaceChildren();
    for (const version of versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = `${version.title} · ${version.isCurrent ? '当前' : '历史'}${
        version.status === 'archived' ? ' · 已归档' : ''
      }`;
      option.selected = version.id === desired;
      select.append(option);
    }
    select.disabled = versions.length < 2;
  }
  selectedVersionId = selects[0]?.value || desired;
}

async function loadDocument(doc) {
  if (!doc?.path) return;
  const requestId = ++documentRequest;
  const versionId = selectedVersionId;
  selectedDocument = doc.path;
  const output = $('#artifact-content');
  text($('#document-title'), doc.title);
  output.textContent = '正在读取文档…';
  try {
    if (snapshotMode) {
      const content = latestData?.artifacts?.[doc.path];
      if (typeof content !== 'string') throw new Error('该文档未包含在本次快照中');
      if (requestId !== documentRequest || versionId !== selectedVersionId) return;
      output.textContent = content;
      loadedDocument = doc.path;
      return;
    }
    const query = new globalThis.URLSearchParams({
      version: versionId,
      path: doc.path,
    });
    const response = await fetch(`/api/artifact?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '无法读取文档');
    if (requestId !== documentRequest || versionId !== selectedVersionId) return;
    output.textContent = body.content;
    loadedDocument = doc.path;
  } catch (error) {
    if (requestId !== documentRequest || versionId !== selectedVersionId) return;
    output.textContent = error.message;
    loadedDocument = '';
  }
}

function renderDocumentList(node, version) {
  const root = $('#node-documents');
  root.replaceChildren();
  const documents = node?.documents ?? [];
  if (!documents.length) root.append(empty());
  for (const doc of documents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = doc.title;
    button.dataset.path = doc.path;
    button.classList.toggle('active', doc.path === selectedDocument);
    button.addEventListener('click', () => {
      root.querySelectorAll('button').forEach((candidate) => candidate.classList.remove('active'));
      button.classList.add('active');
      void loadDocument(doc);
    });
    root.append(button);
  }

  const all = $('#all-documents');
  const previous = all.value;
  all.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `全部版本文档（${version?.documents?.length ?? 0}）`;
  all.append(placeholder);
  for (const doc of version?.documents ?? []) {
    const option = document.createElement('option');
    option.value = doc.path;
    option.textContent = doc.title;
    all.append(option);
  }
  all.value =
    previous && [...all.options].some((option) => option.value === previous) ? previous : '';

  if (
    !selectedDocument ||
    !(version?.documents ?? []).some((item) => item.path === selectedDocument)
  ) {
    selectedDocument = documents[0]?.path ?? '';
    loadedDocument = '';
  }
  root
    .querySelectorAll('button')
    .forEach((button) =>
      button.classList.toggle('active', button.dataset.path === selectedDocument),
    );
  const target = (version?.documents ?? []).find((item) => item.path === selectedDocument);
  if (target && loadedDocument !== target.path) void loadDocument(target);
  if (!target) {
    text($('#document-title'), '暂无关联文档');
    text($('#artifact-content'), '该节点尚未登记文档证据。');
  }
}

function showNode(node, version) {
  selectedItem = { type: 'stage', id: node.id };
  selectedStage = node.id;
  document.querySelectorAll('.stage-node').forEach((element) => {
    element.classList.toggle('selected', element.dataset.stage === node.id);
  });
  text($('#detail-kicker'), node.producerGate ? '制作人门禁' : '流程节点');
  text($('#detail-title'), node.title);
  const meta = $('#detail-meta');
  meta.replaceChildren();
  appendDefinition(meta, '负责人', node.owner);
  appendDefinition(meta, '状态', statusLabels[node.status] ?? node.status);
  appendDefinition(meta, '开始', formatTime(node.startedAt));
  appendDefinition(meta, '完成', formatTime(node.completedAt));
  text($('#detail-summary'), node.summary || node.description);
  $('.document-workspace').hidden = false;
  $('#agent-workflow').hidden = true;
  $('#delivery-detail').hidden = true;
  renderDocumentList(node, version);
}

function renderStages(version) {
  const root = $('#stage-flow');
  root.replaceChildren();
  if (!version?.nodes?.length) {
    root.append(empty());
    return;
  }
  version.nodes.forEach((node, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stage-node ${node.status}`;
    button.dataset.stage = node.id;
    button.setAttribute('role', 'listitem');
    const number = document.createElement('span');
    number.className = 'stage-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const title = document.createElement('span');
    title.className = 'stage-title';
    title.textContent = node.title;
    const owner = document.createElement('span');
    owner.className = 'stage-owner';
    owner.textContent = node.owner;
    const status = document.createElement('span');
    status.className = 'stage-status';
    status.textContent = statusLabels[node.status] ?? node.status;
    button.append(number, title, owner, status);
    button.addEventListener('click', () => showNode(node, version));
    root.append(button);
  });
  if (selectedItem.type === 'stage' || !selectedItem.id) {
    const selection =
      version.nodes.find((node) => node.id === selectedStage) ??
      version.nodes.find((node) => node.id === version.currentStage) ??
      version.nodes[0];
    if (selection) showNode(selection, version);
  }
}

function showDeliveryItem(item, kind) {
  selectedItem = { type: kind, id: item.id ?? item.title };
  document.querySelectorAll('.delivery-item').forEach((element) => {
    element.classList.toggle('selected', element.dataset.deliveryId === selectedItem.id);
  });
  text($('#detail-kicker'), kind === 'bug' ? '版本缺陷' : '开发任务');
  text($('#detail-title'), item.title || (kind === 'bug' ? '未命名缺陷' : '未命名任务'));
  const meta = $('#detail-meta');
  meta.replaceChildren();
  const pairs =
    kind === 'bug'
      ? [
          ['严重程度', item.severity || '未标记'],
          ['状态', statusLabels[item.status] ?? item.status ?? '未标记'],
        ]
      : [
          ['负责人', item.owner || '未分配'],
          ['状态', statusLabels[item.status] ?? item.status ?? '未标记'],
        ];
  pairs.forEach(([key, value]) => appendDefinition(meta, key, value));
  text(
    $('#detail-summary'),
    kind === 'bug'
      ? item.actual || item.summary || '尚未记录实际现象。'
      : item.summary || item.objective || '尚无任务摘要。',
  );
  $('.document-workspace').hidden = true;
  $('#agent-workflow').hidden = true;
  const detail = $('#delivery-detail');
  detail.hidden = false;
  detail.replaceChildren();
  const entries =
    kind === 'bug'
      ? [
          ['期望结果', item.expected || '待补充'],
          ['实际现象', item.actual || '待补充'],
        ]
      : [
          ['任务说明', item.summary || item.objective || '待补充'],
          ['交付状态', statusLabels[item.status] ?? item.status ?? '待开始'],
        ];
  for (const [label, value] of entries) {
    const block = document.createElement('div');
    const heading = document.createElement('strong');
    const content = document.createElement('p');
    heading.textContent = label;
    content.textContent = value;
    block.append(heading, content);
    detail.append(block);
  }
}

function renderDataList(selector, items, kind) {
  const root = $(selector);
  root.replaceChildren();
  if (!items.length) {
    root.append(empty());
    return;
  }
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `delivery-item ${kind}`;
    row.dataset.deliveryId = item.id ?? item.title;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const summary = document.createElement('p');
    summary.textContent =
      kind === 'bug'
        ? `${item.expected || '待补期望'} / ${item.actual || '待补现象'}`
        : item.summary || '尚无摘要';
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const values =
      kind === 'bug'
        ? [item.severity, item.status]
        : [item.owner, statusLabels[item.status] ?? item.status];
    for (const value of values) {
      const span = document.createElement('span');
      span.textContent = value;
      meta.append(span);
    }
    row.append(title, summary, meta);
    row.addEventListener('click', () => {
      showDeliveryItem(item, kind);
      if (globalThis.matchMedia('(max-width: 800px)').matches) activatePane('focus');
    });
    root.append(row);
  }
}

function showAgent(agent) {
  selectedItem = { type: 'agent', id: agent.id };
  selectedAgentId = agent.id;
  text($('#agent-workflow-title'), agent.objective || agent.role);
  text($('#agent-workflow-state'), `${agentStatusLabels[agent.status] ?? agent.status} · 公开记录`);
  const meta = $('#agent-workflow-meta');
  meta.replaceChildren();
  for (const [key, value] of [
    ['角色', agent.role],
    ['模型', agent.model],
    ['阶段', agent.phase],
    ['运行时长', formatDuration(agent.elapsedSeconds)],
    ['更新', formatTime(agent.updatedAt)],
  ]) {
    const item = document.createElement('span');
    item.textContent = `${key}：${value}`;
    if (key === '运行时长') item.dataset.agentElapsed = agent.id;
    meta.append(item);
  }
  const events = $('#agent-workflow-events');
  const atBottom = events.scrollHeight - events.scrollTop - events.clientHeight < 30;
  events.replaceChildren();
  for (const event of agent.activity ?? []) {
    const row = document.createElement('article');
    row.className = `workflow-event ${event.kind}`;
    const time = document.createElement('time');
    time.textContent = formatTime(event.createdAt);
    const content = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = event.label;
    const detail = document.createElement('p');
    detail.textContent = event.detail;
    content.append(label, detail);
    row.append(time, content);
    events.append(row);
  }
  if (!events.childElementCount) events.append(empty());
  if (atBottom) events.scrollTop = events.scrollHeight;
  $('.document-workspace').hidden = true;
  $('#delivery-detail').hidden = true;
  $('#agent-workflow').hidden = false;
  document
    .querySelectorAll('.agent-card')
    .forEach((item) => item.classList.toggle('selected', item.dataset.agentId === agent.id));
}

function renderAgents(agents) {
  const root = $('#agent-list');
  root.replaceChildren();
  const running = agents.filter((agent) => agent.running).length;
  const paused = agents.filter((agent) => agent.status === 'paused').length;
  text($('#running-agent-count'), String(running));
  text($('#agent-summary'), `${running} 执行中${paused ? ` · ${paused} 暂停` : ''}`);
  if (!agents.length) {
    root.append(empty());
    return;
  }
  for (const agent of agents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `agent-card ${agent.status}`;
    button.dataset.agentId = agent.id;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const main = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = agent.role;
    const detail = document.createElement('small');
    detail.textContent = `${agent.model} · ${agent.phase}${
      agent.retryAt ? ` · ${formatTime(agent.retryAt)} 重试` : ''
    }`;
    main.append(title, detail);
    const state = document.createElement('span');
    state.textContent = agentStatusLabels[agent.status] ?? agent.status;
    button.append(dot, main, state);
    button.title = `${agent.role}：${detail.textContent}`;
    button.addEventListener('click', () => {
      showAgent(agent);
      if (globalThis.matchMedia('(max-width: 800px)').matches) activatePane('focus');
    });
    root.append(button);
  }
  if (selectedItem.type === 'agent' || !selectedItem.id) {
    const selected =
      agents.find((agent) => agent.id === selectedAgentId) ??
      agents.find((agent) => agent.running) ??
      agents[0];
    if (selected) showAgent(selected);
  }
}

async function actOnTodo(todo, action, note, button) {
  if (snapshotMode) {
    text($('#send-state'), '云端预览暂不执行项目操作，请在本机实时中枢处理');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/todo-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: todo.source, id: todo.id, action, note }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '待办处理失败');
    text($('#send-state'), result.message);
    await refresh();
  } catch (error) {
    text($('#send-state'), error.message);
  } finally {
    button.disabled = false;
  }
}

function renderTodos(todos) {
  const root = $('#producer-todos');
  root.replaceChildren();
  text($('#todo-count'), String(todos.length));
  if (!todos.length) {
    root.append(empty());
    return;
  }
  for (const todo of todos) {
    const row = document.createElement('article');
    row.className = 'todo';
    const title = document.createElement('strong');
    title.textContent = todo.title;
    const detail = document.createElement('p');
    detail.textContent = todo.detail;
    const actions = document.createElement('div');
    actions.className = 'todo-actions';
    const recommended = document.createElement('button');
    recommended.type = 'button';
    recommended.className = 'recommended';
    recommended.textContent = todo.recommendedLabel;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${todo.title}的处理方案`);
    for (const solution of todo.solutions) {
      const option = document.createElement('option');
      option.value = solution.id;
      option.textContent = solution.label;
      select.append(option);
    }
    const note = document.createElement('input');
    note.placeholder = '补充说明（可选）';
    note.setAttribute('aria-label', `${todo.title}的补充说明`);
    const solutionRow = document.createElement('div');
    solutionRow.className = 'solution-row';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = '确认方案';
    solutionRow.append(select, confirm);
    actions.append(recommended, note, solutionRow);
    recommended.addEventListener('click', () =>
      actOnTodo(todo, todo.recommendedAction, note.value.trim(), recommended),
    );
    confirm.addEventListener('click', () =>
      actOnTodo(todo, select.value, note.value.trim(), confirm),
    );
    row.append(title, detail, actions);
    root.append(row);
  }
}

function renderConversation(secretary) {
  const root = $('#conversation');
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 30;
  root.replaceChildren();
  const messages = [
    ...(secretary?.recentMessages ?? []),
    ...(snapshotMode ? pendingMessages() : []),
  ];
  if (!messages.length) root.append(empty());
  for (const message of messages) {
    const bubble = document.createElement('article');
    bubble.className = `message ${message.role}`;
    if (message.pending) bubble.classList.add('pending');
    const content = document.createElement('div');
    content.textContent = message.content;
    const time = document.createElement('time');
    time.textContent = `${message.role === 'producer' ? '制作人' : '秘书'} · ${formatTime(message.createdAt)}${
      message.pending ? ' · 待同步' : ''
    }`;
    bubble.append(content, time);
    root.append(bubble);
  }
  if (atBottom) root.scrollTop = root.scrollHeight;
}

function render(data) {
  latestData = data;
  renderVersionSelector(data);
  const version = data.version;
  const guard = $('#guard-state');
  guard.classList.toggle('online', !snapshotMode && data.secretary?.status === 'running');
  guard.lastChild.textContent = snapshotMode
    ? '云端快照'
    : data.secretary?.status === 'running'
      ? '秘书在线，空闲时休眠'
      : '秘书未运行';
  $('#history-badge').hidden = data.isCurrentVersion;
  if (version) {
    text($('#version-title'), version.title);
    text($('#version-direction'), version.direction);
    const node = version.nodes.find((item) => item.id === version.currentStage);
    text($('#current-stage'), `当前：${node?.title ?? version.currentStage}`);
    text(
      $('#version-health'),
      version.health === 'healthy'
        ? '状态稳定'
        : version.health === 'at-risk'
          ? '存在风险'
          : '流程受阻',
    );
    text($('#version-updated'), `更新于 ${formatTime(version.updatedAt)}`);
    text($('#progress-value'), `${version.progress}%`);
    $('#progress-bar').style.width = `${version.progress}%`;
    text(
      $('#next-action'),
      version.status === 'archived' ? '版本已完成归档' : (node?.description ?? '等待正式版本立项'),
    );
  } else {
    text($('#version-title'), '尚未建立正式版本');
    text($('#version-direction'), '向秘书说明下一阶段方向后，由主策建立版本策划案。');
  }
  renderStages(version);
  renderAgents(data.agents ?? []);
  renderTodos(data.todos ?? []);
  const work = version?.workItems ?? [];
  const bugs = version?.bugs ?? [];
  text($('#bug-count'), String(version?.openBugCount ?? 0));
  renderDataList('#work-items', work, 'work');
  renderDataList('#bugs', bugs, 'bug');
  if (selectedItem.type === 'work' || selectedItem.type === 'bug') {
    const items = selectedItem.type === 'work' ? work : bugs;
    const selected = items.find((item) => (item.id ?? item.title) === selectedItem.id);
    if (selected) showDeliveryItem(selected, selectedItem.type);
  }
  renderConversation(data.secretary);
}

function refreshAgentElapsed() {
  if (!latestData?.agents) return;
  for (const element of document.querySelectorAll('[data-agent-elapsed]')) {
    const agent = latestData.agents.find(
      (candidate) => candidate.id === element.dataset.agentElapsed,
    );
    if (!agent) continue;
    const startedAt = Date.parse(agent.startedAt);
    const synchronizedAt = Date.parse(agent.updatedAt);
    const synchronizedElapsed = Number(agent.elapsedSeconds ?? 0);
    const elapsedFromStart =
      agent.running && Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : 0;
    const elapsedFromSynchronization =
      agent.running && Number.isFinite(synchronizedAt)
        ? Math.max(0, Math.floor((Date.now() - synchronizedAt) / 1000))
        : 0;
    const elapsedSeconds = agent.running
      ? Math.max(synchronizedElapsed + elapsedFromSynchronization, elapsedFromStart)
      : synchronizedElapsed;
    element.textContent = `运行时长：${formatDuration(elapsedSeconds)}`;
  }
}

async function refresh() {
  const requestId = ++dashboardRequest;
  const versionId = selectedVersionId;
  try {
    const query = versionId ? `?${new globalThis.URLSearchParams({ version: versionId })}` : '';
    let data;
    try {
      const response = await fetch(`/api/dashboard${query}`, { cache: 'no-store' });
      if (
        !response.ok ||
        !(response.headers.get('content-type') ?? '').includes('application/json')
      ) {
        throw new Error(`状态接口 ${response.status}`);
      }
      data = await response.json();
      setSnapshotMode(false);
    } catch {
      data = await snapshotDashboard(versionId);
    }
    if (requestId !== dashboardRequest || versionId !== selectedVersionId) return;
    render(data);
  } catch (error) {
    if (requestId !== dashboardRequest || versionId !== selectedVersionId) return;
    const guard = $('#guard-state');
    guard.classList.remove('online');
    guard.lastChild.textContent = `连接失败：${error.message}`;
  }
}

function changeVersion(event) {
  selectedVersionId = event.currentTarget.value;
  selectedStage = '';
  selectedItem = { type: 'stage', id: '' };
  selectedDocument = '';
  loadedDocument = '';
  documentRequest += 1;
  void refresh();
}

$('#sidebar-version-select').addEventListener('change', changeVersion);

const workbench = $('.workbench');
const paneMinimums = { left: 190, center: 360, right: 260 };
const paneButtons = [...document.querySelectorAll('[data-pane-target]')];
function setActivePane(id) {
  paneButtons.forEach((button) =>
    button.classList.toggle('active', button.dataset.paneTarget === id),
  );
}

function paneScrollLeft(pane) {
  return (
    pane.getBoundingClientRect().left -
    workbench.getBoundingClientRect().left +
    workbench.scrollLeft
  );
}

function activatePane(id) {
  const pane = document.querySelector(`[data-pane="${id}"]`);
  if (!pane) return;
  setActivePane(id);
  workbench.scrollTo({ left: paneScrollLeft(pane), behavior: 'smooth' });
}

for (const button of paneButtons) {
  button.addEventListener('click', () => activatePane(button.dataset.paneTarget));
}

workbench.addEventListener('scroll', () => {
  const panes = [...workbench.querySelectorAll('[data-pane]')];
  const nearest = panes.reduce((best, pane) =>
    Math.abs(paneScrollLeft(pane) - workbench.scrollLeft) <
    Math.abs(paneScrollLeft(best) - workbench.scrollLeft)
      ? pane
      : best,
  );
  if (nearest) setActivePane(nearest.dataset.pane);
});

function collapsePane(side) {
  for (const candidate of ['left', 'center', 'right']) {
    workbench.classList.toggle(`collapsed-${candidate}`, candidate === side);
    document.querySelector(`[data-restore="${candidate}"]`).hidden = candidate !== side;
  }
}

document.querySelectorAll('[data-collapse]').forEach((button) => {
  button.addEventListener('click', () => collapsePane(button.dataset.collapse));
});
document.querySelectorAll('[data-restore]').forEach((button) => {
  button.addEventListener('click', () => collapsePane(''));
});

function resizePane(
  side,
  delta,
  baseLeft = $('.flow-pane').clientWidth,
  baseRight = $('.control-pane').clientWidth,
) {
  const bounds = workbench.getBoundingClientRect();
  if (bounds.width <= 0) return;
  const leftWidth = baseLeft;
  const rightWidth = baseRight;
  const centerWidth = $('.focus-pane').clientWidth;
  const fixedWidth = Math.max(0, bounds.width - leftWidth - centerWidth - rightWidth);
  if (side === 'left') {
    const max = Math.max(
      paneMinimums.left,
      bounds.width - fixedWidth - paneMinimums.center - rightWidth,
    );
    workbench.style.setProperty(
      '--left-pane',
      `${Math.min(Math.max(leftWidth + delta, paneMinimums.left), max)}px`,
    );
  } else {
    const max = Math.max(
      paneMinimums.right,
      bounds.width - fixedWidth - paneMinimums.center - leftWidth,
    );
    workbench.style.setProperty(
      '--right-pane',
      `${Math.min(Math.max(rightWidth - delta, paneMinimums.right), max)}px`,
    );
  }
}

document.querySelectorAll('[data-resize]').forEach((divider) => {
  divider.addEventListener('pointerdown', (event) => {
    if (globalThis.matchMedia('(max-width: 800px)').matches) return;
    divider.setPointerCapture(event.pointerId);
    const side = divider.dataset.resize;
    const origin = event.clientX;
    const leftWidth = $('.flow-pane').clientWidth;
    const rightWidth = $('.control-pane').clientWidth;
    const move = (moveEvent) => resizePane(side, moveEvent.clientX - origin, leftWidth, rightWidth);
    const stop = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', stop);
      divider.removeEventListener('pointercancel', stop);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', stop, { once: true });
    divider.addEventListener('pointercancel', stop, { once: true });
  });
  divider.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    resizePane(divider.dataset.resize, event.key === 'ArrowLeft' ? -24 : 24);
  });
});

function sectionId(section) {
  return section.dataset.workspaceSection;
}

function applyWorkspaceLayout() {
  const layout = workspaceLayout();
  for (const pane of document.querySelectorAll('.flow-pane, .control-pane')) {
    const sections = [...pane.querySelectorAll(':scope > [data-workspace-section]')];
    const order = layout[pane.dataset.pane]?.order ?? [];
    const ranked = [...sections].sort((left, right) => {
      const leftRank = order.indexOf(sectionId(left));
      const rightRank = order.indexOf(sectionId(right));
      return (
        (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank) -
        (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank)
      );
    });
    for (const section of ranked) pane.append(section);
    for (const section of ranked) {
      const preferences = layout[sectionId(section)] ?? {};
      section.classList.toggle('is-collapsed', Boolean(preferences.collapsed));
      if (preferences.height) section.dataset.resized = 'true';
      else section.removeAttribute('data-resized');
      if (preferences.height) {
        section.style.setProperty('--section-height', `${preferences.height}px`);
      } else {
        section.style.removeProperty('--section-height');
      }
      const toggle = section.querySelector('[data-section-toggle]');
      if (toggle) {
        const collapsed = section.classList.contains('is-collapsed');
        toggle.textContent = collapsed ? '展开' : '收起';
        toggle.setAttribute(
          'aria-label',
          `${collapsed ? '展开' : '折叠'} ${toggle.dataset.sectionLabel ?? section.querySelector('h2')?.textContent ?? '区域'}`,
        );
      }
    }
  }
}

function persistSectionLayout(
  section,
  { captureHeight = !section.classList.contains('is-collapsed') } = {},
) {
  const layout = workspaceLayout();
  const pane = section.closest('[data-pane]');
  const id = sectionId(section);
  const collapsed = section.classList.contains('is-collapsed');
  layout[id] = {
    ...(layout[id] ?? {}),
    collapsed,
    ...(!collapsed &&
      captureHeight && { height: Math.round(section.getBoundingClientRect().height) }),
  };
  if (pane) {
    layout[pane.dataset.pane] = {
      order: [...pane.querySelectorAll(':scope > [data-workspace-section]')].map(sectionId),
    };
  }
  saveWorkspaceLayout(layout);
}

document.querySelectorAll('[data-section-toggle]').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const section = toggle.closest('[data-workspace-section]');
    if (!section) return;
    const wasCollapsed = section.classList.contains('is-collapsed');
    if (!wasCollapsed) persistSectionLayout(section);
    section.classList.toggle('is-collapsed');
    // Do not turn the compact heading height into an expanded preference.
    persistSectionLayout(section, { captureHeight: false });
    applyWorkspaceLayout();
  });
});

let draggedSection = null;
document.querySelectorAll('[data-workspace-section]').forEach((section) => {
  const heading = section.querySelector('.pane-heading');
  if (!heading) return;
  heading.draggable = true;
  heading.addEventListener('dragstart', (event) => {
    draggedSection = section;
    event.dataTransfer.effectAllowed = 'move';
    section.classList.add('dragging');
  });
  heading.addEventListener('dragend', () => {
    section.classList.remove('dragging');
    if (draggedSection) persistSectionLayout(draggedSection);
    draggedSection = null;
  });
  section.addEventListener('dragover', (event) => {
    if (
      !draggedSection ||
      draggedSection === section ||
      draggedSection.parentElement !== section.parentElement
    )
      return;
    event.preventDefault();
  });
  section.addEventListener('drop', (event) => {
    if (
      !draggedSection ||
      draggedSection === section ||
      draggedSection.parentElement !== section.parentElement
    )
      return;
    event.preventDefault();
    const siblings = [...section.parentElement.children];
    const movingDown = siblings.indexOf(draggedSection) < siblings.indexOf(section);
    section.parentElement.insertBefore(draggedSection, movingDown ? section.nextSibling : section);
    persistSectionLayout(draggedSection);
  });
});

document.querySelectorAll('[data-section-resize]').forEach((resizer) => {
  resizer.addEventListener('pointerdown', (event) => {
    if (globalThis.matchMedia('(max-width: 800px)').matches) return;
    const section = resizer.closest('[data-workspace-section]');
    if (!section || section.classList.contains('is-collapsed')) return;
    resizer.setPointerCapture(event.pointerId);
    const origin = event.clientY;
    const height = section.getBoundingClientRect().height;
    const move = (moveEvent) => {
      section.dataset.resized = 'true';
      section.style.setProperty(
        '--section-height',
        `${Math.max(80, height + moveEvent.clientY - origin)}px`,
      );
    };
    const stop = () => {
      resizer.removeEventListener('pointermove', move);
      persistSectionLayout(section);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', stop, { once: true });
    resizer.addEventListener('pointercancel', stop, { once: true });
  });
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const section = resizer.closest('[data-workspace-section]');
    if (!section) return;
    section.dataset.resized = 'true';
    section.style.setProperty(
      '--section-height',
      `${Math.max(80, section.getBoundingClientRect().height + (event.key === 'ArrowUp' ? -24 : 24))}px`,
    );
    persistSectionLayout(section);
  });
});

applyWorkspaceLayout();

$('#all-documents').addEventListener('change', (event) => {
  const target = latestData?.version?.documents?.find(
    (doc) => doc.path === event.currentTarget.value,
  );
  if (target) void loadDocument(target);
});

$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const button = $('#send-button');
  const state = $('#send-state');
  const idea = input.value.trim();
  if (!idea) return;
  if (snapshotMode) {
    const queued = pendingMessages();
    queued.push({
      role: 'producer',
      content: idea,
      createdAt: new Date().toISOString(),
      pending: true,
    });
    globalThis.localStorage.setItem(pendingMessageKey, JSON.stringify(queued.slice(-20)));
    input.value = '';
    text(state, '已保存在此设备，等待远程信箱接通');
    renderConversation(latestData?.secretary);
    return;
  }
  button.disabled = true;
  text(state, '正在交给秘书');
  try {
    const response = await fetch('/api/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '发送失败');
    input.value = '';
    text(state, '秘书已收到');
    await refresh();
    setTimeout(refresh, 1200);
  } catch (error) {
    text(state, error.message);
  } finally {
    button.disabled = false;
  }
});

await refresh();
setInterval(() => {
  refreshAgentElapsed();
}, 1000);
setInterval(() => {
  if (!snapshotMode) void refresh();
}, 3000);
