/* ReDo! — Projects CRUD */

async function loadProjects() {
  projectsList = await (await fetch(`${API}/projects`)).json();
  const sel = document.getElementById('project-select');
  const cur = sel?.value;
  sel.innerHTML = '<option value="">Selecione um projeto...</option>' +
    projectsList.map(p => `<option value="${p.id}" ${p.id===cur?'selected':''}>${p.name} — ${p.path}</option>`).join('');
}

function openProjectModal() { document.getElementById('project-modal').classList.remove('hidden'); }
function closeProjectModal() { document.getElementById('project-modal').classList.add('hidden'); }

async function saveProject() {
  const name = document.getElementById('p-name').value.trim();
  const path = document.getElementById('p-path').value.trim();
  if (!name || !path) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await fetch(`${API}/projects`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,name,path}) });
  closeProjectModal();
  await loadProjects();
  document.getElementById('project-select').value = id;
  onProjectChange();
}

async function deleteProject() {
  const id = document.getElementById('project-select').value;
  if (!id || !confirm('Remover projeto?')) return;
  await fetch(`${API}/projects/${id}`, {method:'DELETE'});
  loadProjects();
}
