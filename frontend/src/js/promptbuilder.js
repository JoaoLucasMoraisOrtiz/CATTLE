// ReDo! v2 — Prompt Builder Tab
// Full-screen tab with graph + prompt editor + file references (no code, save tokens)

let pbSymbols = [];      // suggested symbols from SuggestSymbols
let pbSelected = new Set(); // selected indices
let pbIntent = '';        // user's original prompt
let pbGraph = null;       // D3 graph instance
let pbOpen = false;

async function openPromptBuilder() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (text.length < 3) { alert('Type your prompt first, then click 🔍'); return; }
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  pbIntent = text;
  pbSelected = new Set();

  // Show the tab immediately with loading state
  pbOpen = true;
  renderPromptBuilderTab();
  document.getElementById('pb-status').textContent = '⏳ Searching relevant code...';

  const suggestions = await window.go.main.App.SuggestSymbols(proj.name, text);
  pbSymbols = suggestions || [];

  if (pbSymbols.length === 0) {
    document.getElementById('pb-status').textContent = 'No relevant code found. You can still edit and send the prompt.';
  } else {
    document.getElementById('pb-status').textContent = `Found ${pbSymbols.length} relevant symbols. Click to select.`;
  }

  renderPBNodes();
  renderPBPromptPreview();
}

function renderPromptBuilderTab() {
  // Hide workspace, show prompt builder
  const ws = document.getElementById('workspace');
  if (ws) ws.style.display = 'none';
  const home = document.getElementById('home-screen');
  if (home) home.style.display = 'none';

  let container = document.getElementById('prompt-builder-tab');
  if (!container) {
    container = document.createElement('div');
    container.id = 'prompt-builder-tab';
    document.getElementById('app').appendChild(container);
  }
  container.style.display = 'flex';
  container.innerHTML = `
    <div id="pb-left">
      <div class="pb-section-header">📍 Relevant Symbols <span id="pb-status" style="font-weight:normal;color:#8b949e;font-size:11px"></span></div>
      <div id="pb-nodes"></div>
      <div class="pb-section-header" style="margin-top:12px">🔗 Graph</div>
      <div id="pb-graph"></div>
    </div>
    <div id="pb-right">
      <div class="pb-section-header">📝 Prompt Preview</div>
      <textarea id="pb-prompt" rows="20" spellcheck="false"></textarea>
      <div id="pb-actions">
        <button class="btn-spawn" onclick="pbSend()">💬 Send to Agent</button>
        <button class="btn-cancel" onclick="pbCopy()">📋 Copy</button>
        <button class="btn-cancel" onclick="closePromptBuilder()">✕ Close</button>
      </div>
    </div>
  `;

  // Set initial prompt
  const ta = document.getElementById('pb-prompt');
  if (ta) ta.value = '## Task\n' + pbIntent;
  ta.addEventListener('input', () => {}); // user can freely edit
}

function renderPBNodes() {
  const container = document.getElementById('pb-nodes');
  if (!container) return;

  container.innerHTML = pbSymbols.map((s, i) => {
    const icon = s.kind === 'kb' ? '📚' : s.kind === 'class' ? '🟢' : '🔵';
    const loc = s.kind !== 'kb' ? `${s.file}:${s.line}` : s.file;
    const endLine = s.end_line || (parseInt(s.line || '0') + 20);
    const ref = s.kind !== 'kb' ? `${s.file}:${s.line}-${endLine}` : s.file;
    return `<div class="pb-node ${pbSelected.has(i) ? 'selected' : ''}" onclick="pbToggle(${i})">
      <span>${icon} <b>${s.name}</b></span>
      <span class="pb-ref">${ref}</span>
      <span class="pb-score">${s.score}</span>
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

function renderPBPromptPreview() {
  const ta = document.getElementById('pb-prompt');
  if (!ta) return;

  let parts = ['## Task\n' + pbIntent];

  if (pbSelected.size > 0) {
    parts.push('\n## Relevant Files (use your file read tool to inspect)');
    for (const i of [...pbSelected].sort()) {
      const s = pbSymbols[i];
      const endLine = s.end_line || (parseInt(s.line || '0') + 20);
      if (s.kind === 'kb') {
        parts.push(`- 📚 ${s.file} (knowledge base)`);
      } else {
        parts.push(`- ${s.kind} \`${s.name}\` → ${s.file}:${s.line}-${endLine}`);
      }
    }

    // Relationships between selected
    const selectedNames = new Set([...pbSelected].map(i => pbSymbols[i].name));
    let rels = [];
    for (const i of pbSelected) {
      const s = pbSymbols[i];
      if (s.calls) {
        const calls = (typeof s.calls === 'string') ? s.calls.split(',') : [];
        for (const c of calls) {
          if (selectedNames.has(c.trim())) {
            rels.push(`- ${s.name} → ${c.trim()}`);
          }
        }
      }
    }
    if (rels.length > 0) {
      parts.push('\n## Relationships');
      parts.push(...rels);
    }
  }

  ta.value = parts.join('\n');
}

function renderPBGraph() {
  const container = document.getElementById('pb-graph');
  if (!container || pbSymbols.length === 0) return;

  container.innerHTML = '';
  const w = container.clientWidth || 400;
  const h = 250;

  const svg = d3.select(container).append('svg')
    .attr('width', w).attr('height', h);

  // Build nodes and edges from symbols
  const nodes = pbSymbols.map((s, i) => ({
    id: s.name, index: i, kind: s.kind,
    selected: pbSelected.has(i)
  }));

  const nameSet = new Set(pbSymbols.map(s => s.name));
  const edges = [];
  // We don't have call info in suggestions yet, so just show nodes
  // Future: add calls from SuggestSymbols response

  const sim = d3.forceSimulation(nodes)
    .force('charge', d3.forceManyBody().strength(-80))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(30));

  const node = svg.selectAll('g').data(nodes).enter().append('g')
    .style('cursor', 'pointer')
    .on('click', (ev, d) => { pbToggle(d.index); });

  node.append('circle')
    .attr('r', d => d.kind === 'class' ? 12 : 8)
    .attr('fill', d => d.selected ? '#3fb950' : (d.kind === 'class' ? '#1f6feb' : '#8b949e'))
    .attr('stroke', d => d.selected ? '#3fb950' : '#30363d')
    .attr('stroke-width', 2);

  node.append('text')
    .text(d => d.id)
    .attr('dy', -14)
    .attr('text-anchor', 'middle')
    .attr('fill', '#c9d1d9')
    .attr('font-size', '10px');

  sim.on('tick', () => {
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
    const selectedNames = [...pbSelected].map(i => pbSymbols[i].name);
    window.go.main.App.BuildPrompt(proj.name, '', pbIntent, selectedNames); // saves knowledge
  }

  closePromptBuilder();
  window._showAgentPicker();
}

function pbCopy() {
  const ta = document.getElementById('pb-prompt');
  ta.select();
  document.execCommand('copy');
}

function closePromptBuilder() {
  pbOpen = false;
  pbSymbols = [];
  pbSelected = new Set();
  const el = document.getElementById('prompt-builder-tab');
  if (el) el.style.display = 'none';

  // Restore workspace
  const ws = document.getElementById('workspace');
  if (ws) ws.style.display = '';
  document.getElementById('input').value = '';
}
