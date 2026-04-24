// ReDo! v2 — File Tree Navigator

let ftCache = {}; // path → children cache

async function loadFileTree(relPath) {
  if (activeTab < 0) return [];
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return [];
  const key = proj.name + ':' + (relPath || '.');
  if (ftCache[key]) return ftCache[key];
  const entries = await window.go.main.App.ListDirectory(proj.name, relPath || '');
  ftCache[key] = entries || [];
  return ftCache[key];
}

function resetFileTree() {
  ftCache = {};
  const el = document.getElementById('file-tree');
  if (el) el.innerHTML = '<div style="color:#8b949e;padding:12px;font-size:12px">Loading...</div>';
  renderFileTreeRoot();
}

async function renderFileTreeRoot() {
  const el = document.getElementById('file-tree');
  if (!el) return;
  const entries = await loadFileTree('');
  if (!entries || entries.length === 0) {
    el.innerHTML = '<div style="color:#8b949e;padding:12px;font-size:12px">No files found</div>';
    return;
  }
  el.innerHTML = '';
  renderTreeLevel(el, entries, 0);
}

function renderTreeLevel(container, entries, depth) {
  // Sort: dirs first, then files, alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const row = document.createElement('div');
    row.className = 'ft-row';
    row.style.paddingLeft = (12 + depth * 16) + 'px';
    row.dataset.path = entry.path;
    row.dataset.isDir = entry.isDir;

    const icon = entry.isDir ? '▶' : ftFileIcon(entry.ext);
    const nameClass = entry.isDir ? 'ft-dir-name' : 'ft-file-name';

    row.innerHTML = `<span class="ft-icon">${icon}</span><span class="${nameClass}">${entry.name}</span>`;

    if (entry.isDir) {
      row.onclick = (e) => { e.stopPropagation(); toggleDir(row, entry.path, depth); };
    } else {
      row.onclick = (e) => { e.stopPropagation(); ftSelectFile(entry.path); };
    }
    row.oncontextmenu = (e) => { e.preventDefault(); ftContextMenu(e, entry); };

    container.appendChild(row);
  }
}

async function toggleDir(row, path, depth) {
  const icon = row.querySelector('.ft-icon');
  const next = row.nextSibling;

  // If already expanded, collapse
  if (icon.textContent === '▼') {
    icon.textContent = '▶';
    // Remove children until next sibling at same or lower depth
    while (row.nextSibling && row.nextSibling.classList?.contains('ft-row')) {
      const childDepth = parseInt(row.nextSibling.style.paddingLeft) || 0;
      const myDepth = parseInt(row.style.paddingLeft) || 0;
      if (childDepth <= myDepth) break;
      row.nextSibling.remove();
    }
    return;
  }

  icon.textContent = '▼';
  const entries = await loadFileTree(path);
  if (!entries || entries.length === 0) return;

  // Insert children after this row
  const frag = document.createDocumentFragment();
  const temp = document.createElement('div');
  renderTreeLevel(temp, entries, depth + 1);
  while (temp.firstChild) frag.appendChild(temp.firstChild);

  if (row.nextSibling) {
    row.parentNode.insertBefore(frag, row.nextSibling);
  } else {
    row.parentNode.appendChild(frag);
  }
}

function ftSelectFile(path) {
  document.querySelectorAll('.ft-row').forEach(r => r.classList.remove('ft-selected'));
  const row = document.querySelector(`.ft-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.classList.add('ft-selected');
}

function ftFileIcon(ext) {
  return ''; // clean UI — no emoji icons, just indentation
}

function ftContextMenu(event, entry) {
  document.getElementById('node-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'node-menu';
  menu.className = 'node-menu';

  if (entry.isDir) {
    menu.innerHTML = `
      <div class="nm-title">${entry.name}/</div>
      <div class="nm-item" onclick="ftGraphDir('${entry.path}')">View as Graph</div>
      <div class="nm-item" onclick="ftAddDirToPrompt('${entry.path}')">Add all to Prompt</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="nm-title">${entry.name}</div>
      <div class="nm-item" onclick="ftViewFile('${entry.path}')">View</div>
      <div class="nm-item" onclick="ftGraphFile('${entry.path}')">View as Graph</div>
      <div class="nm-item" onclick="ftAddToPrompt('${entry.path}')">Add to Prompt</div>
      <div class="nm-item" onclick="ftAddToKB('${entry.path}')">Add to Knowledge</div>
    `;
  }

  menu.style.left = event.pageX + 'px';
  menu.style.top = event.pageY + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

// --- Actions ---

async function ftViewFile(path) {
  document.getElementById('node-menu')?.remove();
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const content = await window.go.main.App.ReadProjectFile(proj.name, path);

  let modal = document.getElementById('diff-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'diff-modal-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="diff-modal" style="width:70vw;max-height:80vh">
    <div class="diff-modal-header">
      <span>📄 ${path}</span>
      <span style="cursor:pointer" onclick="document.getElementById('diff-modal').style.display='none'">✕</span>
    </div>
    <div class="diff-modal-body"><pre style="margin:0;font-size:12px">${escapeHtml(content || 'Could not read file')}</pre></div>
  </div>`;
  modal.style.display = 'flex';
}

async function ftGraphFile(path) {
  document.getElementById('node-menu')?.remove();
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const syms = await window.go.main.App.GetFileSymbols(proj.name, path);
  if (!syms || syms.length === 0) { alert('No symbols found in ' + path); return; }

  // Open Prompt Builder and populate with these symbols
  if (!pbPanelOpen) togglePromptBuilder();
  pbSymbols = syms.map(s => ({
    name: s.name, kind: s.kind, file: s.file || path,
    line: String(s.start_line), end_line: String(s.end_line),
    calls: s.calls ? s.calls.join(',') : ''
  }));
  pbSelected = new Set();
  pbEdges = [];
  // Build edges from calls
  const nameSet = new Set(pbSymbols.map(s => s.name));
  pbSymbols.forEach((s, i) => {
    if (s.calls) {
      s.calls.split(',').forEach(c => {
        if (nameSet.has(c.trim())) {
          pbEdges.push({ from: s.name, to: c.trim() });
        }
      });
    }
  });
  renderPBNodes();
  renderPBGraph();
  document.getElementById('pb-status').textContent = `${pbSymbols.length} symbols from ${path}`;
}

function ftAddToPrompt(path) {
  document.getElementById('node-menu')?.remove();
  const ta = document.getElementById('pb-prompt');
  if (!ta) return;
  if (!pbPanelOpen) togglePromptBuilder();
  const current = ta.value;
  const ref = `- 📄 ${path}`;
  if (!current.includes(ref)) {
    ta.value = current + (current ? '\n' : '') + ref;
  }
}

async function ftAddDirToPrompt(dirPath) {
  document.getElementById('node-menu')?.remove();
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const entries = await window.go.main.App.ListDirectory(proj.name, dirPath);
  if (!entries) return;
  if (!pbPanelOpen) togglePromptBuilder();
  const ta = document.getElementById('pb-prompt');
  let current = ta.value;
  for (const e of entries) {
    if (!e.isDir) {
      const ref = `- 📄 ${e.path}`;
      if (!current.includes(ref)) {
        current += (current ? '\n' : '') + ref;
      }
    }
  }
  ta.value = current;
}

async function ftGraphDir(dirPath) {
  document.getElementById('node-menu')?.remove();
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const entries = await window.go.main.App.ListDirectory(proj.name, dirPath);
  if (!entries) return;

  if (!pbPanelOpen) togglePromptBuilder();
  pbSymbols = [];
  pbEdges = [];
  pbSelected = new Set();

  for (const e of entries) {
    if (e.isDir) continue;
    const syms = await window.go.main.App.GetFileSymbols(proj.name, e.path);
    if (!syms) continue;
    for (const s of syms) {
      pbSymbols.push({
        name: s.name, kind: s.kind, file: e.path,
        line: String(s.start_line), end_line: String(s.end_line),
        calls: s.calls ? s.calls.join(',') : ''
      });
    }
  }

  // Build edges
  const nameSet = new Set(pbSymbols.map(s => s.name));
  pbSymbols.forEach(s => {
    if (s.calls) {
      s.calls.split(',').forEach(c => {
        if (nameSet.has(c.trim())) {
          pbEdges.push({ from: s.name, to: c.trim() });
        }
      });
    }
  });

  renderPBNodes();
  renderPBGraph();
  document.getElementById('pb-status').textContent = `${pbSymbols.length} symbols from ${dirPath}/`;
}

async function ftAddToKB(path) {
  document.getElementById('node-menu')?.remove();
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  const full = proj.path.replace(/\/+$/, '') + '/' + path;
  await window.go.main.App.AddKBDoc(proj.name, full);
  renderKBList();
}

// --- Sidebar tab switching ---
function switchSidebarTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.sidebar-tab[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById('kb-panel').style.display = tab === 'kb' ? '' : 'none';
  document.getElementById('files-panel').style.display = tab === 'files' ? '' : 'none';
  if (tab === 'files') renderFileTreeRoot();
}
