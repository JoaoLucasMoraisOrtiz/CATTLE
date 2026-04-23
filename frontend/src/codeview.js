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
      <div class="cv-hash">${c.hash}</div>
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
