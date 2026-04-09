/* ReDo! — Centralized API fetch wrapper */

async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      showToast(msg || `Erro ${res.status}`, 'error');
      return { ok: false, data: null, error: msg };
    }
    const data = res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : await res.text();
    return { ok: true, data, error: null };
  } catch (e) {
    showToast(`Falha de rede: ${e.message}`, 'error');
    return { ok: false, data: null, error: e.message };
  }
}

function apiGet(url) {
  return apiFetch(url);
}

function apiPost(url, body) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function apiPut(url, body) {
  return apiFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function apiDelete(url) {
  return apiFetch(url, { method: 'DELETE' });
}
