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
  const branches = await window.go.main.App.GetBranches(proj.name) || [];
  const sel = document.getElementById('cv-branch-select');
  const current = branches.find(b => b.current);
  cvSelectedBranch = current ? current.name : '';
  sel.innerHTML = branches.map(b =>
    `<option value="${b.name}" ${b.current ? 'selected' : ''}>${b.name}${b.current ? ' ●' : ''}</option>`
  ).join('');
}

function onRepoChange() {
  cvSelectedRepo = document.getElementById('cv-repo-select').value;
  loadCommits();
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
  let sim;

  function render() {
    g.selectAll('*').remove();
    const { nodes, edges } = getVisibleData();

    document.getElementById('graph-info').textContent =
      `${nodes.length} nodes, ${edges.length} edges (${modifiedNames.size} modified — click to expand)`;

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(d => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide().radius(30));

    const link = g.append('g').selectAll('line').data(edges).join('line')
      .attr('class', 'graph-edge')
      .attr('marker-end', 'url(#arrow)');

    const node = g.append('g').selectAll('g').data(nodes).join('g')
      .attr('class', 'graph-node')
      .style('cursor', 'pointer')
      .on('click', (e, d) => {
        e.stopPropagation();
        showNodeMenu(e, d);
      })
      .call(d3.drag().on('start', dragStart).on('drag', dragging).on('end', dragEnd));

    node.append('circle')
      .attr('r', d => d.kind === 'class' || d.kind === 'interface' ? 14 : 8)
      .attr('fill', d => kindColor[d.kind] || '#8b949e')
      .attr('stroke', d => d.status === 'modified' ? '#d29922' : (kindColor[d.kind] || '#8b949e'))
      .attr('stroke-width', d => d.status ? 3 : 1.5);

    node.append('text').text(d => d.id).attr('dx', 14).attr('dy', 4);
    node.append('title').text(d =>
      `${d.kind}: ${d.name}\n${d.file}:${d.start_line}${d.status ? '\n⚡ ' + d.status : ''}\nClick to expand/collapse`
    );

    sim.on('tick', () => {
      link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
  }

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
    if (!focusedPane) { alert('Focus an agent pane first'); return; }
    const proj = projects[openedProjects[activeTab]];
    const patch = await window.go.main.App.GetFilePatch(proj.name, cvActiveHash, file);
    const prompt = `Explain this code change in ${file.split('/').pop()}:\n\n${patch.substring(0, 2000)}`;
    window.go.main.App.SendInput([focusedPane], prompt);
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
  if (cvSelectedBranch) {
    cvCommits = await window.go.main.App.GetCommitsBranch(proj.name, cvSelectedBranch, 30) || [];
  } else {
    cvCommits = await window.go.main.App.GetCommits(proj.name, 30) || [];
  }
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
      <div class="cv-hash">${c.hash}${c.repo ? ' <span style="color:#a371f7">'+c.repo+'</span>' : ''}</div>
      <div class="cv-msg">${escapeHtml(c.message)}</div>
      <div class="cv-meta">${c.author} · ${c.time} · ${c.files} files</div>
    </div>`
  ).join('');
}

async function selectCommit(hash) {
  cvActiveHash = hash;
  renderTimeline();
  // Sync the commit dropdown
  document.getElementById('cv-commit-select').value = hash;
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const files = await window.go.main.App.GetDiffFiles(proj.name, hash) || [];
  renderDiffFiles(proj.name, hash, files);
  // Also load graph if Graph tab is active
  const graphView = document.getElementById('cv-view-graph');
  if (graphView && graphView.style.display !== 'none') {
    loadGraph(hash);
  }
}

function renderDiffFiles(projName, hash, files) {
  const el = document.getElementById('cv-detail');
  if (files.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#8b949e;text-align:center;font-size:12px">No changes</div>';
    return;
  }
  el.innerHTML = files.map((f, i) => {
    const icon = f.status === 'added' ? '🟢' : f.status === 'deleted' ? '🔴' : '🟡';
    return `<div class="cv-file">
      <div class="cv-file-header" onclick="togglePatch('${projName}','${hash}','${f.path}',${i})">
        <span>${icon} ${f.path}</span>
        <span><span class="cv-stat-add">+${f.additions}</span> <span class="cv-stat-del">-${f.deletions}</span></span>
      </div>
      <div class="cv-patch" id="cv-patch-${i}"></div>
    </div>`;
  }).join('');
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
