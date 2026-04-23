// ReDo! v2 — Frontend

let projects = [];        // all projects from config
let openedProjects = [];  // indices of projects currently opened as tabs
let activeTab = -1;       // index into openedProjects (-1 = none)
let panes = {};           // sessionID -> { term, fitAddon, agent }
let focusedPane = null;
let projectPanes = {};    // projectName -> { sessionID -> { term, fitAddon, agent } }

// --- Init ---
async function init() {
  console.log('[init] starting');
  try {
    projects = await window.go.main.App.GetProjects();
    console.log('[init] projects:', JSON.stringify(projects));
  } catch(e) {
    console.error('[init] GetProjects error:', e);
  }
  setupInput();
  await showHome();
}

// --- Home Screen ---
async function showHome() {
  projects = await window.go.main.App.GetProjects();
  document.getElementById('home-screen').style.display = '';
  document.getElementById('workspace').style.display = 'none';
  renderHomeProjects();
}

function renderHomeProjects() {
  const el = document.getElementById('home-projects');
  if (projects.length === 0) {
    el.innerHTML = '<p style="color:#8b949e;text-align:center">No projects yet</p>';
    return;
  }
  el.innerHTML = projects.map((p, i) => {
    const agents = p.agents || [];
    const agentText = agents.length > 0
      ? agents.map(a => `<span style="color:${a.color || '#8b949e'}">${a.name}</span>`).join(', ')
      : '<span style="color:#8b949e">No agents</span>';
    return `<div class="project-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="pc-name" style="cursor:pointer;flex:1" onclick="openProject(${i})">${p.name}</div>
        <span class="delete-btn" onclick="event.stopPropagation();deleteProject(${i})" title="Delete project">🗑</span>
      </div>
      <div class="pc-path" onclick="openProject(${i})" style="cursor:pointer">${p.path}</div>
      <div class="pc-agents">${agentText}</div>
    </div>`;
  }).join('');
}

async function openProject(idx) {
  // Refresh from backend
  projects = await window.go.main.App.GetProjects();

  // Don't open twice
  if (openedProjects.includes(idx)) {
    activeTab = openedProjects.indexOf(idx);
    enterWorkspace();
    return;
  }
  openedProjects.push(idx);
  activeTab = openedProjects.length - 1;
  enterWorkspace();

  // Auto-respawn saved agents
  const proj = projects[idx];
  if (proj.agents && proj.agents.length > 0 && (!projectPanes[proj.name] || Object.keys(projectPanes[proj.name]).length === 0)) {
    const result = await window.go.main.App.RespawnProject(proj.name);
    console.log('[RespawnProject] result:', JSON.stringify(result));
    if (result) {
      const colors = { kiro: '#f0883e', gemini: '#1f6feb', claude: '#a371f7', codex: '#3fb950' };
      for (const [agentName, sid] of Object.entries(result)) {
        const saved = proj.agents.find(a => a.name === agentName);
        const agent = saved || { name: agentName, cli_type: 'kiro', color: '#8b949e' };
        agent.color = agent.color || colors[agent.cli_type] || '#8b949e';
        createPane(sid, agent);
      }
    }
  }
}

function enterWorkspace() {
  document.getElementById('home-screen').style.display = 'none';
  document.getElementById('workspace').style.display = '';
  switchTab(activeTab);
}

// --- Tabs ---
function renderTabs() {
  const el = document.getElementById('tabs');
  let html = '';
  openedProjects.forEach((projIdx, tabIdx) => {
    const p = projects[projIdx];
    html += `<div class="tab ${tabIdx === activeTab ? 'active' : ''}" onclick="switchTab(${tabIdx})">
      ${p.name}
      <span class="tab-close" onclick="event.stopPropagation(); closeTab(${tabIdx})">✕</span>
    </div>`;
  });
  html += `<div class="tab-actions">
    <button onclick="showProjectPicker()">+ Project</button>
    <button onclick="spawnNextAgent()">+ Agent</button>
    <button onclick="showSettings()">⚙</button>
  </div>`;
  el.innerHTML = html;
}

function switchTab(tabIdx) {
  // Save current panes and hide them
  if (activeTab >= 0 && activeTab < openedProjects.length) {
    const prevProj = projects[openedProjects[activeTab]];
    if (prevProj) {
      projectPanes[prevProj.name] = {};
      // Save and hide each pane by session ID
      Object.entries(panes).forEach(([sid, info]) => {
        projectPanes[prevProj.name][sid] = info;
        const el = document.getElementById('pane-' + sid);
        if (el) el.style.display = 'none';
      });
    }
  }

  activeTab = tabIdx;
  panes = {};
  focusedPane = null;

  // Hide ALL panes first (safety)
  document.querySelectorAll('.pane').forEach(p => p.style.display = 'none');

  const proj = projects[openedProjects[activeTab]];
  if (proj && projectPanes[proj.name]) {
    panes = { ...projectPanes[proj.name] };
    Object.keys(panes).forEach(sid => {
      const el = document.getElementById('pane-' + sid);
      if (el) el.style.display = '';
    });
    focusedPane = Object.keys(panes)[0] || null;
    if (focusedPane) focusPane(focusedPane);
  }

  renderTabs();
  updateStatus();
  renderKBList();
  refitAll();
}

function closeTab(tabIdx) {
  const projIdx = openedProjects[tabIdx];
  const proj = projects[projIdx];

  // Kill all panes for this project
  if (proj && projectPanes[proj.name]) {
    Object.keys(projectPanes[proj.name]).forEach(sid => killPane(sid));
    delete projectPanes[proj.name];
  }

  openedProjects.splice(tabIdx, 1);
  if (openedProjects.length === 0) {
    activeTab = -1;
    panes = {};
    focusedPane = null;
    showHome();
    return;
  }
  if (activeTab >= openedProjects.length) activeTab = openedProjects.length - 1;
  switchTab(activeTab);
}

// --- Project Picker Modal (for "+ Project" button) ---
async function showProjectPicker() {
  projects = await window.go.main.App.GetProjects();
  const el = document.getElementById('project-list');
  el.innerHTML = projects.map((p, i) => {
    const opened = openedProjects.includes(i);
    return `<div class="project-list-item" style="display:flex;justify-content:space-between;align-items:center">
      <div onclick="pickProject(${i})" style="cursor:pointer;flex:1">
        <div class="pli-name">${p.name} ${opened ? '<span style="color:#3fb950">● open</span>' : ''}</div>
        <div class="pli-path">${p.path}</div>
      </div>
      <span class="delete-btn" onclick="event.stopPropagation();closeProjectModal();deleteProject(${i})" title="Delete">🗑</span>
    </div>`;
  }).join('');
  if (projects.length === 0) el.innerHTML = '<p style="color:#8b949e;text-align:center">No projects</p>';
  document.getElementById('project-modal').classList.add('active');
}
function closeProjectModal() { document.getElementById('project-modal').classList.remove('active'); }

async function pickProject(idx) {
  closeProjectModal();
  await openProject(idx);
}

// --- New Project ---
function showNewProjectForm() {
  document.getElementById('new-proj-name').value = '';
  document.getElementById('new-proj-path').value = '';
  document.getElementById('new-project-modal').classList.add('active');
  document.getElementById('new-proj-name').focus();
}
function closeNewProjectModal() { document.getElementById('new-project-modal').classList.remove('active'); }

async function createProject() {
  const name = document.getElementById('new-proj-name').value.trim();
  const path = document.getElementById('new-proj-path').value.trim();
  if (!name || !path) return;
  projects.push({ name, path, kb_docs: [], agents: [] });
  await window.go.main.App.SaveProjects(projects);
  closeNewProjectModal();
  // If on home screen, refresh it; otherwise refresh picker
  if (document.getElementById('home-screen').style.display !== 'none') {
    renderHomeProjects();
  }
  await openProject(projects.length - 1);
}

async function deleteProject(projIdx) {
  const p = projects[projIdx];
  if (!confirm(`Delete project "${p.name}" and its ${(p.agents||[]).length} saved agents?`)) return;

  // Close tab if open
  const tabIdx = openedProjects.indexOf(projIdx);
  if (tabIdx >= 0) closeTab(tabIdx);

  // Remove from config
  projects.splice(projIdx, 1);
  // Fix openedProjects indices
  openedProjects = openedProjects.filter(i => i !== projIdx).map(i => i > projIdx ? i - 1 : i);
  if (activeTab >= openedProjects.length) activeTab = openedProjects.length - 1;

  await window.go.main.App.SaveProjects(projects);

  // Refresh whatever screen is visible
  if (document.getElementById('home-screen').style.display !== 'none') {
    renderHomeProjects();
  } else if (openedProjects.length === 0) {
    showHome();
  } else {
    renderTabs();
  }
}

// Clear saved agents from a project (without deleting the project)
async function clearProjectAgents(projIdx) {
  projects[projIdx].agents = [];
  await window.go.main.App.SaveProjects(projects);
  renderHomeProjects();
}

// --- Panes ---
function createPane(sessionID, agent) {
  const container = document.getElementById('panes');
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.id = 'pane-' + sessionID;
  pane.innerHTML = `
    <div class="pane-header">
      <span class="dot" style="background:${agent.color || '#8b949e'}"></span>
      <span class="agent-name">${agent.name}</span>
      <span class="agent-type">${agent.cli_type || ''}</span>
      <span class="token-count" id="tokens-${sessionID}" title="Token count">—</span>
      <span class="compress-btn" onclick="event.stopPropagation(); compressAgent('${sessionID}')" title="Compress context">🗜</span>
      <span class="close-btn" onclick="event.stopPropagation(); killPane('${sessionID}', true)">✕</span>
    </div>
    <div class="pane-terminal" id="term-${sessionID}"></div>
  `;
  container.appendChild(pane);

  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#264f78' },
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 13,
    cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('term-' + sessionID));
  fitAddon.fit();
  window.go.main.App.ResizeTerminal(sessionID, term.rows, term.cols);

  term.onData((data) => { window.go.main.App.SendRaw(sessionID, data); });
  document.getElementById('term-' + sessionID).addEventListener('mousedown', () => { focusPane(sessionID); });

  panes[sessionID] = { term, fitAddon, agent };
  focusPane(sessionID);

  window.runtime.EventsOn('pty:output:' + sessionID, (data) => { term.write(data); });
  window.runtime.EventsOn('pty:exit:' + sessionID, () => { term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n'); });

  // Listen for token count updates from backend
  window.runtime.EventsOn('tokens:update:' + sessionID, (info) => {
    updateTokenDisplay(sessionID, info);
  });

  updateStatus();
  setTimeout(() => { fitAddon.fit(); window.go.main.App.ResizeTerminal(sessionID, term.rows, term.cols); refitAll(); refreshTokenCount(sessionID); }, 200);
}

function killPane(sessionID, removeFromConfig = false) {
  if (removeFromConfig) {
    window.go.main.App.RemoveAgent(sessionID);
  } else {
    window.go.main.App.KillSession(sessionID);
  }
  window.runtime.EventsOff('pty:output:' + sessionID);
  window.runtime.EventsOff('pty:exit:' + sessionID);
  const el = document.getElementById('pane-' + sessionID);
  if (el) el.remove();
  if (panes[sessionID]) { panes[sessionID].term.dispose(); delete panes[sessionID]; }
  if (focusedPane === sessionID) {
    focusedPane = Object.keys(panes)[0] || null;
    if (focusedPane) focusPane(focusedPane);
  }
  updateStatus();
}

function focusPane(sessionID) {
  document.querySelectorAll('.pane').forEach(p => { p.classList.remove('focused'); p.style.borderColor = '#30363d'; p.style.boxShadow = 'none'; });
  document.getElementById('input').blur();
  const el = document.getElementById('pane-' + sessionID);
  if (el && panes[sessionID]) {
    const color = panes[sessionID].agent.color || '#1f6feb';
    el.classList.add('focused');
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 8px ${color}40, inset 0 0 1px ${color}30`;
    panes[sessionID].term.focus();
    const textarea = el.querySelector('.xterm-helper-textarea');
    if (textarea) textarea.focus();
  }
  focusedPane = sessionID;
}

// --- Spawn Agent ---
let selectedAgentBtn = null;

async function spawnNextAgent() {
  if (activeTab < 0) return;
  document.getElementById('spawn-name').value = 'agent-' + (Object.keys(panes).length + 1);
  selectedAgentBtn = null;
  document.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('spawn-yolo').checked = false;
  document.getElementById('btn-do-spawn').disabled = true;
  document.getElementById('spawn-modal').classList.add('active');
  document.getElementById('spawn-name').focus();
  document.getElementById('spawn-name').select();
}

function selectAgentType(btn) {
  document.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedAgentBtn = btn;
  document.getElementById('btn-do-spawn').disabled = false;
}
function closeSpawnModal() { document.getElementById('spawn-modal').classList.remove('active'); }

async function doSpawn() {
  if (!selectedAgentBtn || activeTab < 0) return;
  const name = document.getElementById('spawn-name').value.trim();
  if (!name) return;
  let cmd = selectedAgentBtn.dataset.cmd;
  const cliType = selectedAgentBtn.dataset.type;
  const yolo = document.getElementById('spawn-yolo').checked;
  if (yolo) cmd += ' ' + selectedAgentBtn.dataset.yolo;
  const colors = { kiro: '#f0883e', gemini: '#1f6feb', claude: '#a371f7', codex: '#3fb950' };
  const color = colors[cliType] || '#8b949e';
  closeSpawnModal();
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  const agent = { name, command: cmd, color, cli_type: cliType, mcps: {} };
  const sid = await window.go.main.App.SpawnAgent(proj.name, agent.name, agent.command, agent.color, agent.cli_type);
  if (sid && !sid.startsWith('error:')) {
    createPane(sid, agent);
  } else {
    alert('Failed to spawn agent: ' + (sid || 'unknown error'));
  }
}

// --- Input ---
let searchTimer = null;
let pendingChunks = [];
let searching = false;
let ctxEnabled = true;

function setupInput() {
  const input = document.getElementById('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!document.getElementById('send-btn').disabled) sendMessage();
    }
  });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!ctxEnabled || q.length < 3) { hidePreview(); setSendEnabled(true); return; }
    setSendEnabled(false);
    searching = true;
    searchTimer = setTimeout(() => searchPreview(q), 400);
  });
  input.addEventListener('focus', () => {
    document.querySelectorAll('.pane').forEach(p => { p.classList.remove('focused'); p.style.borderColor = '#30363d'; p.style.boxShadow = 'none'; });
  });
}

function setSendEnabled(enabled) {
  document.getElementById('send-btn').disabled = !enabled;
}

function onCtxToggle() {
  ctxEnabled = document.getElementById('ctx-toggle').checked;
  document.querySelector('.ctx-toggle').classList.toggle('off', !ctxEnabled);
  if (!ctxEnabled) {
    hidePreview();
    setSendEnabled(true);
  }
}

async function searchPreview(query) {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  try {
    console.log('[searchPreview] query:', query, 'project:', proj.name);
    const hits = await window.go.main.App.SearchChunks(proj.name, query, 3);
    console.log('[searchPreview] hits:', hits);
    if (!hits || hits.length === 0) { hidePreview(); searching = false; setSendEnabled(true); return; }
    pendingChunks = hits;
    const el = document.getElementById('injection-preview');
    el.innerHTML = hits.map((h, i) =>
      `<div class="preview-chip" onclick="toggleChip(this,${i})" onmouseenter="showChunkTooltip(event,${i})" onmouseleave="hideChunkTooltip()">
        <span class="chip-source">${h.type === 'kb' ? '📚' : '💬'} ${escapeHtml(h.source)}</span>
        <span class="chip-text">${escapeHtml(h.content.substring(0, 120))}${h.content.length > 120 ? '...' : ''}</span>
      </div>`
    ).join('');
    el.classList.add('visible');
    el.querySelectorAll('.preview-chip').forEach(c => c.classList.add('selected'));
  } catch(e) {
    console.error('[searchPreview] error:', e);
  }
  searching = false;
  setSendEnabled(true);
}

function toggleChip(el, idx) {
  el.classList.toggle('selected');
}

function showChunkTooltip(e, idx) {
  if (!pendingChunks[idx]) return;
  let tip = document.getElementById('chunk-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chunk-tooltip';
    tip.onmouseenter = () => { tip._hover = true; };
    tip.onmouseleave = () => { tip._hover = false; tip.style.display = 'none'; };
    document.body.appendChild(tip);
  }
  const h = pendingChunks[idx];
  tip.innerHTML = `<div class="tt-source">${h.type === 'kb' ? '📚' : '💬'} ${escapeHtml(h.source)}</div><div class="tt-body">${escapeHtml(h.content)}</div>`;
  tip.style.display = 'block';
  tip._hover = false;
  const rect = e.currentTarget.getBoundingClientRect();
  tip.style.left = rect.left + 'px';
  tip.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
}

function hideChunkTooltip() {
  setTimeout(() => {
    const tip = document.getElementById('chunk-tooltip');
    if (tip && !tip._hover) tip.style.display = 'none';
  }, 100);
}

function hidePreview() {
  pendingChunks = [];
  const el = document.getElementById('injection-preview');
  el.innerHTML = '';
  el.classList.remove('visible');
}

function getSelectedContext() {
  const chips = document.querySelectorAll('#injection-preview .preview-chip.selected');
  if (chips.length === 0 || pendingChunks.length === 0) return '';
  let ctx = '--- Relevant context ---\n';
  chips.forEach(chip => {
    const idx = parseInt(chip.querySelector('.chip-source') ? Array.from(chip.parentNode.children).indexOf(chip) : 0);
    if (pendingChunks[idx]) {
      const h = pendingChunks[idx];
      ctx += `[${h.source}] ${h.content}\n\n`;
    }
  });
  ctx += '--- End context ---\n\n';
  return ctx;
}

function sendMessage() {
  const input = document.getElementById('input');
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';

  const words = raw.split(/\s+/);
  const targets = [], textParts = [];
  for (const w of words) { if (w.startsWith('@')) targets.push(w.slice(1)); else textParts.push(w); }
  const userText = textParts.join(' ');

  // Prepend selected context chunks
  const ctx = getSelectedContext();
  const text = ctx ? ctx + userText : userText;

  hidePreview();

  let sessionIDs = [];
  if (targets.length === 0) { if (focusedPane) sessionIDs = [focusedPane]; }
  else { for (const [sid, info] of Object.entries(panes)) { if (targets.includes(info.agent.name)) sessionIDs.push(sid); } }
  if (sessionIDs.length > 0 && text) window.go.main.App.SendInput(sessionIDs, text);
}

// --- Status ---
function updateStatus() {
  const proj = activeTab >= 0 ? projects[openedProjects[activeTab]] : null;
  const running = Object.keys(panes).length;
  document.getElementById('status-bar').textContent = proj
    ? `${proj.path} | ${running} agent${running !== 1 ? 's' : ''} running`
    : '';
}

// --- Terminal Panel (multi-tab) ---
let shellTabs = []; // { sid, term, fitAddon, name }
let activeShellTab = -1;

function toggleTermPanel() {
  const panel = document.getElementById('term-panel');
  const body = document.getElementById('term-panel-body');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    body.style.display = 'none';
  } else {
    panel.classList.add('open');
    body.style.display = '';
    if (shellTabs.length === 0) addShellTab();
    else if (activeShellTab >= 0) {
      shellTabs[activeShellTab].fitAddon.fit();
      shellTabs[activeShellTab].term.focus();
    }
  }
}

async function addShellTab() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;

  const sid = await window.go.main.App.SpawnShell(proj.name);
  if (!sid || sid.startsWith('error:')) return;

  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9' },
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 12, cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const idx = shellTabs.length;
  shellTabs.push({ sid, term, fitAddon, name: 'shell ' + (idx + 1) });

  term.onData((data) => { window.go.main.App.SendRaw(sid, data); });
  window.runtime.EventsOn('pty:output:' + sid, (data) => { term.write(data); });
  window.runtime.EventsOn('pty:exit:' + sid, () => { term.write('\r\n\x1b[31m[exited]\x1b[0m\r\n'); });

  // Open panel if closed
  const panel = document.getElementById('term-panel');
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    document.getElementById('term-panel-body').style.display = '';
  }

  switchShellTab(idx);
}

function switchShellTab(idx) {
  // Detach current
  if (activeShellTab >= 0 && shellTabs[activeShellTab]) {
    const el = shellTabs[activeShellTab].term.element;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  activeShellTab = idx;
  const container = document.getElementById('term-panel-content');
  container.innerHTML = '';
  const tab = shellTabs[idx];
  if (!tab.term.element) {
    tab.term.open(container);
  } else {
    container.appendChild(tab.term.element);
  }
  tab.fitAddon.fit();
  window.go.main.App.ResizeTerminal(tab.sid, tab.term.rows, tab.term.cols);
  tab.term.focus();
  renderShellTabs();
}

function closeShellTab(idx) {
  const tab = shellTabs[idx];
  window.go.main.App.KillSession(tab.sid);
  window.runtime.EventsOff('pty:output:' + tab.sid);
  window.runtime.EventsOff('pty:exit:' + tab.sid);
  tab.term.dispose();
  shellTabs.splice(idx, 1);
  if (shellTabs.length === 0) {
    activeShellTab = -1;
    document.getElementById('term-panel-content').innerHTML = '';
    toggleTermPanel();
  } else {
    if (activeShellTab >= shellTabs.length) activeShellTab = shellTabs.length - 1;
    switchShellTab(activeShellTab);
  }
}

function renderShellTabs() {
  document.getElementById('term-tabs').innerHTML = shellTabs.map((t, i) =>
    `<span class="term-tab ${i === activeShellTab ? 'active' : ''}" onclick="event.stopPropagation(); switchShellTab(${i})">
      ${t.name}<span class="tt-close" onclick="event.stopPropagation(); closeShellTab(${i})">✕</span>
    </span>`
  ).join('');
}

// --- KB Sidebar ---
function renderKBList() {
  const el = document.getElementById('kb-list');
  if (activeTab < 0) { el.innerHTML = ''; return; }
  const proj = projects[openedProjects[activeTab]];
  if (!proj || !proj.kb_docs || proj.kb_docs.length === 0) {
    el.innerHTML = '<div style="padding:12px;color:#8b949e;font-size:12px;text-align:center">No docs added</div>';
    return;
  }
  el.innerHTML = proj.kb_docs.map(doc => {
    const name = doc.split('/').pop();
    return `<div class="kb-item">
      <span class="kb-name" title="${doc}" onclick="openKBViewer('${doc}')" style="cursor:pointer">${name}</span>
      <span class="kb-remove" onclick="removeKBDoc('${doc}')">✕</span>
    </div>`;
  }).join('');
}

async function addKBDoc() {
  if (activeTab < 0) return;
  const path = await window.go.main.App.PickFile();
  if (!path) return;
  const proj = projects[openedProjects[activeTab]];
  showKBLoading('Indexing ' + path.split('/').pop() + '...');
  const result = await window.go.main.App.AddKBDoc(proj.name, path);
  hideKBLoading();
  projects = await window.go.main.App.GetProjects();
  renderKBList();
  updateStatus();
}

async function removeKBDoc(path) {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  await window.go.main.App.RemoveKBDoc(proj.name, path);
  projects = await window.go.main.App.GetProjects();
  renderKBList();
}

async function reindexKB() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  showKBLoading('Reindexing all docs...');
  const result = await window.go.main.App.ReindexKB(proj.name);
  hideKBLoading();
  alert(result);
}

function showKBLoading(text) {
  let el = document.getElementById('kb-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kb-loading';
    document.getElementById('kb-list').prepend(el);
  }
  el.innerHTML = `<span class="kb-spinner"></span> ${text}`;
  el.style.display = 'flex';
}

function hideKBLoading() {
  const el = document.getElementById('kb-loading');
  if (el) el.style.display = 'none';
}

// --- KB Viewer ---
let kbViewerData = { path: '', content: '', chunks: [] };

async function openKBViewer(docPath) {
  document.getElementById('kb-viewer-title').textContent = docPath.split('/').pop();
  document.getElementById('kb-viewer-modal').classList.add('active');

  const proj = projects[openedProjects[activeTab]];
  // Load content and chunks in parallel
  const [content, chunks] = await Promise.all([
    window.go.main.App.ReadFileContent(docPath),
    window.go.main.App.GetKBChunks(proj.name, docPath),
  ]);
  kbViewerData = { path: docPath, content: content || '(empty)', chunks: chunks || [] };
  switchKBView('doc', document.querySelector('.kb-vtab'));
}

function switchKBView(view, btn) {
  document.querySelectorAll('.kb-vtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const el = document.getElementById('kb-viewer-content');
  if (view === 'doc') {
    el.textContent = kbViewerData.content;
  } else {
    if (kbViewerData.chunks.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;padding:20px;text-align:center">No chunks — reindex to generate</div>';
    } else {
      el.innerHTML = kbViewerData.chunks.map((c, i) =>
        `<div class="chunk-card"><div class="chunk-header">Chunk ${i + 1} / ${kbViewerData.chunks.length} — ${c.length} chars</div><div class="chunk-body">${escapeHtml(c)}</div></div>`
      ).join('');
    }
  }
}

function closeKBViewer() { document.getElementById('kb-viewer-modal').classList.remove('active'); }

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- Settings ---
async function showSettings() {
  try {
    const s = await window.go.main.App.GetSettings();
    document.getElementById('set-gemini').value = (s && s.gemini_api_key) || '';
    const sqliteOn = !s || s.sqlite_enabled !== 'false';
    document.getElementById('set-sqlite').checked = sqliteOn;
    document.getElementById('sqlite-warning').style.display = 'none';
  } catch(e) {
    console.error('[showSettings] error:', e);
  }
  // Show warning when unchecking
  document.getElementById('set-sqlite').onchange = function() {
    document.getElementById('sqlite-warning').style.display = this.checked ? 'none' : 'block';
  };
  document.getElementById('settings-modal').classList.add('active');
}
function closeSettings() { document.getElementById('settings-modal').classList.remove('active'); }
async function saveSettings() {
  const sqliteOn = document.getElementById('set-sqlite').checked;
  const wasOn = (await window.go.main.App.GetSettings()).sqlite_enabled !== 'false';

  // If turning off, confirm and wipe
  if (wasOn && !sqliteOn) {
    if (!confirm('This will DELETE all stored data (embeddings, conversation history, KB chunks). Continue?')) return;
    await window.go.main.App.WipeSQLite();
  }

  const r = await window.go.main.App.SaveSettings(
    document.getElementById('set-gemini').value.trim(),
    sqliteOn,
  );
  closeSettings();
  if (r !== 'ok') alert(r);
}

// --- Context Optimization ---
async function compressAgent(sessionID) {
  if (!confirm('Compress context? This will respawn the agent with a summarized conversation.')) return;
  const el = document.getElementById('tokens-' + sessionID);
  if (el) el.textContent = '🗜...';
  const result = await window.go.main.App.CompressAgent(sessionID);
  if (result.startsWith('error:')) {
    alert(result);
  }
  // Terminal will reconnect via pty:output events
  setTimeout(() => refreshTokenCount(sessionID), 5000);
}

async function refreshTokenCount(sessionID) {
  const info = await window.go.main.App.CheckTokens(sessionID);
  updateTokenDisplay(sessionID, info);
}

function updateTokenDisplay(sessionID, info) {
  const el = document.getElementById('tokens-' + sessionID);
  if (!el || !info) return;
  const pct = Math.round((info.tokens / info.threshold) * 100);
  el.textContent = `${info.tokens}t`;
  el.style.color = pct > 90 ? '#da3633' : pct > 70 ? '#d29922' : '#8b949e';
  if (info.tokens > info.threshold) {
    el.textContent = `⚠ ${info.tokens}t`;
  }
}

// Periodically check token counts for all panes
setInterval(() => {
  Object.keys(panes).forEach(sid => refreshTokenCount(sid));
}, 60000);

// --- Resize ---
function refitAll() {
  Object.entries(panes).forEach(([sid, { fitAddon, term }]) => {
    try { fitAddon.fit(); window.go.main.App.ResizeTerminal(sid, term.rows, term.cols); } catch(e) {}
  });
}
window.addEventListener('resize', refitAll);

// --- Start ---
document.addEventListener('DOMContentLoaded', init);
