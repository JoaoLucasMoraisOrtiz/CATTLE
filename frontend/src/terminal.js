// ReDo! v2 — Terminal Panel (multi-tab shell)

let shellTabs = []; // { sid, term, fitAddon, name }
let activeShellTab = -1;

function toggleTermPanel() {
  const panel = document.getElementById('term-panel');
  const body = document.getElementById('term-panel-body');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    body.style.display = 'none';
  } else {
    panel.classList.add('open');
    body.style.display = '';
    if (shellTabs.length === 0) addShellTab();
    else if (activeShellTab >= 0) {
      shellTabs[activeShellTab].fitAddon.fit();
      shellTabs[activeShellTab].term.focus();
    }
  }
}

async function addShellTab() {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;

  const sid = await window.go.main.App.SpawnShell(proj.name);
  if (!sid || sid.startsWith('error:')) return;

  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9' },
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 12, cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const idx = shellTabs.length;
  shellTabs.push({ sid, term, fitAddon, name: 'shell ' + (idx + 1) });

  term.onData((data) => { window.go.main.App.SendRaw(sid, data); });
  window.runtime.EventsOn('pty:output:' + sid, (data) => { term.write(data); });
  window.runtime.EventsOn('pty:exit:' + sid, () => { term.write('\r\n\x1b[31m[exited]\x1b[0m\r\n'); });

  const panel = document.getElementById('term-panel');
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    document.getElementById('term-panel-body').style.display = '';
  }

  switchShellTab(idx);
}

function switchShellTab(idx) {
  if (activeShellTab >= 0 && shellTabs[activeShellTab]) {
    const el = shellTabs[activeShellTab].term.element;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  activeShellTab = idx;
  const container = document.getElementById('term-panel-content');
  container.innerHTML = '';
  const tab = shellTabs[idx];
  if (!tab.term.element) {
    tab.term.open(container);
  } else {
    container.appendChild(tab.term.element);
  }
  tab.fitAddon.fit();
  window.go.main.App.ResizeTerminal(tab.sid, tab.term.rows, tab.term.cols);
  tab.term.focus();
  renderShellTabs();
}

function closeShellTab(idx) {
  const tab = shellTabs[idx];
  window.go.main.App.KillSession(tab.sid);
  window.runtime.EventsOff('pty:output:' + tab.sid);
  window.runtime.EventsOff('pty:exit:' + tab.sid);
  tab.term.dispose();
  shellTabs.splice(idx, 1);
  if (shellTabs.length === 0) {
    activeShellTab = -1;
    document.getElementById('term-panel-content').innerHTML = '';
    toggleTermPanel();
  } else {
    if (activeShellTab >= shellTabs.length) activeShellTab = shellTabs.length - 1;
    switchShellTab(activeShellTab);
  }
}

function renderShellTabs() {
  document.getElementById('term-tabs').innerHTML = shellTabs.map((t, i) =>
    `<span class="term-tab ${i === activeShellTab ? 'active' : ''}" onclick="event.stopPropagation(); switchShellTab(${i})">
      ${t.name}<span class="tt-close" onclick="event.stopPropagation(); closeShellTab(${i})">✕</span>
    </span>`
  ).join('');
}
