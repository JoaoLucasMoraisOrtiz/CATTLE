/* ReDo! — Utility functions */

const API = '/api';

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function ts() {
  return new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isNearBottom(el, threshold=100) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
}

/* ── Toast system ── */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.setAttribute('role', 'alert');
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

/* ── Loading state for buttons ── */
function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.dataset.origText = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
    btn.disabled = false;
  }
}

/* ── Form validation ── */
function validateRequired(fields) {
  let valid = true;
  for (const { el, name } of fields) {
    el.classList.remove('field-error');
    if (!el.value.trim()) {
      el.classList.add('field-error');
      valid = false;
    }
  }
  if (!valid) showToast('Preencha os campos obrigatórios', 'warning');
  return valid;
}
