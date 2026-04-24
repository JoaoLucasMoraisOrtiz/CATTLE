// ReDo! v2 — Input, Context Search, Agent Picker, Prompt Improve, Token Optimization

let searchTimer = null;
let pendingChunks = [];
let searching = false;
let ctxEnabled = true;

function setupInput() {
  const input = document.getElementById('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!document.getElementById('send-btn').disabled) sendMessage();
    }
  });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!ctxEnabled || q.length < 3) { hidePreview(); setSendEnabled(true); return; }
    setSendEnabled(false);
    searching = true;
    searchTimer = setTimeout(() => searchPreview(q), 400);
  });
  input.addEventListener('focus', () => {
    document.querySelectorAll('.pane').forEach(p => { p.classList.remove('focused'); p.style.borderColor = '#30363d'; p.style.boxShadow = 'none'; });
  });
}

function setSendEnabled(enabled) {
  document.getElementById('send-btn').disabled = !enabled;
}

function onCtxToggle() {
  ctxEnabled = document.getElementById('ctx-toggle').checked;
  document.querySelector('.ctx-toggle').classList.toggle('off', !ctxEnabled);
  if (!ctxEnabled) {
    hidePreview();
    setSendEnabled(true);
  }
}

async function searchPreview(query) {
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];
  if (!proj) return;
  try {
    console.log('[searchPreview] query:', query, 'project:', proj.name);
    const hits = await window.go.main.App.SearchChunks(proj.name, query, 3);
    console.log('[searchPreview] hits:', hits);
    if (!hits || hits.length === 0) { hidePreview(); searching = false; setSendEnabled(true); return; }
    pendingChunks = hits;
    const el = document.getElementById('injection-preview');
    el.innerHTML = hits.map((h, i) =>
      `<div class="preview-chip" onclick="toggleChip(this,${i})" onmouseenter="showChunkTooltip(event,${i})" onmouseleave="hideChunkTooltip()">
        <span class="chip-source">${h.type === 'kb' ? '📚' : '💬'} ${escapeHtml(h.source)}</span>
        <span class="chip-text">${escapeHtml(h.content.substring(0, 120))}${h.content.length > 120 ? '...' : ''}</span>
      </div>`
    ).join('');
    el.classList.add('visible');
    el.querySelectorAll('.preview-chip').forEach(c => c.classList.add('selected'));
  } catch(e) {
    console.error('[searchPreview] error:', e);
  }
  searching = false;
  setSendEnabled(true);
}

function toggleChip(el, idx) {
  el.classList.toggle('selected');
}

function showChunkTooltip(e, idx) {
  if (!pendingChunks[idx]) return;
  let tip = document.getElementById('chunk-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chunk-tooltip';
    tip.onmouseenter = () => { tip._hover = true; };
    tip.onmouseleave = () => { tip._hover = false; tip.style.display = 'none'; };
    document.body.appendChild(tip);
  }
  const h = pendingChunks[idx];
  tip.innerHTML = `<div class="tt-source">${h.type === 'kb' ? '📚' : '💬'} ${escapeHtml(h.source)}</div><div class="tt-body">${escapeHtml(h.content)}</div>`;
  tip.style.display = 'block';
  tip._hover = false;
  const rect = e.currentTarget.getBoundingClientRect();
  tip.style.left = rect.left + 'px';
  tip.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
}

function hideChunkTooltip() {
  setTimeout(() => {
    const tip = document.getElementById('chunk-tooltip');
    if (tip && !tip._hover) tip.style.display = 'none';
  }, 100);
}

function hidePreview() {
  pendingChunks = [];
  const el = document.getElementById('injection-preview');
  el.innerHTML = '';
  el.classList.remove('visible');
}

function getSelectedContext() {
  const chips = document.querySelectorAll('#injection-preview .preview-chip.selected');
  if (chips.length === 0 || pendingChunks.length === 0) return '';
  let ctx = '--- Relevant context ---\n';
  chips.forEach(chip => {
    const idx = parseInt(chip.querySelector('.chip-source') ? Array.from(chip.parentNode.children).indexOf(chip) : 0);
    if (pendingChunks[idx]) {
      const h = pendingChunks[idx];
      ctx += `[${h.source}] ${h.content}\n\n`;
    }
  });
  ctx += '--- End context ---\n\n';
  return ctx;
}

function sendMessage() {
  const input = document.getElementById('input');
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';

  const words = raw.split(/\s+/);
  const targets = [], textParts = [];
  for (const w of words) { if (w.startsWith('@')) targets.push(w.slice(1)); else textParts.push(w); }
  const userText = textParts.join(' ');

  const ctx = getSelectedContext();
  const text = ctx ? ctx + userText : userText;

  hidePreview();

  let sessionIDs = [];
  if (targets.length === 0) { if (focusedPane) sessionIDs = [focusedPane]; }
  else { for (const [sid, info] of Object.entries(panes)) { if (targets.includes(info.agent.name)) sessionIDs.push(sid); } }
  if (sessionIDs.length > 0 && text) window.go.main.App.SendInput(sessionIDs, text);
}

// --- Agent Picker ---
window._showAgentPicker = function() {
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
    html += `<div class="nm-item" onclick="window._sendToAgent('${sid}')">${info.agent.name}</div>`;
  });
  html += '<div class="nm-item" onclick="document.getElementById(\'agent-picker\').remove()">Cancel</div>';
  picker.innerHTML = html;
  document.body.appendChild(picker);
};

window._sendToAgent = function(sid) {
  document.getElementById('agent-picker')?.remove();
  if (typeof codePanelOpen !== 'undefined' && codePanelOpen) toggleCodePanel();
  window.go.main.App.SendInput([sid], window._multiExplainPrompt);
  focusPane(sid);
};

// --- Prompt Improve ---
let improveSymbols = [];
let improveSelected = new Set();

async function improvePrompt() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (text.length < 5) { alert('Type your prompt first, then click 🔍'); return; }
  if (activeTab < 0) return;
  const proj = projects[openedProjects[activeTab]];

  setSendEnabled(false);
  document.getElementById('improve-btn').textContent = '⏳';

  const suggestions = await window.go.main.App.SuggestSymbols(proj.name, text);
  document.getElementById('improve-btn').textContent = '🔍';

  if (!suggestions || suggestions.length === 0) {
    setSendEnabled(true);
    alert('No relevant code found for this prompt.');
    return;
  }

  improveSymbols = suggestions;
  improveSelected = new Set();
  showImprovePanel();
}

function showImprovePanel() {
  const el = document.getElementById('injection-preview');
  el.innerHTML = `<div class="improve-header">🔍 Relevant code found — select what to include:</div>` +
    improveSymbols.map((s, i) => {
      const icon = s.kind === 'kb' ? '📚' : s.kind === 'class' ? '🟢' : '🔵';
      return `<div class="improve-node ${improveSelected.has(i) ? 'selected' : ''}" onclick="toggleImproveNode(${i})">
        <div class="improve-node-header">
          <span>${icon} <b>${s.name}</b> <span style="color:#8b949e">${s.kind !== 'kb' ? s.file + ':' + s.line : s.file}</span></span>
          <span class="improve-explain" onclick="event.stopPropagation(); explainNode(${i})" title="Explain this">❓</span>
        </div>
        <div class="improve-preview">${escapeHtml(s.preview || '').substring(0, 150)}</div>
      </div>`;
    }).join('') +
    `<div style="display:flex;gap:8px;padding:6px 0">
      <button class="btn-spawn" onclick="applyImprove()" style="font-size:11px;padding:4px 12px">⚡ Build & Send</button>
      <button class="btn-cancel" onclick="hideImprovePanel()" style="font-size:11px;padding:4px 12px">Cancel</button>
    </div>`;
  el.classList.add('visible');
  setSendEnabled(true);
}

function toggleImproveNode(idx) {
  if (improveSelected.has(idx)) improveSelected.delete(idx);
  else improveSelected.add(idx);
  const nodes = document.querySelectorAll('.improve-node');
  nodes.forEach((n, i) => n.classList.toggle('selected', improveSelected.has(i)));
}

async function explainNode(idx) {
  const s = improveSymbols[idx];
  if (!s) return;
  let modal = document.getElementById('diff-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diff-modal';
    modal.className = 'diff-modal-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  const title = s.kind === 'kb' ? `📚 ${s.name}` : `${s.kind} ${s.name} — ${s.file}:${s.line}`;
  modal.innerHTML = `<div class="diff-modal">
    <div class="diff-modal-header">
      <span>${title}</span>
      <span style="cursor:pointer" onclick="document.getElementById('diff-modal').style.display='none'">✕</span>
    </div>
    <div class="diff-modal-body"><pre style="margin:0">${escapeHtml(s.preview || 'No preview')}</pre></div>
  </div>`;
  modal.style.display = 'flex';
}

async function applyImprove() {
  if (improveSelected.size === 0) {
    alert('Select at least one symbol to include');
    return;
  }
  const input = document.getElementById('input');
  const intent = input.value.trim();
  const proj = projects[openedProjects[activeTab]];
  const selectedNames = [...improveSelected].map(i => improveSymbols[i].name);

  let prompt;
  if (cvActiveHash) {
    prompt = await window.go.main.App.BuildPrompt(proj.name, cvActiveHash, intent, selectedNames);
  } else {
    let parts = ['## Task\n' + intent, '\n## Relevant Code'];
    for (const i of improveSelected) {
      const s = improveSymbols[i];
      parts.push(`\n### ${s.kind} \`${s.name}\` (${s.file})\n\`\`\`\n${s.preview}\n\`\`\``);
    }
    prompt = parts.join('\n');
  }

  hideImprovePanel();
  input.value = '';

  window._multiExplainPrompt = prompt;
  showAgentPickerForPrompt();
}

function hideImprovePanel() {
  improveSymbols = [];
  improveSelected.clear();
  const el = document.getElementById('injection-preview');
  el.innerHTML = '';
  el.classList.remove('visible');
}

// --- Context Optimization ---
async function compressAgent(sessionID) {
  if (!confirm('Compress context? This will respawn the agent with a summarized conversation.')) return;
  const el = document.getElementById('tokens-' + sessionID);
  if (el) el.textContent = '🗜...';
  const result = await window.go.main.App.CompressAgent(sessionID);
  if (result.startsWith('error:')) {
    alert(result);
  }
  setTimeout(() => refreshTokenCount(sessionID), 5000);
}

async function refreshTokenCount(sessionID) {
  const info = await window.go.main.App.CheckTokens(sessionID);
  updateTokenDisplay(sessionID, info);
}

function updateTokenDisplay(sessionID, info) {
  const el = document.getElementById('tokens-' + sessionID);
  if (!el || !info) return;
  const pct = Math.round((info.tokens / info.threshold) * 100);
  el.textContent = `${info.tokens}t`;
  el.style.color = pct > 90 ? '#da3633' : pct > 70 ? '#d29922' : '#8b949e';
  if (info.tokens > info.threshold) {
    el.textContent = `⚠ ${info.tokens}t`;
  }
}

// Periodically check token counts for all panes
setInterval(() => {
  Object.keys(panes).forEach(sid => refreshTokenCount(sid));
}, 60000);
