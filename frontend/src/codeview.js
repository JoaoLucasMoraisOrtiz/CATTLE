// Code Viewer — git timeline + diff viewer + resizable panel

let codePanelOpen = false;
let cvCommits = [];
let cvActiveHash = null;

function toggleCodePanel() {
  const panel = document.getElementById('code-panel');
  const tab = document.getElementById('code-panel-tab');
  codePanelOpen = !codePanelOpen;
  panel.style.display = codePanelOpen ? '' : 'none';
  tab.textContent = codePanelOpen ? '▶ Code' : '◀ Code';
  if (codePanelOpen) loadCommits();
}

function switchCVTab(name, btn) {
  document.querySelectorAll('.cv-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('[id^="cv-view-"]').forEach(v => v.style.display = 'none');
  document.getElementById('cv-view-' + name).style.display = '';
  if (name === 'gitlog') loadCommits();
  if (name === 'graph') populateGraphCommits();
}

// --- Graph ---
async function populateGraphCommits() {
  if (!cvCommits.length) await loadCommits();
  const sel = document.getElementById('graph-commit');
  sel.innerHTML = '<option value="">Select commit...</option>' +
    cvCommits.map(c => `<option value="${c.hash}">${c.hash} — ${escapeHtml(c.message.substring(0,40))}</option>`).join('');
}

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

  // Arrow marker
  svg.append('defs').append('marker')
    .attr('id', 'arrow').attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#30363d');

  const kindColor = { 'function': '#1f6feb', 'method': '#1f6feb', 'class': '#3fb950', 'interface': '#a371f7' };

  const nodes = graph.symbols.map(s => ({ id: s.name, ...s }));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = (graph.edges || []).filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(w / 2, h / 2));

  const link = svg.append('g').selectAll('line').data(edges).join('line').attr('class', 'graph-edge');

  const node = svg.append('g').selectAll('g').data(nodes).join('g').attr('class', 'graph-node')
    .call(d3.drag().on('start', dragStart).on('drag', dragging).on('end', dragEnd));

  node.append('circle')
    .attr('r', d => d.kind === 'class' || d.kind === 'interface' ? 12 : 8)
    .attr('fill', d => kindColor[d.kind] || '#8b949e')
    .attr('stroke', d => kindColor[d.kind] || '#8b949e');

  node.append('text').text(d => d.id).attr('dx', 14).attr('dy', 4);

  node.append('title').text(d => `${d.kind}: ${d.name}\n${d.file}:${d.start_line}`);

  sim.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Zoom
  svg.call(d3.zoom().scaleExtent([0.3, 5]).on('zoom', e => {
    svg.selectAll('g').attr('transform', e.transform);
  }));

  function dragStart(e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
  function dragging(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }
}

async function loadCommits() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  cvCommits = await window.go.main.App.GetCommits(proj.name, 30) || [];
  renderTimeline();
}

function renderTimeline() {
  const el = document.getElementById('cv-timeline');
  if (cvCommits.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:#8b949e;text-align:center;font-size:12px">No commits</div>';
    return;
  }
  el.innerHTML = cvCommits.map(c =>
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
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const files = await window.go.main.App.GetDiffFiles(proj.name, hash) || [];
  renderDiffFiles(proj.name, hash, files);
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
