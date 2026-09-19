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
let loadedDocument = '';
let latestData = null;
let dashboardRequest = 0;
let documentRequest = 0;

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
  const select = $('#version-select');
  const versions = data.versions ?? [];
  const desired = selectedVersionId || data.version?.id || '';
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
  selectedVersionId = select.value || desired;
  select.disabled = versions.length < 2;
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
  const selection =
    version.nodes.find((node) => node.id === selectedStage) ??
    version.nodes.find((node) => node.id === version.currentStage) ??
    version.nodes[0];
  showNode(selection, version);
}

function renderDataList(selector, items, kind) {
  const root = $(selector);
  root.replaceChildren();
  if (!items.length) {
    root.append(empty());
    return;
  }
  for (const item of items) {
    const row = document.createElement('article');
    row.className = `data-row ${kind}`;
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
    root.append(row);
  }
}

function showAgent(agent) {
  text($('#agent-detail-type'), `${agent.role} · ${agent.type}`);
  text($('#agent-detail-title'), agent.objective || agent.role);
  const meta = $('#agent-detail-meta');
  meta.replaceChildren();
  for (const [key, value] of [
    ['状态', agentStatusLabels[agent.status] ?? agent.status],
    ['模型', agent.model],
    ['当前阶段', agent.phase],
    ['进程', agent.pid ? String(agent.pid) : '无执行进程'],
    ['运行时长', formatDuration(agent.elapsedSeconds)],
    ['最近更新', formatTime(agent.updatedAt)],
    ['计划重试', formatTime(agent.retryAt)],
    ['运行目录', agent.runDirectory || '无'],
  ]) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = key;
    dd.textContent = value;
    meta.append(dt, dd);
  }
  text($('#agent-detail-objective'), agent.context.direction || agent.objective);
  const context = $('#agent-context');
  context.replaceChildren();
  const groups = [
    ['验收标准', agent.context.acceptanceCriteria],
    ['非目标', agent.context.nonGoals],
    [
      '任务清单',
      agent.context.tasks.map(
        (task) => `${task.title} · ${task.status}${task.objective ? ` · ${task.objective}` : ''}`,
      ),
    ],
  ];
  for (const [title, values] of groups) {
    if (!values.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = value;
      list.append(item);
    }
    context.append(heading, list);
  }
  text(
    $('#agent-output'),
    [agent.error ? `错误：${agent.error}` : '', ...agent.recentOutput].filter(Boolean).join('\n') ||
      '当前没有运行输出。',
  );
  $('#agent-dialog').showModal();
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
    button.addEventListener('click', () => showAgent(agent));
    root.append(button);
  }
}

async function actOnTodo(todo, action, note, button) {
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
  const messages = secretary?.recentMessages ?? [];
  if (!messages.length) root.append(empty());
  for (const message of messages) {
    const bubble = document.createElement('article');
    bubble.className = `message ${message.role}`;
    const content = document.createElement('div');
    content.textContent = message.content;
    const time = document.createElement('time');
    time.textContent = `${message.role === 'producer' ? '制作人' : '秘书'} · ${formatTime(message.createdAt)}`;
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
  guard.classList.toggle('online', data.secretary?.status === 'running');
  guard.lastChild.textContent =
    data.secretary?.status === 'running' ? '秘书在线，空闲时休眠' : '秘书未运行';
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
  renderConversation(data.secretary);
}

async function refresh() {
  const requestId = ++dashboardRequest;
  const versionId = selectedVersionId;
  try {
    const query = versionId ? `?${new globalThis.URLSearchParams({ version: versionId })}` : '';
    const response = await fetch(`/api/dashboard${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`状态接口 ${response.status}`);
    const data = await response.json();
    if (requestId !== dashboardRequest || versionId !== selectedVersionId) return;
    render(data);
  } catch (error) {
    if (requestId !== dashboardRequest || versionId !== selectedVersionId) return;
    const guard = $('#guard-state');
    guard.classList.remove('online');
    guard.lastChild.textContent = `连接失败：${error.message}`;
  }
}

$('#version-select').addEventListener('change', (event) => {
  selectedVersionId = event.currentTarget.value;
  selectedStage = '';
  selectedDocument = '';
  loadedDocument = '';
  documentRequest += 1;
  void refresh();
});

const workbench = $('.workbench');
const paneButtons = [...document.querySelectorAll('[data-pane-target]')];
function setActivePane(id) {
  paneButtons.forEach((button) =>
    button.classList.toggle('active', button.dataset.paneTarget === id),
  );
}

for (const button of paneButtons) {
  button.addEventListener('click', () => {
    const pane = document.querySelector(`[data-pane="${button.dataset.paneTarget}"]`);
    if (!pane) return;
    setActivePane(button.dataset.paneTarget);
    workbench.scrollTo({ left: pane.offsetLeft - workbench.offsetLeft, behavior: 'smooth' });
  });
}

workbench.addEventListener('scroll', () => {
  const panes = [...workbench.querySelectorAll('[data-pane]')];
  const nearest = panes.reduce((best, pane) =>
    Math.abs(pane.offsetLeft - workbench.offsetLeft - workbench.scrollLeft) <
    Math.abs(best.offsetLeft - workbench.offsetLeft - workbench.scrollLeft)
      ? pane
      : best,
  );
  if (nearest) setActivePane(nearest.dataset.pane);
});

$('#all-documents').addEventListener('change', (event) => {
  const target = latestData?.version?.documents?.find(
    (doc) => doc.path === event.currentTarget.value,
  );
  if (target) void loadDocument(target);
});

document.querySelectorAll('[data-delivery-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    document
      .querySelectorAll('[data-delivery-tab]')
      .forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    $('#work-items').hidden = button.dataset.deliveryTab !== 'work';
    $('#bugs').hidden = button.dataset.deliveryTab !== 'bugs';
  });
});

$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const button = $('#send-button');
  const state = $('#send-state');
  const idea = input.value.trim();
  if (!idea) return;
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
setInterval(refresh, 3000);
