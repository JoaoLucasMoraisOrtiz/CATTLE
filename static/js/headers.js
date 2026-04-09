/* ReDo! — Headers CRUD */

async function loadHeaders() {
  headersList = await (await fetch(`${API}/headers`)).json();
  renderHeaders();
  loadPlaceholders();
}

async function loadPlaceholders() {
  const phs = await (await fetch(`${API}/headers/placeholders`)).json();
  document.getElementById('placeholder-list').innerHTML = Object.entries(phs).map(([type, list]) =>
    `<div class="mb-2"><div class="text-muted text-[9px] uppercase mb-1">${escHtml(type)}</div>` +
    list.map(p => `<button onclick="insertPlaceholder('${escHtml(p)}')" class="block w-full text-left px-2 py-1.5 rounded bg-surface border border-border hover:border-accent/30 text-accent font-mono transition text-[10px] mb-1">${escHtml(p)}</button>`).join('') +
    `</div>`
  ).join('');
}

function insertPlaceholder(ph) {
  const ta = document.getElementById('h-content');
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + ph + ta.value.slice(e);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + ph.length;
}

function renderHeaders() {
  const el = document.getElementById('header-list');
  if (!headersList.length) { el.innerHTML = '<p class="text-center text-muted text-xs py-8">Nenhum header</p>'; return; }
  const typeColors = {protocol:'#7c5cfc', wrapper:'#10b981', handoff:'#f59e0b'};
  const typeLabels = {protocol:'Protocol', wrapper:'Wrapper', handoff:'Handoff'};
  el.innerHTML = headersList.map(h => {
    const isSel = selectedHeaderId === h.id;
    const tc = typeColors[h.type] || '#888';
    return `<div class="group flex flex-col gap-1 px-3 py-2.5 rounded-xl cursor-pointer transition ${isSel ? 'bg-accent/10 border border-accent/30' : 'hover:bg-surface/60 border border-transparent'}" onclick="selectHeader('${escHtml(h.id)}')">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-white">${escHtml(h.name)}</span>
        <span class="text-[9px] px-1.5 py-0.5 rounded-full" style="background:${tc}22;color:${tc}">${typeLabels[h.type]||h.type}</span>
        ${h.is_default ? '<span class="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full">★ default</span>' : ''}
      </div>
      <div class="text-xs text-muted truncate">${escHtml(h.description || h.content.slice(0, 60))}</div>
      <div class="hidden group-hover:flex gap-1 mt-1">
        <button onclick="event.stopPropagation();editHeader('${escHtml(h.id)}')" class="text-[10px] px-2 py-0.5 rounded bg-surface border border-border hover:border-accent/30 text-muted hover:text-white transition">✎ Editar</button>
        <button onclick="event.stopPropagation();deleteHeader('${escHtml(h.id)}')" class="text-[10px] px-2 py-0.5 rounded bg-surface border border-border hover:border-red-500/30 text-muted hover:text-red-400 transition">✕ Remover</button>
      </div>
    </div>`;
  }).join('');
}

function selectHeader(id) {
  selectedHeaderId = id;
  renderHeaders();
  const h = headersList.find(x => x.id === id);
  if (!h) return;
  const area = document.getElementById('header-editor-area');
  area.innerHTML = `<div class="border-b border-border px-5 py-3 bg-card/10">
    <div class="flex items-center gap-2"><span class="text-sm font-medium text-white">${escHtml(h.name)}</span>
    ${DEFAULT_HEADER_IDS.includes(h.id) ? '<span class="text-[9px] bg-accent/20 text-accent px-1.5 py-0.5 rounded-full">default</span>' : ''}</div>
    <div class="text-xs text-muted mt-0.5">${escHtml(h.description)}</div>
  </div>
  <div class="flex-1 overflow-y-auto p-5"><pre class="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">${escHtml(h.content)}</pre></div>`;
}

function openHeaderModal(header = null) {
  editingHeaderId = header ? header.id : null;
  document.getElementById('header-modal-title').textContent = header ? 'Editar Header' : 'Novo Header';
  document.getElementById('h-id').value = header?.id || '';
  document.getElementById('h-id').disabled = !!header;
  document.getElementById('h-name').value = header?.name || '';
  document.getElementById('h-desc').value = header?.description || '';
  document.getElementById('h-content').value = header?.content || '';
  document.getElementById('h-type').value = header?.type || 'protocol';
  document.getElementById('h-default').checked = header?.is_default || false;
  document.getElementById('header-modal').classList.remove('hidden');
}

function closeHeaderModal() { document.getElementById('header-modal').classList.add('hidden'); editingHeaderId = null; }
function editHeader(id) { const h = headersList.find(x => x.id === id); if (h) openHeaderModal(h); }

async function saveHeader() {
  const body = {
    id: document.getElementById('h-id').value.trim(),
    name: document.getElementById('h-name').value.trim(),
    description: document.getElementById('h-desc').value.trim(),
    content: document.getElementById('h-content').value,
    type: document.getElementById('h-type').value,
    is_default: document.getElementById('h-default').checked,
  };
  if (!body.id || !body.name) return;
  await fetch(editingHeaderId ? `${API}/headers/${editingHeaderId}` : `${API}/headers`, {
    method: editingHeaderId ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if (body.is_default) {
    await fetch(`${API}/headers/${body.id}/set-default`, { method: 'POST' });
  }
  closeHeaderModal();
  await loadHeaders();
  selectHeader(body.id);
}

async function deleteHeader(id) {
  if (!confirm(`Remover header "${id}"?`)) return;
  await fetch(`${API}/headers/${id}`, { method: 'DELETE' });
  if (selectedHeaderId === id) selectedHeaderId = null;
  loadHeaders();
}

// ── Flow node header selection ───────────────────────────────────────────

function getNodeHeaderIds(agentId) { return nodeHeaderIds[agentId] || []; }
function setNodeHeaderIds(agentId, ids) { nodeHeaderIds[agentId] = ids; saveFlow(); }

function renderHeaderMultiSelect(agentId) {
  const selected = getNodeHeaderIds(agentId);
  return `<div class="border-t border-border/50 mt-2 pt-2">
    <div class="text-[10px] text-muted mb-1">Headers</div>
    ${headersList.map(h => {
      const checked = selected.includes(h.id) ? 'checked' : '';
      return `<label class="flex items-center gap-1.5 text-[10px] text-gray-400 py-0.5 cursor-pointer hover:text-white">
        <input type="checkbox" ${checked} onchange="toggleNodeHeader('${escHtml(agentId)}','${escHtml(h.id)}',this.checked)" class="rounded border-border bg-surface accent-accent w-3 h-3">
        ${escHtml(h.name)}</label>`;
    }).join('')}
  </div>`;
}

function toggleNodeHeader(agentId, headerId, checked) {
  let ids = getNodeHeaderIds(agentId);
  if (checked && !ids.includes(headerId)) ids.push(headerId);
  else ids = ids.filter(x => x !== headerId);
  setNodeHeaderIds(agentId, ids);
}
