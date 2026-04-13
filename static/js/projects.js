/* ReDo! — Projects CRUD */

async function loadProjects() {
  const r = await apiGet(`${API}/projects`);
  if (!r.ok) return;
  projectsList = r.data;
  const sel = document.getElementById('project-select');
  const cur = sel?.value;
  sel.innerHTML = '<option value="">Selecione um projeto...</option>' +
    projectsList.map(p => `<option value="${p.id}" ${p.id===cur?'selected':''}>${p.name} — ${p.path}</option>`).join('');
}

function openProjectModal() { document.getElementById('project-modal').classList.remove('hidden'); }
function closeProjectModal() { document.getElementById('project-modal').classList.add('hidden'); }

async function saveProject() {
  const fields = [
    { el: document.getElementById('p-name'), name: 'Nome' },
    { el: document.getElementById('p-path'), name: 'Caminho' },
  ];
  if (!validateRequired(fields)) return;
  const btn = document.querySelector('#project-modal .bg-accent');
  setLoading(btn, true);
  const name = fields[0].el.value.trim();
  const path = fields[1].el.value.trim();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const r = await apiPost(`${API}/projects`, {id, name, path});
  setLoading(btn, false);
  if (r.ok) {
    showToast('Projeto criado', 'success');
    closeProjectModal();
    fields[0].el.value = ''; fields[1].el.value = '';
    await loadProjects();
    document.getElementById('project-select').value = id;
    onProjectChange();
  }
}

async function deleteProject() {
  const id = document.getElementById('project-select').value;
  if (!id || !confirm('Remover projeto?')) return;
  const r = await apiDelete(`${API}/projects/${id}`);
  if (r.ok) {
    if (typeof removeRunTab === 'function') removeRunTab(id);
    loadProjects();
  }
}
