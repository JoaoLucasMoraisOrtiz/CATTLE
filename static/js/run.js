/* ReDo! — Run tab: session, chat, agent grid, SSE */

let _sseRetryDelay = 1000;
const _SSE_MAX_DELAY = 30000;
let sessions = {}; // project_id -> { projectId, flowId, sessionOpen, chatHistory, agentStatus, runAgentOrder, costData, eventSource, chatTarget }
let activeProjectId = null;

function getActiveSession() {
  return sessions[activeProjectId];
}

function getColor(name) {
  const a = agents.find(x => x.name === name);
  return a?.color || (name === 'GOD' ? '#fbbf24' : '#6b6b80');
}

function setStatus(text, running) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = `w-2 h-2 rounded-full ${running ? 'bg-amber-400 running' : 'bg-emerald-500'}`;
}

function setSessionUI(open) {
  const s = getActiveSession();
  if (s) s.sessionOpen = open;

  const pid = document.getElementById('project-select').value;
  document.getElementById('btn-open').classList.toggle('hidden', open || !pid);
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
  const map = { connected: ['bg-emerald-500', 'Conectado'], reconnecting: ['bg-amber-400 running', 'Reconectando…'], off: ['bg-gray-500', 'Desconectado'] };
  const [cls, txt] = map[state] || map.off;
  el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${cls}"></span><span class="text-[10px] text-muted">${txt}</span>`;
}

// ── SSE with exponential reconnect ───────────────────────────────────────

function connectSSE(projectId) {
  const s = sessions[projectId];
  if (!s) return;
  if (s.eventSource) s.eventSource.close();

  s.eventSource = new EventSource(`${API}/session/events/${projectId}`);
  _sseRetryDelay = 1000;
  if (projectId === activeProjectId) _updateConnectionIndicator('connected');

  s.eventSource.addEventListener('orch', e => handleSSE(projectId, 'orch', JSON.parse(e.data)));
  s.eventSource.addEventListener('agent', e => handleSSE(projectId, 'agent', JSON.parse(e.data)));
  s.eventSource.addEventListener('error', e => {
    try { handleSSE(projectId, 'error', JSON.parse(e.data)); } catch (ex) { }
    if (s.eventSource.readyState === EventSource.CLOSED) _reconnectSSE(projectId);
  });
  s.eventSource.addEventListener('summary', e => handleSSE(projectId, 'summary', JSON.parse(e.data)));
  s.eventSource.addEventListener('done', e => handleSSE(projectId, 'done', {}));
  s.eventSource.addEventListener('cost', e => handleSSE(projectId, 'cost', JSON.parse(e.data)));

  s.eventSource.onerror = () => {
    if (s.sessionOpen && s.eventSource.readyState === EventSource.CLOSED) _reconnectSSE(projectId);
  };
}

function _reconnectSSE(projectId) {
  const s = sessions[projectId];
  if (!s) return;
  if (projectId === activeProjectId) _updateConnectionIndicator('reconnecting');
  setTimeout(() => {
    if (!s.sessionOpen) return;
    connectSSE(projectId);
  }, _sseRetryDelay);
  _sseRetryDelay = Math.min(_sseRetryDelay * 2, _SSE_MAX_DELAY);
}

// ── Open / Close ─────────────────────────────────────────────────────────

async function openSession() {
  const pid = activeProjectId;
  if (!pid) return;
  const s = sessions[pid];
  if (!s) return;

  const btn = document.getElementById('btn-open');
  setLoading(btn, true);
  setStatus('Opening...', true);

  s.chatHistory = [];
  s.agentStatus = {};
  s.runAgentOrder = [];
  s.costData = { agents: {}, total_usd: 0 };

  if (pid === activeProjectId) {
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('raw-log').innerHTML = '';
    document.getElementById('run-agents').innerHTML = '';
    document.getElementById('agent-grid').innerHTML = '';
    updateCostHeader();
  }

  const flowId = document.getElementById('run-flow-select').value || null;
  s.flowId = flowId;

  const r = await apiPost(`${API}/session/open/${pid}`, { flow_id: flowId });
  setLoading(btn, false);
  if (!r.ok) { setStatus('Ready', false); return; }

  connectSSE(pid);
  setSessionUI(true);
}

async function closeSession() {
  const pid = activeProjectId;
  if (!pid) return;
  const s = sessions[pid];
  if (!s) return;

  if (s.eventSource) { s.eventSource.close(); s.eventSource = null; }
  await apiPost(`${API}/session/close/${pid}`);

  s.sessionOpen = false;
  s.agentStatus = {};
  s.runAgentOrder = [];
  s.costData = { agents: {}, total_usd: 0 };

  if (pid === activeProjectId) {
    setSessionUI(false);
    document.getElementById('run-agents').innerHTML = '';
    document.getElementById('agent-grid').innerHTML = '';
    updateCostHeader();
  }
}

function onProjectChange() {
  const pid = document.getElementById('project-select').value;
  if (!pid) return;

  const tab = State.get('runTabs').find(t => t.id === activeProjectId);
  if (!tab) return;

  // If selecting a project that already has a session in another tab, switch to it
  if (sessions[pid] && activeProjectId !== pid) {
    const oldId = activeProjectId;
    switchRunTab(pid);
    if (oldId === 'new') removeRunTab('new');
    return;
  }

  // Rename current tab if it was 'new' or if it changed its project
  if (activeProjectId !== pid) {
    const oldId = activeProjectId;
    const proj = projectsList.find(p => p.id === pid);
    
    tab.id = pid;
    tab.projectId = pid;
    tab.name = proj ? proj.name : pid;

    // Move session data
    sessions[pid] = sessions[oldId];
    delete sessions[oldId];
    
    activeProjectId = pid;
    State.set('activeTabId', pid);
    State.set('runTabs', [...State.get('runTabs')]); // Trigger UI update for tab bar
  }

  const s = sessions[pid];
  if (s) {
    s.projectId = pid;
    setSessionUI(s.sessionOpen);
    renderRunUI(); // Refresh the whole view to sync labels and fields
  }
}

async function onFlowChange() {
  const s = getActiveSession();
  if (!s || !s.sessionOpen) return;
  const pid = activeProjectId;
  if (!pid) return;
  // Close current, reopen with new flow
  await closeSession();
  await openSession();
}

// ── Send message ─────────────────────────────────────────────────────────

async function stopAgent(name) {
  const a = agents.find(x => x.name === name);
  const id = a ? a.id : name;
  await apiPost(`${API}/session/interrupt/${encodeURIComponent(id)}?project_id=${activeProjectId}`);
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  const s = getActiveSession();
  if (!text || !s || !s.sessionOpen) return;
  input.value = '';

  s.selectedAgent = null;
  if (activeProjectId === s.projectId) {
    renderAgentBoxes();
    document.querySelectorAll('#agent-grid > div').forEach(d => { d.style.boxShadow = ''; d.style.borderColor = ''; });
  }

  const m = text.match(/^@(\w+)\s+(.*)/s);
  const agent_id = m ? m[1] : (s.chatTarget && s.chatTarget !== '__log__' ? s.chatTarget : null);
  const msg = m ? m[2] : text;

  addChatBubble(activeProjectId, 'user', msg, agent_id ? `→ ${agent_id}` : '→ swarm');
  setStatus('Working...', true);

  await apiPost(`${API}/session/message`, { project_id: activeProjectId, text: msg, agent_id });
}

// ── Agent grid (Swarm view) ───────────────────────────────────────────────

function ensureGridPanel(projectId, name) {
  const s = sessions[projectId];
  if (!s) return;

  if (projectId === activeProjectId) {
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
}

function updateGridPanel(projectId, name, status, text) {
  const s = sessions[projectId];
  if (!s) return;

  if (projectId === activeProjectId) {
    ensureGridPanel(projectId, name);
    const st = document.getElementById('grid-status-' + name);
    const d = document.getElementById('grid-dot-' + name);
    const stop = document.getElementById('grid-stop-' + name);
    if (st) st.textContent = status;
    if (d) { d.style.background = status === '💀 Crashed' ? '#ef4444' : getColor(name); d.className = `w-2 h-2 rounded-full ${status === 'Processando...' ? 'running' : ''}`; }
    if (stop) stop.classList.toggle('hidden', status !== 'Processando...');
    if (text !== undefined) {
      const c = document.getElementById('grid-content-' + name);
      if (c) { c.textContent = text; if (c.textContent.length > 5000) c.textContent = '...\n' + c.textContent.slice(-4000); c.scrollTop = c.scrollHeight; }
    }
  }
}

function appendGridPanel(projectId, name, text) {
  const s = sessions[projectId];
  if (!s) return;

  if (projectId === activeProjectId) {
    ensureGridPanel(projectId, name);
    const c = document.getElementById('grid-content-' + name);
    if (c) { c.textContent += text; if (c.textContent.length > 5000) c.textContent = '...\n' + c.textContent.slice(-4000); c.scrollTop = c.scrollHeight; }
  }
}

function replaceGridPanel(projectId, name, text) {
  const s = sessions[projectId];
  if (!s) return;
  if (projectId !== activeProjectId) return;
  ensureGridPanel(projectId, name);
  const c = document.getElementById('grid-content-' + name);
  if (c) { c.textContent = text; c.scrollTop = c.scrollHeight; }
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

function addChatBubble(projectId, type, text, label) {
  const s = sessions[projectId];
  if (!s) return;
  s.chatHistory.push({ type, text, label });
  if (projectId === activeProjectId) {
    if (shouldShow(projectId, { type, text, label })) appendBubble(type, text, label);
  }
}

function shouldShow(projectId, msg) {
  const s = sessions[projectId];
  if (!s) return true;
  const target = s.chatTarget;
  if (!target || target === '__log__') return true;
  if (msg.type === 'agent') return msg.label === target;
  if (msg.type === 'user') return !msg.label || msg.label === `→ ${target}`;
  return msg.type === 'summary' || msg.type === 'system';
}

function renderChat() {
  const s = getActiveSession();
  if (!s) return;
  const el = document.getElementById('chat-messages');
  el.innerHTML = '';
  s.chatHistory.filter(m => shouldShow(activeProjectId, m)).forEach(m => appendBubble(m.type, m.text, m.label));
  const scroll = document.getElementById('chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function appendBubble(type, text, label) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'log-line';

  if (type === 'user') {
    div.innerHTML = `<div class="flex justify-end"><div class="max-w-[75%] bg-accent/10 border border-accent/20 rounded-xl rounded-tr-sm px-4 py-2.5">
      <div class="text-[10px] text-accent/60 mb-1">${ts()} ${escHtml(label || '')}</div>
      <div class="text-sm text-white whitespace-pre-wrap">${escHtml(text)}</div>
    </div></div>`;
  } else if (type === 'agent') {
    const c = getColor(label);
    const rendered = renderMarkdown(text);
    div.innerHTML = `<div class="flex justify-start"><div class="chat-bubble max-w-[75%] bg-card border border-border rounded-xl rounded-tl-sm px-4 py-2.5 relative group" data-raw="${escHtml(text)}">
      <div class="flex items-center justify-between text-[10px] mb-1">
        <span style="color:${c}">${ts()} ${escHtml(label || '')}</span>
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

function updateAgentBox(projectId, name, status, text) {
  const s = sessions[projectId];
  if (!s) return;
  const prev = s.agentStatus[name];
  s.agentStatus[name] = { status, text: (text || '').slice(0, 60), msgCount: prev?.msgCount || 0 };
  if (projectId === activeProjectId) {
    renderAgentBoxes();
  }
}

function updateMentionHighlight() {
  const s = getActiveSession();
  if (!s) return;

  const text = document.getElementById('chat-input').value;
  const m = text.match(/^@(\w+)/);
  let name = null;
  if (m) {
    const id = m[1];
    const a = agents.find(x => x.id === id || x.name === id);
    name = a ? a.name : null;
  }
  if (name !== s.selectedAgent) {
    s.selectedAgent = name;
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
  const s = getActiveSession();
  if (!s) return;

  const el = document.getElementById('run-agents');
  const names = Object.keys(s.agentStatus).filter(n => n !== 'GOD');
  names.forEach(n => { if (!s.runAgentOrder.includes(n)) s.runAgentOrder.push(n); });
  s.runAgentOrder = s.runAgentOrder.filter(n => names.includes(n));

  el.innerHTML = s.runAgentOrder.map(name => {
    const st = s.agentStatus[name];
    const c = getColor(name);
    const isSel = s.selectedAgent === name;
    const isActive = st.status === 'working';
    const count = st.msgCount || 0;
    const badge = count ? `<span class="ml-auto text-[10px] bg-accent/20 text-accent px-1.5 rounded-full">${count}</span>` : '';
    const costEntry = Object.values(s.costData.agents || {}).find(a => a.name === name);
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
        <span class="w-2 h-2 rounded-full ${isActive ? 'running' : ''}" style="background:${c}"></span>
        <span class="text-xs font-medium text-white">${escHtml(name)}</span>
        ${badge}
      </div>
      <div class="text-[10px] text-muted truncate">${escHtml(st.text || 'Pronto')}</div>
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
  const options = [{ id: 'kiro', label: 'Kiro CLI' }, { id: 'gemini', label: 'Gemini CLI' }];
  menu.innerHTML = `<div class="px-3 py-1.5 text-muted text-[10px] uppercase">CLI para ${escHtml(name)}</div>` +
    options.map(o => `<div onclick="event.stopPropagation();setAgentCli('${a?.id || name}','${o.id}')" class="px-3 py-1.5 cursor-pointer hover:bg-accent/10 transition flex items-center gap-2 ${currentCli === o.id ? 'text-accent' : 'text-gray-400'}">
      ${currentCli === o.id ? '●' : '○'} ${o.label}
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
  const r = await apiPut(`${API}/agents/${agentId}`, { id: a.id, name: a.name, persona: a.persona, color: a.color, model: a.model, mcps: a.mcps || {}, cli_type: cliType });
  if (!r.ok) return;
  await loadAgents();
  const s = getActiveSession();
  if (s && s.sessionOpen) {
    await apiPost(`${API}/session/restart/${agentId}?project_id=${activeProjectId}`);
  }
}

function _dropRunAgent(targetName) {
  const s = getActiveSession();
  if (!s || !_dragRunAgent || _dragRunAgent === targetName) return;
  const from = s.runAgentOrder.indexOf(_dragRunAgent);
  const to = s.runAgentOrder.indexOf(targetName);
  if (from < 0 || to < 0) return;
  s.runAgentOrder.splice(from, 1);
  s.runAgentOrder.splice(to, 0, _dragRunAgent);
  renderAgentBoxes();
}

function selectChatTarget(target) {
  const s = getActiveSession();
  if (!s) return;
  s.chatTarget = target;
  renderAgentBoxes();
  document.querySelectorAll('.agent-box').forEach(b => { b.classList.remove('border-accent/50', 'bg-accent/5'); b.classList.add('border-border', 'bg-surface'); });

  if (target === '__log__') {
    showView('log');
    document.getElementById('chat-header').innerHTML = '<span class="text-sm text-muted">📋 Log bruto</span>';
    document.getElementById('chat-input').placeholder = 'Mensagem para o swarm...';
    document.getElementById('box-__log__').classList.add('border-accent/50', 'bg-accent/5');
  } else if (target) {
    showView('chat');
    const c = getColor(target);
    document.getElementById('chat-header').innerHTML = `<span class="w-2 h-2 rounded-full" style="background:${c}"></span><span class="text-sm font-medium text-white">${escHtml(target)}</span><span class="text-xs text-muted ml-2">Chat direto com este agente</span>`;
    document.getElementById('chat-input').placeholder = `Mensagem para ${target}...`;
  } else {
    showView('grid');
    document.getElementById('chat-header').innerHTML = s.sessionOpen
      ? '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="text-sm text-white font-medium">Swarm</span><span class="text-xs text-muted ml-2">Visão geral de todos os agentes</span>'
      : '<span class="text-sm text-muted">Abra um projeto para começar</span>';
    document.getElementById('chat-input').placeholder = 'Mensagem para o swarm... (@agente para falar direto)';
    document.getElementById('box-swarm').classList.add('border-accent/50', 'bg-accent/5');
    document.getElementById('box-swarm').classList.remove('border-border', 'bg-surface');
  }
}

// ── Raw log ──────────────────────────────────────────────────────────────

function appendLog(projectId, html) {
  const s = sessions[projectId];
  if (!s) return;

  if (projectId === activeProjectId) {
    const log = document.getElementById('raw-log');
    const div = document.createElement('div');
    div.className = 'log-line'; div.innerHTML = html; log.appendChild(div);
    if (s.chatTarget === '__log__') {
      const scroll = document.getElementById('chat-scroll');
      if (isNearBottom(scroll)) scroll.scrollTop = scroll.scrollHeight;
    }
  }
}

// ── SSE handler ──────────────────────────────────────────────────────────

function handleSSE(projectId, type, data) {
  const s = sessions[projectId];
  if (!s) return;

  const t = ts();
  if (type === 'orch') {
    appendLog(projectId, `<span class="text-muted">${t}</span> <span class="text-amber-400 font-medium">[ORCH]</span> ${escHtml(data.msg)}`);
    const hm = data.msg.match(/^→ (.+?): (.+)/);
    if (hm) addChatBubble(projectId, 'system', `→ Handoff para ${hm[1]}: ${hm[2]}`);
    const rm = data.msg.match(/^Round (\d+): (.+)/);
    if (rm) updateAgentBox(projectId, rm[2], 'working', 'Processando...');
  } else if (type === 'agent') {
    const c = data.name === 'GOD' ? '#fbbf24' : getColor(data.name);
    appendLog(projectId, `<span class="text-muted">${t}</span> <span style="color:${c}" class="font-medium">[${escHtml(data.name)}]</span> <span class="text-muted">${escHtml(data.event)}</span>`);
    if (data.text) {
      for (const l of data.text.split('\n').slice(0, 15))
        appendLog(projectId, `<span class="text-muted ml-4">│</span> <span class="text-gray-400">${escHtml(l)}</span>`);
    }
    if (data.name !== 'GOD') {
      if (data.event.includes('ready')) {
        updateAgentBox(projectId, data.name, 'ready', 'Pronto');
        updateGridPanel(projectId, data.name, 'Pronto');
      }
      if (data.event.includes('← prompt') || data.event.includes('← direct')) {
        updateAgentBox(projectId, data.name, 'working', 'Processando...');
        updateGridPanel(projectId, data.name, 'Processando...', '');
      }
      if (data.event === '⏳ streaming' || data.event === '⏳ streaming-replace') {
        console.log('STREAM', data.event, 'pid=', projectId, 'active=', activeProjectId, 'name=', data.name, 'textLen=', (data.text||'').length);
        updateAgentBox(projectId, data.name, 'working', (data.text || '').slice(0, 60));
        if (data.event === '⏳ streaming-replace') {
          replaceGridPanel(projectId, data.name, data.text || '');
        } else {
          appendGridPanel(projectId, data.name, data.text || '');
        }
        return;
      }
      if (data.event.includes('→ response')) {
        if (s.agentStatus[data.name]) s.agentStatus[data.name].msgCount = (s.agentStatus[data.name].msgCount || 0) + 1;
        updateAgentBox(projectId, data.name, 'ready', (data.text || '').slice(0, 60));
        updateGridPanel(projectId, data.name, 'Pronto');
        addChatBubble(projectId, 'agent', data.text || '', data.name);
      }
    }
  } else if (type === 'summary') {
    addChatBubble(projectId, 'summary', data.text);
    if (projectId === activeProjectId) {
      // Show done floating card
      const parts = (data.text || '').match(/^(.+?):\s*(.*)/s);
      const card = document.getElementById('done-card');
      document.getElementById('done-card-agent').textContent = parts ? parts[1] : 'Agente';
      document.getElementById('done-card-msg').textContent = parts ? parts[2] : data.text;
      card.classList.remove('hidden');
      setStatus('Session open');
    }
  } else if (type === 'error') {
    appendLog(projectId, `<span class="text-muted">${t}</span> <span class="text-red-400">[ERROR]</span> ${escHtml(data.msg)}`);
  } else if (type === 'done') {
    if (projectId === activeProjectId) setStatus('Session open');
  } else if (type === 'cost') {
    s.costData = data;
    if (projectId === activeProjectId) {
      renderAgentBoxes();
      updateCostHeader();
    }
  }
}

// ── Cost header ──────────────────────────────────────────────────────────

function updateCostHeader() {
  const s = getActiveSession();
  let el = document.getElementById('cost-total');
  if (!el) {
    const container = document.querySelector('header .flex.items-center.gap-4');
    if (!container) return;
    el = document.createElement('div');
    el.id = 'cost-total';
    el.className = 'flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full';
    container.insertBefore(el, container.querySelector('#sse-indicator'));
  }
  const total = s?.costData?.total_usd || 0;
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
  await apiPut(`${API}/settings`, { key: 'data_collection', value: val });
  const s = document.getElementById('settings-data-collection');
  if (s) s.checked = val;
}

// ── Tab Management ───────────────────────────────────────────────────────

function addRunTab() {
  const tabId = 'new';
  if (sessions[tabId]) {
    switchRunTab(tabId);
    return;
  }

  sessions[tabId] = {
    projectId: null,
    flowId: null,
    sessionOpen: false,
    chatHistory: [],
    agentStatus: {},
    runAgentOrder: [],
    costData: { agents: {}, total_usd: 0 },
    eventSource: null,
    chatTarget: null
  };

  const newTab = { id: tabId, name: 'Nova Execução' };
  State.set('runTabs', [...State.get('runTabs'), newTab]);
  switchRunTab(tabId);
}

function removeRunTab(tabId) {
  const s = sessions[tabId];
  if (s) {
    if (s.eventSource) s.eventSource.close();
    if (s.sessionOpen) apiPost(`${API}/session/close/${tabId}`);
    delete sessions[tabId];
  }
  const tabs = State.get('runTabs').filter(t => t.id !== tabId);
  State.set('runTabs', tabs);
  if (activeProjectId === tabId) {
    if (tabs.length > 0) switchRunTab(tabs[tabs.length - 1].id);
    else {
      activeProjectId = null;
      renderRunUI();
    }
  }
}

function switchRunTab(tabId) {
  activeProjectId = tabId;
  State.set('activeTabId', tabId);
  renderRunUI();
}

function renderRunUI() {
  renderRunTabs();
  const s = getActiveSession();
  if (!s) {
    document.getElementById('project-select').value = '';
    document.getElementById('run-flow-select').value = '';
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('raw-log').innerHTML = '';
    document.getElementById('run-agents').innerHTML = '';
    document.getElementById('agent-grid').innerHTML = '';
    setSessionUI(false);
    updateCostHeader();
    return;
  }

  document.getElementById('project-select').value = s.projectId || '';
  document.getElementById('run-flow-select').value = s.flowId || '';
  
  // Re-render chat and grid
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('raw-log').innerHTML = '';
  document.getElementById('agent-grid').innerHTML = '';
  
  s.chatHistory.filter(m => shouldShow(activeProjectId, m)).forEach(m => appendBubble(m.type, m.text, m.label));
  // Re-render grid panels
  Object.keys(s.agentStatus).forEach(name => {
    const st = s.agentStatus[name];
    updateGridPanel(activeProjectId, name, st.status, st.text);
  });

  renderAgentBoxes();
  setSessionUI(s.sessionOpen);
  updateCostHeader();
  selectChatTarget(s.chatTarget);
}

function renderRunTabs() {
  const tabs = State.get('runTabs');
  const el = document.getElementById('run-tabs-list');
  el.innerHTML = tabs.map(t => {
    const active = t.id === activeProjectId;
    return `
      <div class="flex items-center group">
        <button onclick="switchRunTab('${t.id}')" 
          class="px-4 py-2 rounded-t-lg text-xs font-medium transition flex items-center gap-2 ${active ? 'bg-card border-x border-t border-border text-accent' : 'text-muted hover:text-white hover:bg-white/5'}">
          <span>${escHtml(t.name)}</span>
        </button>
        <button onclick="removeRunTab('${t.id}')" 
          class="px-2 py-2 rounded-t-lg text-muted hover:text-red-400 transition text-[10px] ${active ? 'bg-card border-t border-r border-border' : 'hover:bg-white/5'}">✕</button>
      </div>
    `;
  }).join('');
}

// Initialize first tab
document.addEventListener('DOMContentLoaded', () => {
  if (State.get('runTabs').length === 0) {
    // addRunTab(); // Optional: start with one tab
  }
});
