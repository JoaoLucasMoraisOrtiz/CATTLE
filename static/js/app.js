/* ReDo! — App initialization, tabs, keyboard shortcuts */

function switchTab(tab) {
  document.querySelectorAll('[id^="view-"]').forEach(v => { v.classList.add('hidden'); v.style.display = ''; });
  document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('bg-accent/10','text-accent'); b.classList.add('text-muted'); });
  const view = document.getElementById('view-' + tab);
  view.classList.remove('hidden');
  view.style.display = 'flex';
  document.getElementById('tab-' + tab).classList.add('bg-accent/10','text-accent');
  document.getElementById('tab-' + tab).classList.remove('text-muted');
  if (tab === 'flow') initDrawflow();
}

// ── Scroll-to-bottom ─────────────────────────────────────────────────────
(function(){
  const sc = document.getElementById('chat-scroll'), btn = document.getElementById('scroll-to-bottom');
  sc.addEventListener('scroll', () => btn.classList.toggle('visible', !isNearBottom(sc)));
  btn.addEventListener('click', () => sc.scrollTo({top: sc.scrollHeight, behavior:'smooth'}));
})();

// ── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => { if (e.key==='Escape') { closeModal(); closeProjectModal(); closeHeaderModal(); } });
loadAgents();
loadProjects();
loadFlows();
loadHeaders();
loadSettings();
