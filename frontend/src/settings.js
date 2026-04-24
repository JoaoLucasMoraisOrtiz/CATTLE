// ReDo! v2 — Settings

async function showSettings() {
  try {
    const s = await window.go.main.App.GetSettings();
    document.getElementById('set-gemini').value = (s && s.gemini_api_key) || '';
    const sqliteOn = !s || s.sqlite_enabled !== 'false';
    document.getElementById('set-sqlite').checked = sqliteOn;
    document.getElementById('sqlite-warning').style.display = 'none';
  } catch(e) {
    console.error('[showSettings] error:', e);
  }
  document.getElementById('set-sqlite').onchange = function() {
    document.getElementById('sqlite-warning').style.display = this.checked ? 'none' : 'block';
  };
  document.getElementById('settings-modal').classList.add('active');
}

function closeSettings() { document.getElementById('settings-modal').classList.remove('active'); }

async function saveSettings() {
  const sqliteOn = document.getElementById('set-sqlite').checked;
  const wasOn = (await window.go.main.App.GetSettings()).sqlite_enabled !== 'false';

  if (wasOn && !sqliteOn) {
    if (!confirm('This will DELETE all stored data (embeddings, conversation history, KB chunks). Continue?')) return;
    await window.go.main.App.WipeSQLite();
  }

  const r = await window.go.main.App.SaveSettings(
    document.getElementById('set-gemini').value.trim(),
    sqliteOn,
  );
  closeSettings();
  if (r !== 'ok') alert(r);
}
