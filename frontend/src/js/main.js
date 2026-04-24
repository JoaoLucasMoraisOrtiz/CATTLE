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
  projects = await window.go.main.App.GetProjects();

  if (openedProjects.includes(idx)) {
    activeTab = openedProjects.indexOf(idx);
    enterWorkspace();
    return;
  }

  // Save current panes BEFORE changing activeTab
  if (activeTab >= 0 && activeTab < openedProjects.length) {
    const prevProj = projects[openedProjects[activeTab]];
    if (prevProj) {
      projectPanes[prevProj.name] = { ...panes };
      Object.keys(panes).forEach(sid => {
        const el = document.getElementById('pane-' + sid);
        if (el) el.style.display = 'none';
      });
    }
  }

  openedProjects.push(idx);
  activeTab = openedProjects.length - 1;

  // Clear for new project
  panes = {};
  focusedPane = null;
  document.querySelectorAll('.pane').forEach(p => p.style.display = 'none');

  enterWorkspace();

  const proj = projects[idx];
  if (proj.agents && proj.agents.length > 0 && (!projectPanes[proj.name] || Object.keys(projectPanes[proj.name]).length === 0)) {
    const result = await window.go.main.App.RespawnProject(proj.name);
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
  if (activeTab >= 0 && activeTab < openedProjects.length && activeTab !== tabIdx) {
    const prevProj = projects[openedProjects[activeTab]];
    if (prevProj) {
      projectPanes[prevProj.name] = { ...panes };
      Object.keys(panes).forEach(sid => {
        const el = document.getElementById('pane-' + sid);
        if (el) el.style.display = 'none';
      });
    }
  }

  activeTab = tabIdx;
  panes = {};
  focusedPane = null;
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
  if (typeof resetCodeViewer === 'function') resetCodeViewer();
  if (typeof resetFileTree === 'function') resetFileTree();
  refitAll();
}

function closeTab(tabIdx) {
  const projIdx = openedProjects[tabIdx];
  const proj = projects[projIdx];

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

// --- Project Picker Modal ---
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
  if (document.getElementById('home-screen').style.display !== 'none') {
    renderHomeProjects();
  }
  await openProject(projects.length - 1);
}

async function deleteProject(projIdx) {
  const p = projects[projIdx];
  if (!confirm(`Delete project "${p.name}" and its ${(p.agents||[]).length} saved agents?`)) return;

  const tabIdx = openedProjects.indexOf(projIdx);
  if (tabIdx >= 0) closeTab(tabIdx);

  projects.splice(projIdx, 1);
  openedProjects = openedProjects.filter(i => i !== projIdx).map(i => i > projIdx ? i - 1 : i);
  if (activeTab >= openedProjects.length) activeTab = openedProjects.length - 1;

  await window.go.main.App.SaveProjects(projects);

  if (document.getElementById('home-screen').style.display !== 'none') {
    renderHomeProjects();
  } else if (openedProjects.length === 0) {
    showHome();
  } else {
    renderTabs();
  }
}

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
    <div class="pane-header" ondblclick="toggleCollapsePane('${sessionID}')">
      <span class="dot" style="background:${agent.color || '#8b949e'}"></span>
      <span class="agent-name">${agent.name}</span>
      <span class="agent-type">${agent.cli_type || ''}</span>
      <span class="token-count" id="tokens-${sessionID}">—</span>
      <span class="collapse-btn" onclick="event.stopPropagation(); toggleCollapsePane('${sessionID}')" title="Collapse">—</span>
      <span class="close-btn" onclick="event.stopPropagation(); killPane('${sessionID}', true)" title="Close">✕</span>
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
  // Keep projectPanes in sync
  if (activeTab >= 0 && activeTab < openedProjects.length) {
    const proj = projects[openedProjects[activeTab]];
    if (proj) {
      if (!projectPanes[proj.name]) projectPanes[proj.name] = {};
      projectPanes[proj.name][sessionID] = panes[sessionID];
    }
  }
  focusPane(sessionID);

  window.runtime.EventsOn('pty:output:' + sessionID, (data) => { term.write(data); });
  window.runtime.EventsOn('pty:exit:' + sessionID, () => { term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n'); });

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
  // Remove from projectPanes
  if (activeTab >= 0 && activeTab < openedProjects.length) {
    const proj = projects[openedProjects[activeTab]];
    if (proj && projectPanes[proj.name]) delete projectPanes[proj.name][sessionID];
  }
  if (focusedPane === sessionID) {
    focusedPane = Object.keys(panes)[0] || null;
    if (focusedPane) focusPane(focusedPane);
  }
  updateStatus();
}


function toggleCollapsePane(sessionID) {
  const el = document.getElementById('pane-' + sessionID);
  if (!el) return;
  el.classList.toggle('collapsed');
  const btn = el.querySelector('.collapse-btn');
  if (btn) btn.textContent = el.classList.contains('collapsed') ? '□' : '—';
  if (!el.classList.contains('collapsed') && panes[sessionID]) {
    setTimeout(() => { panes[sessionID].fitAddon.fit(); }, 50);
  }
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

// --- Status ---
function updateStatus() {
  const proj = activeTab >= 0 ? projects[openedProjects[activeTab]] : null;
  const running = Object.keys(panes).length;
  document.getElementById('status-bar').textContent = proj
    ? `${proj.path} | ${running} agent${running !== 1 ? 's' : ''} running`
    : '';
}

// --- Utility ---
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// --- Resize ---
function refitAll() {
  Object.entries(panes).forEach(([sid, { fitAddon, term }]) => {
    try { fitAddon.fit(); window.go.main.App.ResizeTerminal(sid, term.rows, term.cols); } catch(e) {}
  });
}
window.addEventListener('resize', refitAll);

// --- Start ---
document.addEventListener('DOMContentLoaded', init);
