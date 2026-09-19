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

let selectedStage = '';

function formatTime(value) {
  if (!value) return '尚未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function text(element, value) {
  element.textContent = value ?? '';
}

function renderTodos(version, secretary) {
  const root = $('#producer-todos');
  root.replaceChildren();
  const versionTodos = version?.producerTodos ?? [];
  const legacyTodos = (secretary?.items ?? [])
    .filter((item) => item.status === 'waiting-producer')
    .map((item) => ({
      title: item.idea,
      detail: item.producerGuidance || item.summary || '该事项正在等待你的回复。',
    }));
  const todos = [...versionTodos, ...legacyTodos];
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
    row.append(title, detail);
    root.append(row);
  }
}

function showNode(node) {
  selectedStage = node.id;
  document.querySelectorAll('.stage-node').forEach((element) => {
    element.classList.toggle('selected', element.dataset.stage === node.id);
  });
  text($('#detail-kicker'), node.producerGate ? '制作人门禁' : '流程节点');
  text($('#detail-title'), node.title);
  const meta = $('#detail-meta');
  meta.replaceChildren();
  const entries = [
    ['负责人', node.owner],
    ['状态', statusLabels[node.status] ?? node.status],
    ['开始', formatTime(node.startedAt)],
    ['完成', formatTime(node.completedAt)],
  ];
  for (const [key, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  }
  text($('#detail-summary'), node.summary || node.description);
  const button = $('#artifact-button');
  button.hidden = !node.artifact;
  button.dataset.path = node.artifact || '';
  $('#artifact-content').hidden = true;
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
    button.innerHTML = `<span class="stage-index">${String(index + 1).padStart(2, '0')}</span><span class="stage-title"></span><span class="stage-owner"></span><span class="stage-status"></span>`;
    button.querySelector('.stage-title').textContent = node.title;
    button.querySelector('.stage-owner').textContent = node.owner;
    button.querySelector('.stage-status').textContent = statusLabels[node.status] ?? node.status;
    button.addEventListener('click', () => showNode(node));
    root.append(button);
  });
  const selection =
    version.nodes.find((node) => node.id === selectedStage) ??
    version.nodes.find((node) => node.id === version.currentStage) ??
    version.nodes[0];
  showNode(selection);
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
    const time = document.createElement('small');
    time.textContent = `${message.role === 'producer' ? '制作人' : '秘书'} · ${formatTime(message.createdAt)}`;
    bubble.append(content, time);
    root.append(bubble);
  }
  if (atBottom) root.scrollTop = root.scrollHeight;
}

function render(data) {
  const version = data.version;
  const guard = $('#guard-state');
  guard.classList.toggle('online', data.secretary?.status === 'running');
  guard.lastChild.textContent =
    data.secretary?.status === 'running' ? '秘书在线，空闲时休眠' : '秘书未运行';
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
    text($('#next-action'), node?.description ?? '等待正式版本立项');
  } else {
    text($('#version-title'), '尚未建立正式版本');
    text($('#version-direction'), '向秘书说明下一阶段方向后，由主策建立版本策划案。');
  }
  renderTodos(version, data.secretary);
  renderStages(version);
  const work = version?.workItems ?? [];
  const bugs = version?.bugs ?? [];
  text($('#work-count'), String(work.length));
  text($('#bug-count'), String(version?.openBugCount ?? 0));
  renderDataList('#work-items', work, 'work');
  renderDataList('#bugs', bugs, 'bug');
  renderConversation(data.secretary);
}

async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`状态接口 ${response.status}`);
    render(await response.json());
  } catch (error) {
    const guard = $('#guard-state');
    guard.classList.remove('online');
    guard.lastChild.textContent = `连接失败：${error.message}`;
  }
}

$('#artifact-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const output = $('#artifact-content');
  button.disabled = true;
  try {
    const response = await fetch(`/api/artifact?path=${encodeURIComponent(button.dataset.path)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '无法读取文档');
    output.textContent = body.content;
    output.hidden = false;
  } catch (error) {
    output.textContent = error.message;
    output.hidden = false;
  } finally {
    button.disabled = false;
  }
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
