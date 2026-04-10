/* ReDo! — Run tab: session, chat, agent grid, SSE */

let _sseRetryDelay = 1000;
const _SSE_MAX_DELAY = 30000;
let _costData = { agents: {}, total_usd: 0 };
let _dragRunAgent = null;
let _runAgentOrder = [];

function getColor(name) {
  const a = agents.find(x => x.name === name);
  return a?.color || (name === 'GOD' ? '#fbbf24' : '#6b6b80');
}

function setStatus(text, running) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = `w-2 h-2 rounded-full ${running ? 'bg-amber-400 running' : 'bg-emerald-500'}`;
}

function setSessionUI(open) {
  sessionOpen = open;
  document.getElementById('btn-open').classList.toggle('hidden', open);
  document.getElementById('btn-close').classList.toggle('hidden', !open);
  document.getElementById('chat-input').disabled = !open;
  document.getElementById('btn-send').disabled = !open;
  document.getElementById('chat-header').innerHTML = open
    ? '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="text-sm text-white font-medium">Swarm ativo</span><span class="text-xs text-muted ml-2">Digite para enviar ao swarm, @agente para falar direto</span>'
    : '<span class="text-sm text-muted">Abra um projeto para começar</span>';
  setStatus(open ? 'Session open' : 'Ready', false);
  _updateConnectionIndicator(open ? 'connected' : 'off');
}

// ── Connection indicator ─────────────────────────────────────────────────

function _updateConnectionIndicator(state) {
  let el = document.getElementById('sse-indicator');
  if (!el) return;
  const map = { connected: ['bg-emerald-500','Conectado'], reconnecting: ['bg-amber-400 running','Reconectando…'], off: ['bg-gray-500','Desconectado'] };
  const [cls, txt] = map[state] || map.off;
  el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${cls}"></span><span class="text-[10px] text-muted">${txt}</span>`;
}

// ── SSE with exponential reconnect ───────────────────────────────────────

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/session/events`);
  _sseRetryDelay = 1000;
  _updateConnectionIndicator('connected');

  eventSource.addEventListener('orch', e => handleSSE('orch', JSON.parse(e.data)));
  eventSource.addEventListener('agent', e => handleSSE('agent', JSON.parse(e.data)));
  eventSource.addEventListener('error', e => {
    try { handleSSE('error', JSON.parse(e.data)); } catch(ex){}
    if (eventSource.readyState === EventSource.CLOSED) _reconnectSSE();
  });
  eventSource.addEventListener('summary', e => handleSSE('summary', JSON.parse(e.data)));
  eventSource.addEventListener('done', e => handleSSE('done', {}));
  eventSource.addEventListener('cost', e => handleSSE('cost', JSON.parse(e.data)));

  eventSource.onerror = () => {
    if (sessionOpen && eventSource.readyState === EventSource.CLOSED) _reconnectSSE();
  };
}

function _reconnectSSE() {
  _updateConnectionIndicator('reconnecting');
  setTimeout(() => {
    if (!sessionOpen) return;
    connectSSE();
  }, _sseRetryDelay);
  _sseRetryDelay = Math.min(_sseRetryDelay * 2, _SSE_MAX_DELAY);
}

// ── Open / Close ─────────────────────────────────────────────────────────

async function openSession() {
  const pid = document.getElementById('project-select').value;
  if (!pid) return;
  const btn = document.getElementById('btn-open');
  setLoading(btn, true);
  setStatus('Opening...', true);
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('raw-log').innerHTML = '';
  document.getElementById('run-agents').innerHTML = '';
  chatHistory = [];
  _costData = { agents: {}, total_usd: 0 };
  updateCostHeader();

  const flowId = document.getElementById('run-flow-select').value || null;
  const r = await apiPost(`${API}/session/open/${pid}`, {flow_id: flowId});
  setLoading(btn, false);
  if (!r.ok) { setStatus('Ready', false); return; }

  connectSSE();
  setSessionUI(true);
}

async function closeSession() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  await apiPost(`${API}/session/close`);
  setSessionUI(false);
  document.getElementById('run-agents').innerHTML = '';
  document.getElementById('agent-grid').innerHTML = '';
  Object.keys(agentStatus).forEach(k => delete agentStatus[k]);
  _runAgentOrder = [];
  _costData = { agents: {}, total_usd: 0 };
  updateCostHeader();
}

function onProjectChange() {
  const pid = document.getElementById('project-select').value;
  document.getElementById('btn-open').classList.toggle('hidden', !pid);
  if (sessionOpen) closeSession();
}

async function onFlowChange() {
  if (!sessionOpen) return;
  const pid = document.getElementById('project-select').value;
  if (!pid) return;
  // Close current, reopen with new flow
  await closeSession();
  await openSession();
}

// ── Send message ─────────────────────────────────────────────────────────

async function stopAgent(name) {
  const a = agents.find(x => x.name === name);
  const id = a ? a.id : name;
  await apiPost(`${API}/session/interrupt/${encodeURIComponent(id)}`);
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !sessionOpen) return;
  input.value = '';
  _selectedAgent = null;
  renderAgentBoxes();
  document.querySelectorAll('#agent-grid > div').forEach(d => { d.style.boxShadow = ''; d.style.borderColor = ''; });

  const m = text.match(/^@(\w+)\s+(.*)/s);
  const agent_id = m ? m[1] : (chatTarget && chatTarget !== '__log__' ? chatTarget : null);
  const msg = m ? m[2] : text;

  addChatBubble('user', msg, agent_id ? `→ ${agent_id}` : '→ swarm');
  setStatus('Working...', true);

  await apiPost(`${API}/session/message`, { text: msg, agent_id });
}

// ── Agent grid (Swarm view) ───────────────────────────────────────────────

function ensureGridPanel(name) {
  let panel = document.getElementById('grid-' + name);
  if (panel) return panel;
  const grid = document.getElementById('agent-grid');
  const c = getColor(name);
  const div = document.createElement('div');
  div.id = 'grid-' + name;
  div.className = 'flex flex-col rounded-xl border border-border bg-card overflow-hidden min-h-0';
  div.style.borderTopColor = c; div.style.borderTopWidth = '2px';
  div.innerHTML = `
    <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50 flex-shrink-0">
      <span class="w-2 h-2 rounded-full" style="background:${c}" id="grid-dot-${escHtml(name)}"></span>
      <span class="text-xs font-medium text-white">${escHtml(name)}</span>
      <span class="text-[10px] text-muted ml-auto" id="grid-status-${escHtml(name)}">Pronto</span>
      <button class="hidden text-[10px] text-red-400 hover:text-red-300 ml-1 px-1 rounded hover:bg-red-500/10" id="grid-stop-${escHtml(name)}" onclick="event.stopPropagation();stopAgent('${escHtml(name)}')" aria-label="Parar ${escHtml(name)}">⏹</button>
    </div>
    <div class="flex-1 overflow-y-auto p-3 font-mono text-xs text-gray-400 whitespace-pre-wrap" id="grid-content-${escHtml(name)}"></div>`;
  grid.appendChild(div);
  return div;
}

function updateGridPanel(name, status, text) {
  ensureGridPanel(name);
  const s = document.getElementById('grid-status-' + name);
  const d = document.getElementById('grid-dot-' + name);
  const stop = document.getElementById('grid-stop-' + name);
  if (s) s.textContent = status;
  if (d) { d.style.background = status === '💀 Crashed' ? '#ef4444' : getColor(name); d.className = `w-2 h-2 rounded-full ${status === 'Processando...' ? 'running' : ''}`; }
  if (stop) stop.classList.toggle('hidden', status !== 'Processando...');
  if (text !== undefined) {
    const c = document.getElementById('grid-content-' + name);
    if (c) { c.textContent = text; if (c.textContent.length > 5000) c.textContent = '...\n' + c.textContent.slice(-4000); c.scrollTop = c.scrollHeight; }
  }
}

function appendGridPanel(name, text) {
  ensureGridPanel(name);
  const c = document.getElementById('grid-content-' + name);
  if (c) { c.textContent += text; if (c.textContent.length > 5000) c.textContent = '...\n' + c.textContent.slice(-4000); c.scrollTop = c.scrollHeight; }
}

function showView(view) {
  document.getElementById('agent-grid').classList.toggle('hidden', view !== 'grid');
  document.getElementById('chat-messages').classList.toggle('hidden', view !== 'chat');
  document.getElementById('raw-log').classList.toggle('hidden', view !== 'log');
}

// ── Markdown rendering ───────────────────────────────────────────────────

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escHtml(text);
  try {
    const html = marked.parse(text, { breaks: true });
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  } catch { return escHtml(text); }
}

function copyBubbleText(btn) {
  const bubble = btn.closest('.chat-bubble');
  const src = bubble?.dataset.raw || bubble?.textContent || '';
  navigator.clipboard.writeText(src).then(() => {
    btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1500);
  });
}

// ── Chat rendering ───────────────────────────────────────────────────────

function addChatBubble(type, text, label) {
  chatHistory.push({type, text, label});
  if (shouldShow({type, text, label})) appendBubble(type, text, label);
}

function shouldShow(msg) {
  if (!chatTarget || chatTarget === '__log__') return true;
  if (msg.type === 'agent') return msg.label === chatTarget;
  if (msg.type === 'user') return !msg.label || msg.label === `→ ${chatTarget}`;
  return msg.type === 'summary' || msg.type === 'system';
}

function renderChat() {
  const el = document.getElementById('chat-messages');
  el.innerHTML = '';
  chatHistory.filter(shouldShow).forEach(m => appendBubble(m.type, m.text, m.label));
  const scroll = document.getElementById('chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function appendBubble(type, text, label) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'log-line';

  if (type === 'user') {
    div.innerHTML = `<div class="flex justify-end"><div class="max-w-[75%] bg-accent/10 border border-accent/20 rounded-xl rounded-tr-sm px-4 py-2.5">
      <div class="text-[10px] text-accent/60 mb-1">${ts()} ${escHtml(label||'')}</div>
      <div class="text-sm text-white whitespace-pre-wrap">${escHtml(text)}</div>
    </div></div>`;
  } else if (type === 'agent') {
    const c = getColor(label);
    const rendered = renderMarkdown(text);
    div.innerHTML = `<div class="flex justify-start"><div class="chat-bubble max-w-[75%] bg-card border border-border rounded-xl rounded-tl-sm px-4 py-2.5 relative group" data-raw="${escHtml(text)}">
      <div class="flex items-center justify-between text-[10px] mb-1">
        <span style="color:${c}">${ts()} ${escHtml(label||'')}</span>
        <button onclick="copyBubbleText(this)" class="opacity-0 group-hover:opacity-100 text-muted hover:text-white transition text-xs ml-2" aria-label="Copiar">📋</button>
      </div>
      <div class="text-sm text-gray-300 chat-md">${rendered}</div>
    </div></div>`;
  } else if (type === 'summary') {
    div.innerHTML = `<div class="flex justify-center"><div class="bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-2.5 max-w-[80%]">
      <div class="text-[10px] text-emerald-400 mb-1">${ts()} ✓ Resumo</div>
      <div class="text-sm text-emerald-300">${escHtml(text)}</div>
    </div></div>`;
  } else if (type === 'system') {
    div.innerHTML = `<div class="flex justify-center"><div class="text-[10px] text-muted bg-surface/50 px-3 py-1 rounded-full">${escHtml(text)}</div></div>`;
  }

  el.appendChild(div);

  // highlight code blocks if hljs available
  if (type === 'agent' && typeof hljs !== 'undefined') {
    div.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  }

  const scroll = document.getElementById('chat-scroll');
  if (isNearBottom(scroll)) scroll.scrollTop = scroll.scrollHeight;
}

// ── Agent boxes ──────────────────────────────────────────────────────────

function updateAgentBox(name, status, text) {
  const prev = agentStatus[name];
  agentStatus[name] = { status, text: (text||'').slice(0,60), msgCount: prev?.msgCount || 0 };
  renderAgentBoxes();
}

let _selectedAgent = null;

function updateMentionHighlight() {
  const text = document.getElementById('chat-input').value;
  const m = text.match(/^@(\w+)/);
  let name = null;
  if (m) {
    const id = m[1];
    const a = agents.find(x => x.id === id || x.name === id);
    name = a ? a.name : null;
  }
  if (name !== _selectedAgent) {
    _selectedAgent = name;
    renderAgentBoxes();
    document.querySelectorAll('#agent-grid > div').forEach(d => { d.style.boxShadow = ''; d.style.borderColor = ''; });
    if (name) {
      const panel = document.getElementById('grid-' + name);
      if (panel) {
        const c = getColor(name);
        panel.style.boxShadow = `0 0 12px ${c}44`;
        panel.style.borderColor = c;
      }
    }
  }
}

function insertAgentMention(name) {
  const input = document.getElementById('chat-input');
  const a = agents.find(x => x.name === name);
  const id = a ? a.id : name;
  const mention = `@${id} `;
  input.value = input.value.replace(/^@\w+\s*/, '');
  input.value = mention + input.value;
  input.focus();
  updateMentionHighlight();
}

function renderAgentBoxes() {
  const el = document.getElementById('run-agents');
  // Sync order: add new agents, remove stale ones
  const names = Object.keys(agentStatus).filter(n => n !== 'GOD');
  names.forEach(n => { if (!_runAgentOrder.includes(n)) _runAgentOrder.push(n); });
  _runAgentOrder = _runAgentOrder.filter(n => names.includes(n));

  el.innerHTML = _runAgentOrder.map(name => {
    const s = agentStatus[name];
    const c = getColor(name);
    const isSel = _selectedAgent === name;
    const isActive = s.status === 'working';
    const count = s.msgCount || 0;
    const badge = count ? `<span class="ml-auto text-[10px] bg-accent/20 text-accent px-1.5 rounded-full">${count}</span>` : '';
    const costEntry = Object.values(_costData.agents || {}).find(a => a.name === name);
    const costHtml = costEntry ? `<div class="text-[10px] text-emerald-400/70">$${costEntry.cost_usd.toFixed(4)}</div>` : '';
    return `<div onclick="insertAgentMention('${escHtml(name)}')" oncontextmenu="event.preventDefault();showCliMenu(event,'${escHtml(name)}')"
      draggable="true" data-run-agent="${escHtml(name)}"
      ondragstart="_dragRunAgent=this.dataset.runAgent;this.classList.add('dragging');event.dataTransfer.setData('text/plain','')"
      ondragend="_dragRunAgent=null;this.classList.remove('dragging')"
      ondragover="event.preventDefault();this.classList.add('drag-over')"
      ondragleave="this.classList.remove('drag-over')"
      ondrop="event.preventDefault();this.classList.remove('drag-over');_dropRunAgent(this.dataset.runAgent)"
      class="agent-box flex flex-col gap-1 px-3 py-2.5 rounded-lg border cursor-pointer transition ${isSel ? 'border-accent/50 bg-accent/5 shadow-[0_0_8px_rgba(124,92,252,0.3)]' : 'border-border bg-surface hover:border-accent/20'}">
      <div class="flex items-center gap-2">
        <span class="text-muted/40 text-xs select-none cursor-grab">⠿</span>
        <span class="w-2 h-2 rounded-full ${isActive?'running':''}" style="background:${c}"></span>
        <span class="text-xs font-medium text-white">${escHtml(name)}</span>
        ${badge}
      </div>
      <div class="text-[10px] text-muted truncate">${escHtml(s.text||'Pronto')}</div>
      ${costHtml}
    </div>`;
  }).join('');
}

// ── CLI context menu ──────────────────────────────────────────────────────

function showCliMenu(ev, name) {
  let menu = document.getElementById('cli-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'cli-context-menu';
    menu.className = 'fixed z-50 bg-card border border-border rounded-xl shadow-lg py-1 text-xs min-w-[140px]';
    document.body.appendChild(menu);
    document.addEventListener('click', () => menu.classList.add('hidden'));
  }
  const a = agents.find(x => x.name === name);
  const currentCli = a?.cli_type || 'kiro';
  const options = [{id:'kiro', label:'Kiro CLI'}, {id:'gemini', label:'Gemini CLI'}];
  menu.innerHTML = `<div class="px-3 py-1.5 text-muted text-[10px] uppercase">CLI para ${escHtml(name)}</div>` +
    options.map(o => `<div onclick="event.stopPropagation();setAgentCli('${a?.id||name}','${o.id}')" class="px-3 py-1.5 cursor-pointer hover:bg-accent/10 transition flex items-center gap-2 ${currentCli===o.id?'text-accent':'text-gray-400'}">
      ${currentCli===o.id?'●':'○'} ${o.label}
    </div>`).join('');
  menu.style.left = ev.clientX + 'px';
  menu.style.top = ev.clientY + 'px';
  menu.classList.remove('hidden');
}

async function setAgentCli(agentId, cliType) {
  document.getElementById('cli-context-menu')?.classList.add('hidden');
  const a = agents.find(x => x.id === agentId);
  if (!a) return;
  a.cli_type = cliType;
  const r = await apiPut(`${API}/agents/${agentId}`, {id: a.id, name: a.name, persona: a.persona, color: a.color, model: a.model, mcps: a.mcps || {}, cli_type: cliType});
  if (!r.ok) return;
  await loadAgents();
  if (sessionOpen) {
    await apiPost(`${API}/session/restart/${agentId}`);
  }
}

function _dropRunAgent(targetName) {
  if (!_dragRunAgent || _dragRunAgent === targetName) return;
  const from = _runAgentOrder.indexOf(_dragRunAgent);
  const to = _runAgentOrder.indexOf(targetName);
  if (from < 0 || to < 0) return;
  _runAgentOrder.splice(from, 1);
  _runAgentOrder.splice(to, 0, _dragRunAgent);
  renderAgentBoxes();
}

function selectChatTarget(target) {
  chatTarget = target;
  renderAgentBoxes();
  document.querySelectorAll('.agent-box').forEach(b => { b.classList.remove('border-accent/50','bg-accent/5'); b.classList.add('border-border','bg-surface'); });

  if (target === '__log__') {
    showView('log');
    document.getElementById('chat-header').innerHTML = '<span class="text-sm text-muted">📋 Log bruto</span>';
    document.getElementById('chat-input').placeholder = 'Mensagem para o swarm...';
    document.getElementById('box-__log__').classList.add('border-accent/50','bg-accent/5');
  } else if (target) {
    showView('chat');
    const c = getColor(target);
    document.getElementById('chat-header').innerHTML = `<span class="w-2 h-2 rounded-full" style="background:${c}"></span><span class="text-sm font-medium text-white">${escHtml(target)}</span><span class="text-xs text-muted ml-2">Chat direto com este agente</span>`;
    document.getElementById('chat-input').placeholder = `Mensagem para ${target}...`;
  } else {
    showView('grid');
    document.getElementById('chat-header').innerHTML = sessionOpen
      ? '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="text-sm text-white font-medium">Swarm</span><span class="text-xs text-muted ml-2">Visão geral de todos os agentes</span>'
      : '<span class="text-sm text-muted">Abra um projeto para começar</span>';
    document.getElementById('chat-input').placeholder = 'Mensagem para o swarm... (@agente para falar direto)';
    document.getElementById('box-swarm').classList.add('border-accent/50','bg-accent/5');
    document.getElementById('box-swarm').classList.remove('border-border','bg-surface');
  }
}

// ── Raw log ──────────────────────────────────────────────────────────────

function appendLog(html) {
  const log = document.getElementById('raw-log');
  const div = document.createElement('div');
  div.className = 'log-line'; div.innerHTML = html; log.appendChild(div);
  if (chatTarget === '__log__') {
    const scroll = document.getElementById('chat-scroll');
    if (isNearBottom(scroll)) scroll.scrollTop = scroll.scrollHeight;
  }
}

// ── SSE handler ──────────────────────────────────────────────────────────

function handleSSE(type, data) {
  const t = ts();
  if (type === 'orch') {
    appendLog(`<span class="text-muted">${t}</span> <span class="text-amber-400 font-medium">[ORCH]</span> ${escHtml(data.msg)}`);
    const hm = data.msg.match(/^→ (.+?): (.+)/);
    if (hm) addChatBubble('system', `→ Handoff para ${hm[1]}: ${hm[2]}`);
    const rm = data.msg.match(/^Round (\d+): (.+)/);
    if (rm) updateAgentBox(rm[2], 'working', 'Processando...');
  } else if (type === 'agent') {
    const c = data.name === 'GOD' ? '#fbbf24' : getColor(data.name);
    appendLog(`<span class="text-muted">${t}</span> <span style="color:${c}" class="font-medium">[${escHtml(data.name)}]</span> <span class="text-muted">${escHtml(data.event)}</span>`);
    if (data.text) {
      for (const l of data.text.split('\n').slice(0,15))
        appendLog(`<span class="text-muted ml-4">│</span> <span class="text-gray-400">${escHtml(l)}</span>`);
    }
    if (data.name !== 'GOD') {
      if (data.event.includes('ready')) {
        updateAgentBox(data.name, 'ready', 'Pronto');
        updateGridPanel(data.name, 'Pronto');
      }
      if (data.event.includes('← prompt') || data.event.includes('← direct')) {
        updateAgentBox(data.name, 'working', 'Processando...');
        updateGridPanel(data.name, 'Processando...', '');
      }
      if (data.event === '⏳ streaming') {
        updateAgentBox(data.name, 'working', (data.text||'').slice(0,60));
        appendGridPanel(data.name, data.text||'');
        return;
      }
      if (data.event.includes('→ response')) {
        if (agentStatus[data.name]) agentStatus[data.name].msgCount = (agentStatus[data.name].msgCount || 0) + 1;
        updateAgentBox(data.name, 'ready', (data.text||'').slice(0,60));
        updateGridPanel(data.name, 'Pronto');
        addChatBubble('agent', data.text||'', data.name);
      }
    }
  } else if (type === 'summary') {
    addChatBubble('summary', data.text);
    // Show done floating card
    const parts = (data.text || '').match(/^(.+?):\s*(.*)/s);
    const card = document.getElementById('done-card');
    document.getElementById('done-card-agent').textContent = parts ? parts[1] : 'Agente';
    document.getElementById('done-card-msg').textContent = parts ? parts[2] : data.text;
    card.classList.remove('hidden');
    setStatus('Session open');
  } else if (type === 'error') {
    appendLog(`<span class="text-muted">${t}</span> <span class="text-red-400">[ERROR]</span> ${escHtml(data.msg)}`);
  } else if (type === 'done') {
    setStatus('Session open');
  } else if (type === 'cost') {
    _costData = data;
    renderAgentBoxes();
    updateCostHeader();
  }
}

// ── Cost header ──────────────────────────────────────────────────────────

function updateCostHeader() {
  let el = document.getElementById('cost-total');
  if (!el) {
    const container = document.querySelector('header .flex.items-center.gap-4');
    if (!container) return;
    el = document.createElement('div');
    el.id = 'cost-total';
    el.className = 'flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full';
    container.insertBefore(el, container.querySelector('#sse-indicator'));
  }
  const total = _costData.total_usd || 0;
  el.textContent = total > 0 ? `💰 $${total.toFixed(4)}` : '';
}

// ── Settings ─────────────────────────────────────────────────────────────

async function loadSettings() {
  const r = await apiGet(`${API}/settings`);
  if (r.ok) {
    const val = r.data.data_collection !== false;
    const s = document.getElementById('settings-data-collection');
    if (s) s.checked = val;
  }
}

async function toggleDataCollection(val) {
  await apiPut(`${API}/settings`, {key:'data_collection', value:val});
  const s = document.getElementById('settings-data-collection');
  if (s) s.checked = val;
}
