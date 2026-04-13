/* ReDo! — App initialization, tabs, keyboard shortcuts */

const TAB_ORDER = ['agents', 'flow', 'headers', 'run'];

function switchTab(tab) {
  document.querySelectorAll('[id^="view-"]').forEach(v => { v.classList.add('hidden'); v.style.display = ''; });
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('bg-accent/10','text-accent');
    b.classList.add('text-muted');
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('tabindex', '-1');
  });
  const view = document.getElementById('view-' + tab);
  view.classList.remove('hidden');
  view.style.display = 'flex';
  const btn = document.getElementById('tab-' + tab);
  btn.classList.add('bg-accent/10','text-accent');
  btn.classList.remove('text-muted');
  btn.setAttribute('aria-selected', 'true');
  btn.setAttribute('tabindex', '0');
  if (tab === 'flow') initDrawflow();
  if (tab === 'settings') loadProviders();
  if (tab === 'run') renderRunUI();
}

// ── ARIA keyboard navigation for tabs ────────────────────────────────────
document.querySelector('[role="tablist"]')?.addEventListener('keydown', e => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
  e.preventDefault();
  const current = TAB_ORDER.indexOf(document.querySelector('[aria-selected="true"]')?.id.replace('tab-',''));
  let next;
  if (e.key === 'ArrowRight') next = (current + 1) % TAB_ORDER.length;
  else if (e.key === 'ArrowLeft') next = (current - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  else if (e.key === 'Home') next = 0;
  else next = TAB_ORDER.length - 1;
  switchTab(TAB_ORDER[next]);
  document.getElementById('tab-' + TAB_ORDER[next]).focus();
});

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
addRunTab();
