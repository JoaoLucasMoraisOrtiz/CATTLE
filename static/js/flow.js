/* ReDo! — Flow (Drawflow) management */

async function loadFlows() {
  flows = await (await fetch(`${API}/flows`)).json();
  const opts = flows.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('');
  for (const sel of [document.getElementById('flow-select'), document.getElementById('run-flow-select')]) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Nenhum flow</option>' + opts;
    if (flows.find(f => f.id === cur)) sel.value = cur;
    else if (flows.length) sel.value = flows[0].id;
  }
  if (!currentFlowId && flows.length) currentFlowId = flows[0].id;
  document.getElementById('flow-select').value = currentFlowId || '';
}

function onFlowSelect() {
  currentFlowId = document.getElementById('flow-select').value || null;
  if (drawflowReady && currentFlowId) loadFlow();
}

async function createFlow() {
  const name = prompt('Nome do novo flow:');
  if (!name) return;
  const id = slugify(name);
  await fetch(`${API}/flows`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id, name, nodes:[], edges:[], start_node:''}) });
  await loadFlows();
  currentFlowId = id;
  document.getElementById('flow-select').value = id;
  if (drawflowReady) loadFlow();
}

async function deleteFlow() {
  if (!currentFlowId || !confirm('Remover este flow?')) return;
  await fetch(`${API}/flows/${currentFlowId}`, {method:'DELETE'});
  currentFlowId = null;
  await loadFlows();
  if (drawflowReady) { if (currentFlowId) loadFlow(); else editor.clear(); }
}

async function renameFlow() {
  if (!currentFlowId) return;
  const fd = flows.find(f => f.id === currentFlowId);
  if (!fd) return;
  const name = prompt('Novo nome:', fd.name);
  if (!name || name === fd.name) return;
  fd.name = name;
  await fetch(`${API}/flows/${currentFlowId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fd) });
  await loadFlows();
}

async function duplicateFlow() {
  if (!currentFlowId) return;
  const fd = flows.find(f => f.id === currentFlowId);
  if (!fd) return;
  const name = prompt('Nome da cópia:', fd.name + ' (cópia)');
  if (!name) return;
  const id = slugify(name);
  await fetch(`${API}/flows`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...fd, id, name}) });
  await loadFlows();
  currentFlowId = id;
  document.getElementById('flow-select').value = id;
  if (drawflowReady) loadFlow();
}

// ── Drawflow ─────────────────────────────────────────────────────────────

function renderPalette() {
  const el = document.getElementById('flow-palette');
  el.innerHTML = '<div class="text-xs text-muted uppercase tracking-wider mb-2">Arrastar para o canvas</div>' +
    agents.map(a => `
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface border border-border cursor-grab hover:border-accent/30 transition text-xs"
           draggable="true" ondragstart="dragStart(event,'${a.id}')">
        <span class="w-2 h-2 rounded-full" style="background:${a.color}"></span>
        <span class="text-white font-medium">${a.name}</span>
      </div>`).join('');
}

function dragStart(ev, agentId) { ev.dataTransfer.setData('agentId', agentId); }

function nodeHtml(a, isStart) {
  return `<div class="node-inner">
    <div class="node-title"><span class="w-2 h-2 rounded-full" style="background:${a.color}"></span>${isStart ? '⚡ ' : ''}${a.name}</div>
    <div class="node-sub">${a.id}${isStart ? ' · início' : ''}</div>
  </div>`;
}

function refreshStartBadges() {
  const raw = editor.drawflow.drawflow.Home.data;
  for (const [nid, n] of Object.entries(raw)) {
    const a = agents.find(x => x.id === n.data?.agentId);
    if (!a) continue;
    const isStart = n.data.agentId === startNodeId;
    const el = document.getElementById('node-' + nid);
    if (el) {
      const content = el.querySelector('.drawflow_content_node');
      if (content) content.innerHTML = nodeHtml(a, isStart);
    }
    el?.style.setProperty('border-color', isStart ? '#7c5cfc' : '#2a2a35');
    el?.style.setProperty('border-width', isStart ? '2px' : '1px');
  }
}

function initDrawflow() {
  if (drawflowReady) return;
  drawflowReady = true;
  const container = document.getElementById('drawflow');
  editor = new Drawflow(container);
  editor.reroute = true;
  editor.curvature = 0.3;
  editor.reroute_curvature_start_end = 0.3;
  editor.reroute_curvature = 0.3;
  editor.start();

  const svg = container.querySelector('svg');
  if (svg) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg','defs');
    defs.innerHTML = '<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#7c5cfc"/></marker>';
    svg.prepend(defs);
  }

  container.addEventListener('drop', ev => {
    ev.preventDefault();
    const agentId = ev.dataTransfer.getData('agentId');
    const a = agents.find(x => x.id === agentId);
    if (!a) return;
    const existing = Object.values(editor.drawflow.drawflow.Home.data);
    if (existing.some(n => n.data?.agentId === agentId)) return;
    const rect = container.getBoundingClientRect();
    const isFirst = Object.keys(editor.drawflow.drawflow.Home.data).length === 0;
    if (isFirst) startNodeId = agentId;
    editor.addNode(a.name, 1, 1, ev.clientX - rect.left, ev.clientY - rect.top, agentId, { agentId }, nodeHtml(a, agentId === startNodeId));
    if (isFirst) refreshStartBadges();
  });
  container.addEventListener('dragover', ev => ev.preventDefault());

  editor.on('nodeSelected', function(nodeId) {
    container._selectedNodeId = nodeId;
    showEdgePanel(nodeId);
  });
  editor.on('nodeUnselected', function() { hideEdgePanel(); });
  container.addEventListener('dblclick', () => {
    const nodeId = container._selectedNodeId;
    if (!nodeId) return;
    const n = editor.drawflow.drawflow.Home.data[nodeId];
    if (!n?.data?.agentId) return;
    startNodeId = n.data.agentId;
    refreshStartBadges();
    saveFlow();
    document.getElementById('flow-info').textContent = `⚡ Início: ${n.name}`;
  });

  // Edge panel
  const edgePanel = document.createElement('div');
  edgePanel.id = 'edge-panel';
  edgePanel.className = 'absolute z-50 bg-card border border-border rounded-xl shadow-lg p-3 text-xs hidden';
  edgePanel.style.minWidth = '200px';
  container.style.position = 'relative';
  container.appendChild(edgePanel);

  window.showEdgePanel = function(nodeId) {
    const raw = editor.drawflow.drawflow.Home.data;
    const n = raw[nodeId];
    if (!n?.data?.agentId) { hideEdgePanel(); return; }
    const src = n.data.agentId;
    const conns = n.outputs?.output_1?.connections || [];
    const srcAgent = agents.find(a => a.id === src);
    let html = `<div class="text-white font-medium mb-2">${escHtml(srcAgent?.name||src)}</div>`;
    if (conns.length) {
      html += `<div class="text-[10px] text-muted mb-1">Conexões</div>`;
      for (const c of conns) {
        const dstNode = raw[c.node];
        if (!dstNode?.data?.agentId) continue;
        const dst = dstNode.data.agentId;
        const dstAgent = agents.find(a => a.id === dst);
        const key = src + '->' + dst;
        const isReturn = returnEdges.has(key);
        html += `<div class="flex items-center justify-between py-1.5 border-t border-border/50">
          <span class="text-gray-400">→ ${escHtml(dstAgent?.name||dst)}</span>
          <button onclick="toggleReturnEdge('${escHtml(src)}','${escHtml(dst)}')" class="px-2 py-0.5 rounded text-[10px] font-medium ${isReturn ? 'bg-amber-500/20 text-amber-400' : 'bg-surface text-muted hover:text-white'}">
            ${isReturn ? '↩ Return' : '→ Normal'}
          </button>
        </div>`;
      }
    }
    html += renderHeaderMultiSelect(src);
    edgePanel.innerHTML = html;
    edgePanel.classList.remove('hidden');
    const el = document.getElementById('node-' + nodeId);
    if (el) {
      edgePanel.style.left = (n.pos_x + 220) + 'px';
      edgePanel.style.top = n.pos_y + 'px';
    }
  };

  window.hideEdgePanel = function() { edgePanel.classList.add('hidden'); };

  window.toggleReturnEdge = function(src, dst) {
    const key = src + '->' + dst;
    if (returnEdges.has(key)) returnEdges.delete(key); else returnEdges.add(key);
    styleReturnEdges();
    saveFlow();
    if (container._selectedNodeId) showEdgePanel(container._selectedNodeId);
  };

  editor.on('nodeCreated', () => saveFlow());
  editor.on('nodeRemoved', () => saveFlow());
  editor.on('connectionCreated', () => { saveFlow(); setTimeout(styleReturnEdges, 50); });
  editor.on('connectionRemoved', () => saveFlow());
  editor.on('nodeMoved', () => { saveFlow(); setTimeout(styleReturnEdges, 50); });

  window.styleReturnEdges = function() {
    const raw = editor.drawflow.drawflow.Home.data;
    container.querySelectorAll('.connection').forEach(conn => {
      const cls = conn.classList;
      const nodeOut = [...cls].find(c => c.startsWith('node_out_'))?.replace('node_out_node-','');
      const nodeIn = [...cls].find(c => c.startsWith('node_in_'))?.replace('node_in_node-','');
      if (!nodeOut || !nodeIn) return;
      const src = raw[nodeOut]?.data?.agentId;
      const dst = raw[nodeIn]?.data?.agentId;
      if (!src || !dst) return;
      const isReturn = returnEdges.has(src + '->' + dst);
      const path = conn.querySelector('.main-path');
      if (path) {
        if (isReturn) {
          path.style.setProperty('stroke', '#f59e0b', 'important');
          path.style.setProperty('stroke-dasharray', '8 4', 'important');
        } else {
          path.style.removeProperty('stroke');
          path.style.removeProperty('stroke-dasharray');
        }
      }
    });
  };

  loadFlow();
}

async function loadFlow() {
  if (!currentFlowId) return;
  const fd = flows.find(f => f.id === currentFlowId);
  if (!fd) return;
  startNodeId = fd.start_node || '';
  flowDefaultHeaderIds = fd.default_header_ids || [];
  nodeHeaderIds = {};
  editor.clear();
  if (!fd.nodes.length) return;
  const idMap = {};
  for (const n of fd.nodes) {
    const a = agents.find(x => x.id === n.agent_id);
    if (!a) continue;
    if (!startNodeId) startNodeId = n.agent_id;
    if (n.header_ids && n.header_ids.length) nodeHeaderIds[n.agent_id] = n.header_ids;
    const nid = editor.addNode(a.name, 1, 1, n.x, n.y, a.id, { agentId: a.id }, nodeHtml(a, n.agent_id === startNodeId));
    idMap[n.agent_id] = nid;
  }
  returnEdges.clear();
  for (const e of fd.edges) {
    if (e.returns) returnEdges.add(e.src + '->' + e.dst);
  }
  for (const e of fd.edges) {
    if (idMap[e.src] && idMap[e.dst]) {
      editor.addConnection(idMap[e.src], idMap[e.dst], 'output_1', 'input_1');
    }
  }
  refreshStartBadges();
  setTimeout(styleReturnEdges, 100);
}

let _saveFlowTimer = null;
let _saveFlowRunning = false;
function saveFlow() {
  clearTimeout(_saveFlowTimer);
  _saveFlowTimer = setTimeout(_doSaveFlow, 500);
}

async function _doSaveFlow() {
  if (_saveFlowRunning || !currentFlowId) return;
  _saveFlowRunning = true;
  try {
    const raw = editor.drawflow.drawflow.Home.data;
    const nodes = []; const edges = [];
    const nodeIdToAgent = {};
    for (const [nid, n] of Object.entries(raw)) {
      const hids = nodeHeaderIds[n.data.agentId] || [];
      nodes.push({ agent_id: n.data.agentId, x: n.pos_x, y: n.pos_y, header_ids: hids });
      nodeIdToAgent[nid] = n.data.agentId;
    }
    for (const [nid, n] of Object.entries(raw)) {
      const conns = n.outputs?.output_1?.connections || [];
      for (const c of conns) {
        edges.push({ src: nodeIdToAgent[nid], dst: nodeIdToAgent[c.node], returns: returnEdges.has(nodeIdToAgent[nid] + '->' + nodeIdToAgent[c.node]) });
      }
    }
    const fd = flows.find(f => f.id === currentFlowId);
    const name = fd ? fd.name : 'Default';
    await fetch(`${API}/flows/${currentFlowId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: currentFlowId, name, nodes, edges, start_node: startNodeId, default_header_ids: flowDefaultHeaderIds }) });
    if (fd) { fd.nodes = nodes; fd.edges = edges; fd.start_node = startNodeId; }
    document.getElementById('flow-info').textContent = `✓ Salvo: ${nodes.length} nós, ${edges.length} conexões, início: ${startNodeId}`;
  } finally { _saveFlowRunning = false; }
}

function autoLayout() {
  const raw = editor.drawflow.drawflow.Home.data;
  const ids = Object.keys(raw);
  const cols = Math.ceil(Math.sqrt(ids.length));
  ids.forEach((id, i) => {
    const x = 80 + (i % cols) * 250;
    const y = 80 + Math.floor(i / cols) * 150;
    const el = document.getElementById('node-' + id);
    if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; raw[id].pos_x = x; raw[id].pos_y = y; }
  });
  editor.updateConnectionNodes('node-' + ids[0]);
}
