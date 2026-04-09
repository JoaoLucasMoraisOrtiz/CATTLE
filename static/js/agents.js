/* ReDo! — Agents CRUD */

async function loadAgents() {
  agents = await (await fetch(`${API}/agents`)).json();
  renderAgents();
  renderPalette();
}

function renderAgents() {
  const el = document.getElementById('agent-list');
  if (!agents.length) { el.innerHTML = '<p class="text-center text-muted text-xs py-8">Nenhum agente</p>'; return; }
  el.innerHTML = agents.map(a => `
    <div class="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface/60 cursor-pointer transition" onclick="editAgent('${a.id}')">
      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${a.color}"></span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-white truncate">${a.name}</div>
        <div class="text-xs text-muted truncate">${a.persona.slice(0,50)}...</div>
      </div>
      <div class="hidden group-hover:flex gap-1">
        <button onclick="event.stopPropagation();editAgent('${a.id}')" class="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-white hover:bg-border/50 transition text-xs">✎</button>
        <button onclick="event.stopPropagation();deleteAgent('${a.id}')" class="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-red-400 hover:bg-red-500/10 transition text-xs">✕</button>
      </div>
    </div>`).join('');
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
  const mcps = getMcpsFromForm();
  const body = {
    id: document.getElementById('m-id').value.trim(),
    name: document.getElementById('m-name').value.trim(),
    color: document.getElementById('m-color').value,
    model: document.getElementById('m-model').value.trim() || null,
    persona: document.getElementById('m-persona').value.trim(),
    mcps,
  };
  if (!body.id || !body.name || !body.persona) return;
  await fetch(editingId ? `${API}/agents/${editingId}` : `${API}/agents`, {
    method: editingId ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  closeModal(); loadAgents();
}

async function deleteAgent(id) {
  if (!confirm(`Remover "${id}"?`)) return;
  await fetch(`${API}/agents/${id}`, { method: 'DELETE' }); loadAgents();
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
    <button onclick="this.parentElement.remove()" class="text-muted hover:text-red-400 text-xs mt-1 px-1">✕</button>`;
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
