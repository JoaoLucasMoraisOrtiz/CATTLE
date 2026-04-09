/* ReDo! — Agents CRUD */

let _agentSearchTerm = '';
let _dragAgentId = null;

async function loadAgents() {
  const r = await apiGet(`${API}/agents`);
  if (r.ok) { agents = r.data; renderAgents(); renderPalette(); }
}

function renderAgents() {
  const el = document.getElementById('agent-list');
  const filtered = _agentSearchTerm
    ? agents.filter(a => a.name.toLowerCase().includes(_agentSearchTerm) || a.id.toLowerCase().includes(_agentSearchTerm))
    : agents;
  const searchHtml = `<div class="px-1 pb-2"><input type="text" placeholder="Buscar agente..." value="${escHtml(_agentSearchTerm)}"
    oninput="_agentSearchTerm=this.value.toLowerCase();renderAgents()"
    class="w-full bg-surface border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-accent/50 transition"></div>`;
  if (!filtered.length) { el.innerHTML = searchHtml + '<p class="text-center text-muted text-xs py-8">Nenhum agente</p>'; return; }
  el.innerHTML = searchHtml + filtered.map(a => `
    <div class="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface/60 cursor-pointer transition"
      draggable="true" data-agent-id="${a.id}"
      ondragstart="_dragAgentId=this.dataset.agentId;this.classList.add('dragging')"
      ondragend="this.classList.remove('dragging')"
      ondragover="event.preventDefault();this.classList.add('drag-over')"
      ondragleave="this.classList.remove('drag-over')"
      ondrop="event.preventDefault();this.classList.remove('drag-over');_dropAgent(this.dataset.agentId)"
      onclick="editAgent('${a.id}')">
      <span class="text-muted/40 text-xs select-none cursor-grab">⠿</span>
      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${a.color}"></span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-white truncate">${a.name}</div>
        <div class="text-xs text-muted truncate">${a.persona.slice(0,50)}...</div>
      </div>
      <div class="hidden group-hover:flex gap-1">
        <button onclick="event.stopPropagation();editAgent('${a.id}')" aria-label="Editar ${escHtml(a.name)}" class="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-white hover:bg-border/50 transition text-xs">✎</button>
        <button onclick="event.stopPropagation();deleteAgent('${a.id}')" aria-label="Remover ${escHtml(a.name)}" class="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-red-400 hover:bg-red-500/10 transition text-xs">✕</button>
      </div>
    </div>`).join('');
}

function _dropAgent(targetId) {
  if (!_dragAgentId || _dragAgentId === targetId) return;
  const from = agents.findIndex(a => a.id === _dragAgentId);
  const to = agents.findIndex(a => a.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = agents.splice(from, 1);
  agents.splice(to, 0, moved);
  renderAgents();
  renderPalette();
}

function openModal(agent = null) {
  editingId = agent ? agent.id : null;
  document.getElementById('modal-title').textContent = agent ? 'Editar Agente' : 'Novo Agente';
  document.getElementById('m-id').value = agent?.id || '';
  document.getElementById('m-id').disabled = !!agent;
  document.getElementById('m-name').value = agent?.name || '';
  document.getElementById('m-color').value = agent?.color || '#60a5fa';
  document.getElementById('m-model').value = agent?.model || '';
  document.getElementById('m-persona').value = agent?.persona || '';
  populateMcpRows(agent?.mcps);
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); editingId = null; }
function editAgent(id) { const a = agents.find(x => x.id === id); if (a) openModal(a); }

async function saveAgent() {
  const fields = [
    { el: document.getElementById('m-id'), name: 'ID' },
    { el: document.getElementById('m-name'), name: 'Nome' },
    { el: document.getElementById('m-persona'), name: 'Persona' },
  ];
  if (!validateRequired(fields)) return;
  const btn = document.querySelector('#modal .bg-accent');
  setLoading(btn, true);
  const mcps = getMcpsFromForm();
  const body = {
    id: fields[0].el.value.trim(),
    name: fields[1].el.value.trim(),
    color: document.getElementById('m-color').value,
    model: document.getElementById('m-model').value.trim() || null,
    persona: fields[2].el.value.trim(),
    mcps,
  };
  const r = editingId
    ? await apiPut(`${API}/agents/${editingId}`, body)
    : await apiPost(`${API}/agents`, body);
  setLoading(btn, false);
  if (r.ok) { showToast('Agente salvo', 'success'); closeModal(); loadAgents(); }
}

async function deleteAgent(id) {
  if (!confirm(`Remover "${id}"?`)) return;
  const r = await apiDelete(`${API}/agents/${id}`);
  if (r.ok) loadAgents();
}

// ── MCP rows ─────────────────────────────────────────────────────────────

function addMcpPreset(name) {
  const existing = [...document.querySelectorAll('#m-mcps-list .mcp-name')].map(e => e.value.trim());
  if (existing.includes(name)) return;
  const p = MCP_PRESETS[name];
  addMcpRow(name, p.command, p.args.join(', '));
}

function addMcpRow(name='', command='', args='') {
  const list = document.getElementById('m-mcps-list');
  const row = document.createElement('div');
  row.className = 'flex gap-2 items-start bg-surface/50 border border-border rounded-lg p-2';
  row.innerHTML = `
    <div class="flex-1 space-y-1.5">
      <input class="mcp-name w-full bg-surface border border-border rounded px-2 py-1 text-xs focus:outline-none focus:border-accent/50 transition" placeholder="Nome (ex: browser)" value="${escHtml(name)}">
      <input class="mcp-cmd w-full bg-surface border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-accent/50 transition" placeholder="Comando (ex: uv)" value="${escHtml(command)}">
      <input class="mcp-args w-full bg-surface border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-accent/50 transition" placeholder="Args separados por vírgula" value="${escHtml(args)}">
    </div>
    <button onclick="this.parentElement.remove()" aria-label="Remover MCP" class="text-muted hover:text-red-400 text-xs mt-1 px-1">✕</button>`;
  list.appendChild(row);
}

function getMcpsFromForm() {
  const mcps = {};
  document.querySelectorAll('#m-mcps-list > div').forEach(row => {
    const name = row.querySelector('.mcp-name').value.trim();
    const cmd = row.querySelector('.mcp-cmd').value.trim();
    const argsRaw = row.querySelector('.mcp-args').value.trim();
    if (!name || !cmd) return;
    mcps[name] = { command: cmd, args: argsRaw ? argsRaw.split(',').map(s => s.trim()) : [], timeout: 120000 };
  });
  return mcps;
}

function populateMcpRows(mcps) {
  document.getElementById('m-mcps-list').innerHTML = '';
  if (!mcps) return;
  for (const [name, cfg] of Object.entries(mcps)) {
    addMcpRow(name, cfg.command || '', (cfg.args || []).join(', '));
  }
}
