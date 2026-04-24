// Code Viewer — git timeline + diff viewer + resizable panel

let codePanelOpen = false;
let cvCommits = [];
let cvActiveHash = null;
let cvRepos = [];
let cvSelectedRepo = '';
let cvSelectedBranch = '';

function toggleCodePanel() {
  const panel = document.getElementById('code-panel');
  const tab = document.getElementById('code-panel-tab');
  codePanelOpen = !codePanelOpen;
  panel.style.display = codePanelOpen ? '' : 'none';
  tab.textContent = codePanelOpen ? '▶ Code' : '◀ Code';
  if (codePanelOpen) loadRepos();
}

async function loadRepos() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  cvRepos = await window.go.main.App.GetGitRepos(proj.name) || [];
  const sel = document.getElementById('cv-repo-select');
  if (cvRepos.length <= 1) {
    sel.style.display = 'none';
    cvSelectedRepo = '';
  } else {
    sel.style.display = '';
    sel.innerHTML = '<option value="">All repos</option>' +
      cvRepos.map(r => `<option value="${r}">${r}</option>`).join('');
  }
  await loadBranches();
  await loadCommits();
}

async function loadBranches() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  let branches;
  if (cvSelectedRepo) {
    branches = await window.go.main.App.GetBranchesForRepo(proj.name, cvSelectedRepo) || [];
  } else {
    branches = await window.go.main.App.GetBranches(proj.name) || [];
  }
  const sel = document.getElementById('cv-branch-select');
  const current = branches.find(b => b.current);
  cvSelectedBranch = current ? current.name : (branches[0] ? branches[0].name : '');
  sel.innerHTML = branches.map(b =>
    `<option value="${b.name}" ${b.current ? 'selected' : ''}>${b.name}${b.current ? ' ●' : ''}</option>`
  ).join('');
  await loadCommits();
}

async function onRepoChange() {
  cvSelectedRepo = document.getElementById('cv-repo-select').value;
  await loadBranches();
}

async function onBranchChange() {
  cvSelectedBranch = document.getElementById('cv-branch-select').value;
  await loadCommits();
}

function populateCommitSelect() {
  const sel = document.getElementById('cv-commit-select');
  const filtered = cvSelectedRepo
    ? cvCommits.filter(c => c.repo === cvSelectedRepo || !c.repo)
    : cvCommits;
  sel.innerHTML = '<option value="">Select commit...</option>' +
    filtered.map(c => {
      const repo = c.repo ? `[${c.repo}] ` : '';
      return `<option value="${c.hash}">${c.hash} — ${repo}${c.message.substring(0,30)}</option>`;
    }).join('');
}

function onCommitChange(hash) {
  if (hash) selectCommit(hash);
}

function switchCVTab(name, btn) {
  document.querySelectorAll('.cv-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('[id^="cv-view-"]').forEach(v => v.style.display = 'none');
  document.getElementById('cv-view-' + name).style.display = '';
  if (name === 'gitlog') loadCommits();
  if (name === 'graph' && cvActiveHash) loadGraph(cvActiveHash);
}

// --- Graph ---
async function loadGraph(hash) {
  if (!hash || activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const graph = await window.go.main.App.GetSymbolGraph(proj.name, hash);
  if (!graph || !graph.symbols || graph.symbols.length === 0) {
    document.getElementById('graph-info').textContent = 'No symbols found in changed files';
    d3.select('#graph-svg').selectAll('*').remove();
    return;
  }
  document.getElementById('graph-info').textContent = `${graph.symbols.length} symbols, ${(graph.edges||[]).length} edges`;
  renderD3Graph(graph);
}

function renderD3Graph(graph) {
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();
  const rect = svg.node().getBoundingClientRect();
  const w = rect.width || 400, h = rect.height || 400;

  svg.append('defs').append('marker')
    .attr('id', 'arrow').attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#58a6ff');

  const kindColor = { 'function': '#1f6feb', 'method': '#1f6feb', 'class': '#3fb950', 'interface': '#a371f7' };

  // All symbols deduped
  const allSymbols = {};
  for (const s of graph.symbols) {
    if (!allSymbols[s.name]) allSymbols[s.name] = s;
  }
  const allEdges = (graph.edges || []).filter(e => e.from !== e.to);

  // Start with ONLY modified nodes
  const modifiedNames = new Set(graph.symbols.filter(s => s.status).map(s => s.name));
  const visibleNames = new Set(modifiedNames);

  // Expand set — tracks which nodes have been manually expanded
  const expandedNames = new Set();

  function getVisibleData() {
    const combined = new Set([...visibleNames]);
    // Add neighbors of expanded nodes only
    for (const name of expandedNames) {
      for (const e of allEdges) {
        if (e.from === name) combined.add(e.to);
        if (e.to === name) combined.add(e.from);
      }
    }
    const nodes = [];
    const nodeIds = new Set();
    for (const name of combined) {
      if (allSymbols[name] && !nodeIds.has(name)) {
        nodeIds.add(name);
        nodes.push({ id: name, ...allSymbols[name] });
      }
    }
    const edges = allEdges
      .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => ({ source: e.from, target: e.to }));
    return { nodes, edges };
  }

  const g = svg.append('g');
  let sim, link, node;
  const nodes = [], edges = [];

  // Multi-select with Shift
  const selectedNodes = new Set();

  function updateSelectionVisuals() {
    node.select('circle')
      .attr('stroke', d => {
        if (selectedNodes.has(d.id)) return '#58a6ff';
        if (d.status === 'modified') return '#d29922';
        return kindColor[d.kind] || '#8b949e';
      })
      .attr('stroke-width', d => selectedNodes.has(d.id) ? 4 : (d.status ? 3 : 1.5));
    // Show selection count
    const info = document.getElementById('graph-info');
    const base = `${nodes.length} nodes, ${edges.length} edges (${modifiedNames.size} modified)`;
    if (selectedNodes.size > 0) {
      info.textContent = base + ` | ${selectedNodes.size} selected (Shift+click more, then right-click to explain)`;
    } else {
      info.textContent = base + ' — click to expand';
    }
  }

  function render() {
    g.selectAll('*').remove();
    selectedNodes.clear();
    const { nodes: n, edges: e } = getVisibleData();
    // Reassign to outer scope for updateSelectionVisuals
    nodes.length = 0; nodes.push(...n);
    edges.length = 0; edges.push(...e);

    document.getElementById('graph-info').textContent =
      `${nodes.length} nodes, ${edges.length} edges (${modifiedNames.size} modified — click to expand)`;

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(d => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide().radius(30));

    link = g.append('g').selectAll('line').data(edges).join('line')
      .attr('class', 'graph-edge')
      .attr('marker-end', 'url(#arrow)');

    node = g.append('g').selectAll('g').data(nodes).join('g')
      .attr('class', 'graph-node')
      .style('cursor', 'pointer')
      .on('click', (e, d) => {
        if (e.shiftKey) {
          // Multi-select mode
          if (selectedNodes.has(d.id)) selectedNodes.delete(d.id);
          else selectedNodes.add(d.id);
          updateSelectionVisuals();
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        showNodeMenu(e, d);
      })
      .on('contextmenu', (e, d) => {
        e.preventDefault();
        if (selectedNodes.size >= 2) {
          showMultiExplainMenu(e);
        }
      })
      .call(d3.drag().on('start', dragStart).on('drag', dragging).on('end', dragEnd));

    node.append('circle')
      .attr('r', d => d.kind === 'class' || d.kind === 'interface' ? 14 : 8)
      .attr('fill', d => kindColor[d.kind] || '#8b949e')
      .attr('stroke', d => d.status === 'modified' ? '#d29922' : (kindColor[d.kind] || '#8b949e'))
      .attr('stroke-width', d => d.status ? 3 : 1.5);

    node.append('text').text(d => d.id).attr('dx', 14).attr('dy', 4);
    node.append('title').text(d =>
      `${d.kind}: ${d.name}\n${d.file}:${d.start_line}${d.status ? '\n⚡ ' + d.status : ''}\nShift+click to select multiple`
    );

    sim.on('tick', () => {
      link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
  }

  function showMultiExplainMenu(event) {
    document.getElementById('node-menu')?.remove();
    const names = [...selectedNodes];
    const menu = document.createElement('div');
    menu.id = 'node-menu';
    menu.className = 'node-menu';
    menu.innerHTML = `
      <div class="nm-title">🔗 ${names.length} nodes selected</div>
      <div class="nm-sub">${names.join(', ')}</div>
      <div class="nm-item" onclick="explainRelation()">🧠 Explain relationship</div>
      <div class="nm-item" onclick="explainRelationDiff()">📄 Explain in diff context</div>
      <div class="nm-item" onclick="clearSelection()">✕ Clear selection</div>
    `;
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
  }

  window.clearSelection = function() {
    selectedNodes.clear();
    updateSelectionVisuals();
    document.getElementById('node-menu')?.remove();
  };

  window.explainRelation = function() {
    document.getElementById('node-menu')?.remove();
    const names = [...selectedNodes];
    const syms = names.map(n => allSymbols[n]).filter(Boolean);
    const desc = syms.map(s => `${s.kind} ${s.name} (${s.file}:${s.start_line})`).join('\n');
    const relEdges = allEdges.filter(e => names.includes(e.from) && names.includes(e.to));
    const edgeDesc = relEdges.map(e => `${e.from} → ${e.to}`).join(', ') || 'no direct edges';
    const prompt = `Explain the relationship between these functions and how they interact:\n\n${desc}\n\nConnections: ${edgeDesc}`;
    // Show agent picker
    window._multiExplainPrompt = prompt;
    showAgentPickerForPrompt();
  };

  window.explainRelationDiff = async function() {
    document.getElementById('node-menu')?.remove();
    const names = [...selectedNodes];
    const syms = names.map(n => allSymbols[n]).filter(Boolean);
    const files = [...new Set(syms.map(s => s.file))];
    const proj = projects[openedProjects[activeTab]];
    let patches = '';
    for (const f of files) {
      const p = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, f);
      if (p) patches += `\n--- ${f} ---\n${p.substring(0, 1000)}\n`;
    }
    const desc = syms.map(s => `${s.kind} ${s.name}`).join(', ');
    const prompt = `Explain how these changes relate to each other in this diff:\nFunctions: ${desc}\n${patches}`;
    window._multiExplainPrompt = prompt;
    showAgentPickerForPrompt();
  };

  function showAgentPickerForPrompt() {
    const paneList = Object.entries(panes);
    if (paneList.length === 0) { alert('No agents open'); return; }
    let picker = document.getElementById('agent-picker');
    if (picker) picker.remove();
    picker = document.createElement('div');
    picker.id = 'agent-picker';
    picker.className = 'node-menu';
    picker.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:600';
    let html = '<div class="nm-title">💬 Send to which agent?</div>';
    paneList.forEach(([sid, info]) => {
      html += `<div class="nm-item" onclick="sendMultiExplain('${sid}')">${info.agent.name}</div>`;
    });
    html += '<div class="nm-item" onclick="document.getElementById(\'agent-picker\').remove()">Cancel</div>';
    picker.innerHTML = html;
    document.body.appendChild(picker);
  }

  window.sendMultiExplain = function(sid) {
    document.getElementById('agent-picker')?.remove();
    if (codePanelOpen) toggleCodePanel();
    window.go.main.App.SendInput([sid], window._multiExplainPrompt);
    focusPane(sid);
    selectedNodes.clear();
  };

  function showNodeMenu(event, d) {
    // Remove existing menu
    document.getElementById('node-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'node-menu';
    menu.className = 'node-menu';
    menu.innerHTML = `
      <div class="nm-title">${d.kind}: <b>${d.name}</b></div>
      <div class="nm-sub">${d.file}:${d.start_line}</div>
      <div class="nm-item" onclick="nodeMenuDiff('${d.file}')">📄 View Diff</div>
      <div class="nm-item" onclick="nodeMenuExpand('${d.id}')">🔗 Expand Connections</div>
      ${expandedNames.has(d.id) ? '<div class="nm-item" onclick="nodeMenuCollapse(\'' + d.id + '\')">↩ Collapse</div>' : ''}
    `;
    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';
    document.body.appendChild(menu);
    // Close on click outside
    setTimeout(() => document.addEventListener('click', closeNodeMenu, { once: true }), 10);
  }

  // Expose to global scope for onclick handlers
  window.nodeMenuDiff = async function(file) {
    closeNodeMenu();
    if (!cvActiveHash || activeTab < 0) return;
    const proj = projects[openedProjects[activeTab]];
    const patch = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, file);
    // Show in a floating modal
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
        <span>${file.split('/').pop()}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="nm-explain-btn" onclick="explainChange('${file}')">🧠 Explain</button>
          <span style="cursor:pointer" onclick="document.getElementById('diff-modal').style.display='none'">✕</span>
        </div>
      </div>
      <div class="diff-modal-body">${formatPatch(patch)}</div>
    </div>`;
    modal.style.display = 'flex';
  };

  window.nodeMenuExpand = function(id) {
    closeNodeMenu();
    expandedNames.add(id);
    render();
  };

  window.nodeMenuCollapse = function(id) {
    closeNodeMenu();
    expandedNames.delete(id);
    render();
  };

  function closeNodeMenu() {
    document.getElementById('node-menu')?.remove();
  }

  // --- Explain Change ---
  window.explainChange = async function(file) {
    // Get the diff content for context
    const proj = projects[openedProjects[activeTab]];
    const patch = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, file);

    // Show choice menu
    let menu = document.getElementById('explain-menu');
    if (menu) menu.remove();
    menu = document.createElement('div');
    menu.id = 'explain-menu';
    menu.className = 'node-menu';
    menu.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:600';
    menu.innerHTML = `
      <div class="nm-title">🧠 Explain Change</div>
      <div class="nm-sub">${file.split('/').pop()}</div>
      <div class="nm-item" onclick="explainFromLogs('${file.replace(/'/g,"\\'")}')">📜 Search in agent logs</div>
      <div class="nm-item" onclick="explainWithAgent('${file.replace(/'/g,"\\'")}')">💬 Ask the agent</div>
    `;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
  };

  window.explainFromLogs = async function(file) {
    document.getElementById('explain-menu')?.remove();
    const proj = projects[openedProjects[activeTab]];
    const patch = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, file);
    const msgs = await window.go.main.App.SearchMessagesForCode(proj.name, patch);

    const modal = document.getElementById('diff-modal');
    if (!modal) return;
    let body = modal.querySelector('.diff-modal-body');
    if (!body) return;

    if (!msgs || msgs.length === 0) {
      body.innerHTML = '<div style="padding:20px;color:#8b949e;text-align:center">No related messages found in agent logs</div>';
      return;
    }

    body.innerHTML = '<div class="explain-header">📜 Agent messages related to this change</div>' +
      msgs.map(m => {
        const isMatch = m.highlight === 'match';
        return `<div class="explain-msg ${isMatch ? 'explain-match' : ''}">
          <div class="explain-meta">${m.agent} / ${m.role}</div>
          <div class="explain-content">${escapeHtml(m.content.substring(0, 500))}${m.content.length > 500 ? '...' : ''}</div>
        </div>`;
      }).join('');
  };

  window.explainWithAgent = async function(file) {
    document.getElementById('explain-menu')?.remove();
    document.getElementById('diff-modal').style.display = 'none';

    const paneList = Object.entries(panes);
    if (paneList.length === 0) { alert('No agents open'); return; }

    // Build agent picker
    let picker = document.getElementById('agent-picker');
    if (picker) picker.remove();
    picker = document.createElement('div');
    picker.id = 'agent-picker';
    picker.className = 'node-menu';
    picker.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:600';

    let html = '<div class="nm-title">💬 Send to which agent?</div>';
    for (const [sid, info] of paneList) {
      const busy = await window.go.main.App.IsAgentBusy(sid);
      const status = busy ? ' <span style="color:#d29922">⏳ busy</span>' : ' <span style="color:#3fb950">● idle</span>';
      html += `<div class="nm-item" onclick="doExplainSend('${sid}','${file.replace(/'/g,"\\'")}')">
        ${info.agent.name}${status}
      </div>`;
    }
    html += '<div class="nm-item" onclick="doExplainNewAgent(\'' + file.replace(/'/g,"\\'") + '\')">+ New agent</div>';
    picker.innerHTML = html;
    document.body.appendChild(picker);
    setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 10);
  };

  window.doExplainSend = async function(sid, file) {
    document.getElementById('agent-picker')?.remove();
    if (codePanelOpen) toggleCodePanel();
    const proj = projects[openedProjects[activeTab]];
    const patch = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, file);
    const msg = `Explain this code change in ${file.split('/').pop()}:\n\n${patch.substring(0, 2000)}`;
    window.go.main.App.SendInput([sid], msg);
    focusPane(sid);
  };

  window.doExplainNewAgent = function(file) {
    document.getElementById('agent-picker')?.remove();
    // Store file for after spawn
    window._pendingExplainFile = file;
    spawnNextAgent();
  };

  render();

  svg.call(d3.zoom().scaleExtent([0.3, 5]).on('zoom', e => {
    g.attr('transform', e.transform);
  }));

  function dragStart(e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
  function dragging(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
}

async function loadCommits() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  console.log('[loadCommits] repo:', cvSelectedRepo, 'branch:', cvSelectedBranch);
  if (cvSelectedRepo) {
    cvCommits = await window.go.main.App.GetCommitsForRepo(proj.name, cvSelectedRepo, cvSelectedBranch, 30) || [];
  } else if (cvSelectedBranch) {
    cvCommits = await window.go.main.App.GetCommitsBranch(proj.name, cvSelectedBranch, 30) || [];
  } else {
    cvCommits = await window.go.main.App.GetCommits(proj.name, 30) || [];
  }
  console.log('[loadCommits] got', cvCommits.length, 'commits');
  renderTimeline();
  populateCommitSelect();
}

function renderTimeline() {
  const el = document.getElementById('cv-timeline');
  const filtered = cvSelectedRepo
    ? cvCommits.filter(c => c.repo === cvSelectedRepo || !c.repo)
    : cvCommits;
  if (filtered.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#8b949e;text-align:center;font-size:12px">No commits</div>';
    return;
  }
  el.innerHTML = filtered.map(c =>
    `<div class="cv-commit ${c.hash === cvActiveHash ? 'active' : ''}" onclick="selectCommit('${c.hash}')">
      <div class="cv-hash">${c.hash}${c.local ? ' <span class="cv-local">↑ local</span>' : ''}${c.repo ? ' <span style="color:#a371f7">'+c.repo+'</span>' : ''}</div>
      <div class="cv-msg">${escapeHtml(c.message)}</div>
      <div class="cv-meta">${c.author} · ${c.time} · ${c.files} files</div>
    </div>`
  ).join('');
}

async function selectCommit(hash) {
  cvActiveHash = hash;
  renderTimeline();
  document.getElementById('cv-commit-select').value = hash;
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  // Load commit detail + files
  const [detail, files] = await Promise.all([
    window.go.main.App.GetCommitDetail(proj.name, hash),
    window.go.main.App.GetDiffFiles(proj.name, hash) || [],
  ]);
  renderCommitDetail(proj.name, hash, detail, files || []);

  const graphView = document.getElementById('cv-view-graph');
  if (graphView && graphView.style.display !== 'none') {
    loadGraph(hash);
  }
}

function renderCommitDetail(projName, hash, detail, files) {
  const el = document.getElementById('cv-detail');
  if (!detail && files.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#8b949e;text-align:center;font-size:12px">No changes</div>';
    return;
  }

  // Commit message header
  let html = '';
  if (detail) {
    html += `<div class="cv-commit-detail">
      <div class="cv-detail-hash">${detail.hash} <span class="cv-detail-author">${escapeHtml(detail.author)}</span> <span class="cv-detail-time">${detail.time}</span></div>
      <div class="cv-detail-msg">${escapeHtml(detail.message)}</div>
      ${detail.body ? '<div class="cv-detail-body">' + escapeHtml(detail.body) + '</div>' : ''}
    </div>`;
  }

  // Changed files header
  html += `<div class="cv-files-header">${files.length} changed file${files.length !== 1 ? 's' : ''}</div>`;

  // File list (VS Code style)
  html += files.map((f, i) => {
    const icon = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
    const iconClass = f.status === 'added' ? 'add' : f.status === 'deleted' ? 'del' : 'mod';
    const name = f.path.split('/').pop();
    const dir = f.path.substring(0, f.path.length - name.length);
    return `<div class="cv-file">
      <div class="cv-file-header" onclick="togglePatch('${projName}','${hash}','${f.path}',${i})">
        <div class="cv-file-info">
          <span class="cv-file-icon cv-icon-${iconClass}">${icon}</span>
          <span class="cv-file-name">${name}</span>
          <span class="cv-file-dir">${dir}</span>
        </div>
        <div class="cv-file-stats">
          ${f.additions > 0 ? '<span class="cv-stat-add">+' + f.additions + '</span>' : ''}
          ${f.deletions > 0 ? '<span class="cv-stat-del">-' + f.deletions + '</span>' : ''}
        </div>
      </div>
      <div class="cv-patch" id="cv-patch-${i}"></div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

async function togglePatch(projName, hash, filePath, idx) {
  const el = document.getElementById('cv-patch-' + idx);
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    return;
  }
  if (!el.innerHTML) {
    const patch = await window.go.main.App.GetFilePatch(projName, hash, filePath);
    el.innerHTML = formatPatch(patch);
  }
  el.classList.add('open');
}

function formatPatch(patch) {
  if (!patch) return '<span style="color:#8b949e">No diff available</span>';
  return patch.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `<div class="cv-line-add">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return `<div class="cv-line-del">${escapeHtml(line)}</div>`;
    } else if (line.startsWith('@@')) {
      return `<div class="cv-line-hunk">${escapeHtml(line)}</div>`;
    }
    return `<div>${escapeHtml(line)}</div>`;
  }).join('');
}

// --- Resize ---
function startResizeCodePanel(e) {
  e.preventDefault();
  const panel = document.getElementById('code-panel');
  const startX = e.clientX;
  const startW = panel.offsetWidth;
  function onMove(e) {
    const w = startW - (e.clientX - startX);
    panel.style.width = Math.max(300, Math.min(w, window.innerWidth - 300)) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Config ---
async function openCodeConfig() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const cfg = await window.go.main.App.GetProjectConfig(proj.name);
  const lang = prompt('Language (java, typescript, python):', cfg.language || '');
  if (lang === null) return;
  const fw = prompt('Framework (spring-boot, nextjs, react-native, flask):', cfg.framework || '');
  if (fw === null) return;
  const entry = prompt('Entry file:', cfg.entry_file || '');
  const test = prompt('Test command:', cfg.test_cmd || '');
  const build = prompt('Build command:', cfg.build_cmd || '');
  await window.go.main.App.SaveProjectConfig(proj.name, {
    language: lang, framework: fw, entry_file: entry, test_cmd: test, build_cmd: build
  });
}
