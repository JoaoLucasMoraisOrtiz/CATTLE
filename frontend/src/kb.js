// ReDo! v2 — Knowledge Base Sidebar & Viewer

let kbViewerData = { path: '', content: '', chunks: [] };

function renderKBList() {
  const el = document.getElementById('kb-list');
  if (activeTab < 0) { el.innerHTML = ''; return; }
  const proj = projects[openedProjects[activeTab]];
  if (!proj || !proj.kb_docs || proj.kb_docs.length === 0) {
    el.innerHTML = '<div style="padding:12px;color:#8b949e;font-size:12px;text-align:center">No docs added</div>';
    return;
  }
  el.innerHTML = proj.kb_docs.map(doc => {
    const name = doc.split('/').pop();
    return `<div class="kb-item">
      <span class="kb-name" title="${doc}" onclick="openKBViewer('${doc}')" style="cursor:pointer">${name}</span>
      <span class="kb-remove" onclick="removeKBDoc('${doc}')">✕</span>
    </div>`;
  }).join('');
}

async function addKBDoc() {
  if (activeTab < 0) return;
  const paths = await window.go.main.App.PickFiles();
  if (!paths || paths.length === 0) return;
  const proj = projects[openedProjects[activeTab]];
  showKBLoading(`Indexing ${paths.length} file${paths.length > 1 ? 's' : ''}...`);
  for (const path of paths) {
    await window.go.main.App.AddKBDoc(proj.name, path);
  }
  hideKBLoading();
  projects = await window.go.main.App.GetProjects();
  renderKBList();
  updateStatus();
}

async function removeKBDoc(path) {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  await window.go.main.App.RemoveKBDoc(proj.name, path);
  projects = await window.go.main.App.GetProjects();
  renderKBList();
}

async function reindexKB() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  showKBLoading('Reindexing all docs...');
  const result = await window.go.main.App.ReindexKB(proj.name);
  hideKBLoading();
  alert(result);
}

function showKBLoading(text) {
  let el = document.getElementById('kb-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kb-loading';
    document.getElementById('kb-list').prepend(el);
  }
  el.innerHTML = `<span class="kb-spinner"></span> ${text}`;
  el.style.display = 'flex';
}

function hideKBLoading() {
  const el = document.getElementById('kb-loading');
  if (el) el.style.display = 'none';
}

async function openKBViewer(docPath) {
  document.getElementById('kb-viewer-title').textContent = docPath.split('/').pop();
  document.getElementById('kb-viewer-modal').classList.add('active');

  const proj = projects[openedProjects[activeTab]];
  const [content, chunks] = await Promise.all([
    window.go.main.App.ReadFileContent(docPath),
    window.go.main.App.GetKBChunks(proj.name, docPath),
  ]);
  kbViewerData = { path: docPath, content: content || '(empty)', chunks: chunks || [] };
  switchKBView('doc', document.querySelector('.kb-vtab'));
}

function switchKBView(view, btn) {
  document.querySelectorAll('.kb-vtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const el = document.getElementById('kb-viewer-content');
  if (view === 'doc') {
    el.textContent = kbViewerData.content;
  } else {
    if (kbViewerData.chunks.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;padding:20px;text-align:center">No chunks — reindex to generate</div>';
    } else {
      el.innerHTML = kbViewerData.chunks.map((c, i) =>
        `<div class="chunk-card"><div class="chunk-header">Chunk ${i + 1} / ${kbViewerData.chunks.length} — ${c.length} chars</div><div class="chunk-body">${escapeHtml(c)}</div></div>`
      ).join('');
    }
  }
}

function closeKBViewer() { document.getElementById('kb-viewer-modal').classList.remove('active'); }
