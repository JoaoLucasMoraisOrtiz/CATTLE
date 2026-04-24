// ReDo! v2 — Prompt Builder (panel above terminal)
// File references only (file:L1-L2) — agent reads with its own tools

let pbSymbols = [];
let pbSelected = new Set();
let pbEdges = [];  // {from, to}
let pbPanelOpen = false;

function togglePromptBuilder() {
  pbPanelOpen = !pbPanelOpen;
  document.getElementById('pb-panel').style.display = pbPanelOpen ? 'flex' : 'none';
  document.getElementById('input-area').style.display = pbPanelOpen ? 'none' : '';
  document.getElementById('pb-pill').style.color = pbPanelOpen ? '#58a6ff' : '';
  if (pbPanelOpen) {
    // Copy input text to intent if user typed something
    const input = document.getElementById('input');
    const intent = document.getElementById('pb-intent');
    if (input.value.trim() && !intent.value.trim()) {
      intent.value = input.value.trim();
    }
    intent.focus();
  }
}

async function pbSearch() {
  const text = document.getElementById('pb-intent').value.trim();
  if (text.length < 3) { alert('Type what you want to do first'); return; }
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  document.getElementById('pb-status').textContent = '⏳ Searching...';
  pbSymbols = [];
  pbSelected = new Set();
  pbEdges = [];

  const suggestions = await window.go.main.App.SuggestSymbols(proj.name, text);
  pbSymbols = suggestions || [];

  document.getElementById('pb-status').textContent = pbSymbols.length
    ? `${pbSymbols.length} found — click to select, right-click for details`
    : 'No relevant code found';

  renderPBNodes();
  renderPBPromptPreview();
}

function renderPBNodes() {
  const container = document.getElementById('pb-nodes');
  if (!container) return;

  container.innerHTML = pbSymbols.map((s, i) => {
    const icon = s.kind === 'kb' ? '📚' : s.kind === 'class' ? '🟢' : '🔵';
    const end = s.end_line || (parseInt(s.line || '0') + 20);
    const ref = s.kind !== 'kb' ? `${s.file}:${s.line}-${end}` : s.file;
    return `<div class="pb-node ${pbSelected.has(i) ? 'selected' : ''}"
      onclick="pbToggle(${i})" oncontextmenu="event.preventDefault(); pbNodeMenu(event, ${i})">
      <span>${icon} <b>${s.name}</b></span>
      <span class="pb-ref">${ref}</span>
    </div>`;
  }).join('');

  renderPBGraph();
}

function pbToggle(idx) {
  if (pbSelected.has(idx)) pbSelected.delete(idx);
  else pbSelected.add(idx);
  renderPBNodes();
  renderPBPromptPreview();
}

function pbNodeMenu(event, idx) {
  document.getElementById('node-menu')?.remove();
  const s = pbSymbols[idx];
  const menu = document.createElement('div');
  menu.id = 'node-menu';
  menu.className = 'node-menu';
  menu.innerHTML = `
    <div class="nm-title">${s.kind} ${s.name}</div>
    <div class="nm-item" onclick="pbViewCode(${idx})">📄 View Code</div>
    <div class="nm-item" onclick="pbExplain(${idx})">🧠 Explain</div>
    <div class="nm-item" onclick="pbExpand(${idx})">🔗 Expand Connections</div>
    <div class="nm-item" onclick="pbToggle(${idx}); document.getElementById('node-menu').remove()">
      ${pbSelected.has(idx) ? '✕ Deselect' : '✓ Select'}
    </div>
  `;
  menu.style.left = event.pageX + 'px';
  menu.style.top = event.pageY + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

async function pbViewCode(idx) {
  document.getElementById('node-menu')?.remove();
  const s = pbSymbols[idx];
  if (!s || s.kind === 'kb') return;

  // Fetch actual code from backend
  const proj = projects[openedProjects[activeTab]];
  const code = await window.go.main.App.ReadSymbolCode(proj.name, s.file, parseInt(s.line), parseInt(s.end_line || s.line) + 20);

  let modal = document.getElementById('diff-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'diff-modal-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="diff-modal">
    <div class="diff-modal-header">
      <span>${s.kind} ${s.name} — ${s.file}:${s.line}</span>
      <span style="cursor:pointer" onclick="document.getElementById('diff-modal').style.display='none'">✕</span>
    </div>
    <div class="diff-modal-body"><pre style="margin:0">${escapeHtml(code || 'Could not read file')}</pre></div>
  </div>`;
  modal.style.display = 'flex';
}


async function pbExpand(idx) {
  document.getElementById('node-menu')?.remove();
  const s = pbSymbols[idx];
  if (!s || s.kind === 'kb' || activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  document.getElementById('pb-status').textContent = '⏳ Expanding...';
  const connections = await window.go.main.App.ExpandSymbol(proj.name, s.name, s.file);
  document.getElementById('pb-status').textContent = '';

  if (!connections || connections.length === 0) return;

  // Add new symbols, avoid duplicates
  const existing = new Set(pbSymbols.map(x => x.name));
  let added = 0;
  for (const c of connections) {
    if (!existing.has(c.name)) {
      pbSymbols.push(c);
      existing.add(c.name);
      added++;
    }
    // Add edge
    if (c.edge_from && c.edge_to) {
      const dup = pbEdges.some(e => e.from === c.edge_from && e.to === c.edge_to);
      if (!dup) pbEdges.push({ from: c.edge_from, to: c.edge_to });
    }
  }
  if (added > 0) {
    document.getElementById('pb-status').textContent = `+${added} connections`;
    renderPBNodes();
    renderPBPromptPreview();
  }
}
async function pbExplain(idx) {
  document.getElementById('node-menu')?.remove();
  const s = pbSymbols[idx];
  if (!s) return;

  // Build explain prompt and show agent picker
  const end = s.end_line || (parseInt(s.line || '0') + 20);
  const ref = s.kind !== 'kb' ? `${s.file}:${s.line}-${end}` : s.file;
  window._multiExplainPrompt = `Explain what this ${s.kind} does: \`${s.name}\` in ${ref}. Be concise.`;
  window._showAgentPicker();
}


function pbClearGraph() {
  pbSymbols = [];
  pbSelected = new Set();
  pbEdges = [];
  renderPBNodes();
  renderPBGraph();
  renderPBPromptPreview();
  document.getElementById('pb-status').textContent = '';
}

async function pbSymSearch() {
  const q = document.getElementById('pb-sym-search').value.trim();
  if (q.length < 2 || activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  document.getElementById('pb-status').textContent = '⏳ Searching symbols...';
  const results = await window.go.main.App.SearchSymbol(proj.name, q);
  document.getElementById('pb-status').textContent = '';

  if (!results || results.length === 0) {
    document.getElementById('pb-status').textContent = 'No symbols found for "' + q + '"';
    return;
  }

  const existing = new Set(pbSymbols.map(x => x.name + x.file));
  let added = 0;
  for (const r of results) {
    if (!existing.has(r.name + r.file)) {
      pbSymbols.push(r);
      existing.add(r.name + r.file);
      added++;
    }
  }
  document.getElementById('pb-status').textContent = `+${added} symbols found`;
  document.getElementById('pb-sym-search').value = '';
  renderPBNodes();
  renderPBPromptPreview();
}
function renderPBPromptPreview() {
  const ta = document.getElementById('pb-prompt');
  if (!ta) return;
  const intent = document.getElementById('pb-intent')?.value.trim() || '';

  let parts = [];
  if (intent) parts.push('## Task\n' + intent);

  if (pbSelected.size > 0) {
    parts.push('\n## Relevant Files (use your file read tool to inspect)');
    for (const i of [...pbSelected].sort()) {
      const s = pbSymbols[i];
      const end = s.end_line || (parseInt(s.line || '0') + 20);
      if (s.kind === 'kb') {
        parts.push(`- 📚 ${s.file} (knowledge base)`);
      } else {
        parts.push(`- ${s.kind} \`${s.name}\` → ${s.file}:${s.line}-${end}`);
      }
    }
  }

  ta.value = parts.join('\n');
}

function renderPBGraph() {
  const container = document.getElementById('pb-graph');
  if (!container || pbSymbols.length === 0) { if (container) container.innerHTML = ''; return; }

  container.innerHTML = '';
  const w = container.clientWidth || 300;
  const h = container.clientHeight || 200;

  const svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
  const g = svg.append('g');

  // Zoom + pan
  svg.call(d3.zoom().scaleExtent([0.3, 5]).on('zoom', (ev) => {
    g.attr('transform', ev.transform);
  }));

  const nodes = pbSymbols.map((s, i) => ({
    id: s.name, index: i, kind: s.kind, selected: pbSelected.has(i)
  }));

  // Build links from pbEdges
  const nameToIdx = {};
  nodes.forEach((n, i) => nameToIdx[n.id] = i);
  const links = pbEdges
    .filter(e => nameToIdx[e.from] !== undefined && nameToIdx[e.to] !== undefined)
    .map(e => ({ source: nameToIdx[e.from], target: nameToIdx[e.to] }));

  const sim = d3.forceSimulation(nodes)
    .force('charge', d3.forceManyBody().strength(-60))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(25))
    .force('link', d3.forceLink(links).distance(80));

  // Arrow marker
  g.append('defs').append('marker')
    .attr('id', 'pb-arrow').attr('viewBox', '0 0 10 6')
    .attr('refX', 18).attr('refY', 3)
    .attr('markerWidth', 8).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,0L10,3L0,6').attr('fill', '#484f58');

  const link = g.selectAll('line.pb-edge').data(links).enter().append('line')
    .attr('class', 'pb-edge')
    .attr('stroke', '#484f58').attr('stroke-width', 1.5)
    .attr('marker-end', 'url(#pb-arrow)');

  const node = g.selectAll('g.pb-node-g').data(nodes).enter().append('g')
    .attr('class', 'pb-node-g')
    .style('cursor', 'pointer')
    .on('click', (ev, d) => pbToggle(d.index))
    .on('contextmenu', (ev, d) => { ev.preventDefault(); pbNodeMenu(ev, d.index); })
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  node.append('circle')
    .attr('r', d => d.kind === 'class' ? 10 : 7)
    .attr('fill', d => d.selected ? '#3fb950' : (d.kind === 'class' ? '#1f6feb' : '#8b949e'))
    .attr('stroke', d => d.selected ? '#3fb950' : '#30363d')
    .attr('stroke-width', 2);

  node.append('text')
    .text(d => d.id)
    .attr('dy', -12).attr('text-anchor', 'middle')
    .attr('fill', '#c9d1d9').attr('font-size', '9px');

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

function pbSend() {
  const prompt = document.getElementById('pb-prompt').value;
  if (!prompt.trim()) return;
  window._multiExplainPrompt = prompt;

  // Save selection as knowledge
  if (pbSelected.size > 0 && activeTab >= 0) {
    const proj = projects[openedProjects[activeTab]];
    const intent = document.getElementById('pb-intent')?.value.trim() || '';
    const names = [...pbSelected].map(i => pbSymbols[i].name);
    window.go.main.App.BuildPrompt(proj.name, '', intent, names);
  }

  window._showAgentPicker();
}

function pbCopy() {
  const ta = document.getElementById('pb-prompt');
  ta.select();
  document.execCommand('copy');
}

// --- Resize ---
function startResizePB(e) {
  e.preventDefault();
  const panel = document.getElementById('pb-panel');
  const startY = e.clientY;
  const startH = panel.offsetHeight;
  function onMove(ev) {
    const newH = Math.max(150, Math.min(window.innerHeight - 60, startH + (startY - ev.clientY)));
    panel.style.height = newH + 'px';
  }
  function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Vertical: left | right
function startResizePBV(e) {
  e.preventDefault();
  const left = document.getElementById('pb-left');
  const container = document.getElementById('pb-container');
  const startX = e.clientX;
  const startW = left.offsetWidth;
  function onMove(ev) {
    const newW = Math.max(120, Math.min(container.offsetWidth - 150, startW + (ev.clientX - startX)));
    left.style.width = newW + 'px';
    left.style.flex = 'none';
  }
  function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Horizontal: nodes | graph
function startResizePBH(e) {
  e.preventDefault();
  const nodes = document.getElementById('pb-nodes');
  const left = document.getElementById('pb-left');
  const startY = e.clientY;
  const startH = nodes.offsetHeight;
  function onMove(ev) {
    const newH = Math.max(40, Math.min(left.offsetHeight - 80, startH + (ev.clientY - startY)));
    nodes.style.flex = 'none';
    nodes.style.height = newH + 'px';
  }
  function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
