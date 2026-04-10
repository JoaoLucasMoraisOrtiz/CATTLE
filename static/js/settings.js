/* Settings — provider management */

async function loadProviders() {
  const el = document.getElementById('providers-list');
  try {
    const providers = await (await fetch(`${API}/settings/providers`)).json();
    el.innerHTML = providers.map(p => {
      const statusColor = p.authenticated ? 'bg-emerald-500' : p.installed ? 'bg-amber-400' : 'bg-red-500';
      const statusText = p.authenticated ? '✓ Autenticado' : p.installed ? '⚠ Não autenticado' : '✗ Não instalado';
      return `<div class="flex items-center justify-between p-4 rounded-xl border border-border bg-card">
        <div class="flex items-center gap-3">
          <span class="w-2.5 h-2.5 rounded-full ${statusColor}"></span>
          <div>
            <div class="text-sm font-medium text-white">${escHtml(p.name)}</div>
            <div class="text-[10px] text-muted">${escHtml(p.version || 'não instalado')}</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted">${statusText}</span>
          ${p.installed && !p.authenticated ? `<button onclick="authProvider('${escHtml(p.name)}')" class="px-3 py-1 bg-accent/10 text-accent text-xs rounded-lg hover:bg-accent/20 transition">Login</button>` : ''}
          ${p.installed ? `<button onclick="testProvider('${escHtml(p.name)}')" class="px-3 py-1 bg-surface border border-border text-xs text-muted rounded-lg hover:text-white transition">Testar</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<p class="text-xs text-red-400">Erro ao carregar provedores</p>';
  }
}

async function testProvider(name) {
  const el = document.getElementById('providers-list');
  const btn = el.querySelector(`button[onclick*="testProvider('${name}')"]`);
  if (btn) { btn.textContent = '⏳...'; btn.disabled = true; }
  await loadProviders();
}

function authProvider(name) {
  // Open auth modal with instructions
  const modal = document.getElementById('auth-modal');
  const title = document.getElementById('auth-modal-title');
  const body = document.getElementById('auth-modal-body');
  title.textContent = `Login — ${name}`;
  if (name === 'gemini') {
    body.innerHTML = `<div class="space-y-3 text-sm text-gray-400">
      <p>Execute no terminal:</p>
      <code class="block bg-surface rounded-lg px-4 py-2 text-xs font-mono text-white">gemini</code>
      <p>Siga as instruções de autenticação do Gemini CLI (Google Sign-in ou API Key).</p>
      <p>Quando terminar, clique em <b class="text-white">Pronto</b>.</p>
    </div>`;
  } else if (name === 'kiro') {
    body.innerHTML = `<div class="space-y-3 text-sm text-gray-400">
      <p>Execute no terminal:</p>
      <code class="block bg-surface rounded-lg px-4 py-2 text-xs font-mono text-white">kiro-cli chat</code>
      <p>O Kiro CLI usa autenticação automática. Se precisar reconfigurar, siga as instruções na tela.</p>
      <p>Quando terminar, clique em <b class="text-white">Pronto</b>.</p>
    </div>`;
  }
  modal.classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
  loadProviders();
}
