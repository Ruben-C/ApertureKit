// Small enhancements shared by every page. Nothing here is required: each
// page works from the server-rendered HTML alone, and this only makes it
// nicer once it is running. Each block finds its markup by data attribute
// and stays quiet when the page has none.

// --- Top bar: mobile menu button and the account menu ----------------------
const toggle = document.querySelector('[data-nav-toggle]');
if (toggle) {
  toggle.addEventListener('click', () => {
    const open = toggle.closest('.topbar').classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}
for (const menu of document.querySelectorAll('[data-menu]')) {
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); } });
}

// --- Toasts: dismiss button and auto-hide for anything but errors ----------
for (const toast of document.querySelectorAll('.toast')) {
  const remove = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 200); };
  toast.querySelector('[data-dismiss]')?.addEventListener('click', remove);
  if (!toast.classList.contains('toast-error')) {
    let timer = setTimeout(remove, 6000);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => { timer = setTimeout(remove, 3000); });
  }
}

// --- Dialogs: [data-dialog-open="id"] opens <dialog id>, [data-dialog-close] closes
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-dialog-open]');
  if (opener) {
    const dialog = document.getElementById(opener.dataset.dialogOpen);
    if (dialog?.showModal) { e.preventDefault(); dialog.showModal(); dialog.querySelector('input, select, textarea')?.focus(); }
    return;
  }
  const closer = e.target.closest('[data-dialog-close]');
  if (closer) closer.closest('dialog')?.close();
});
// A dialog that opened because the server sent back an error stays open.
document.querySelector('dialog[data-open]')?.showModal?.();

// --- Buttons show they are busy once a form is on its way ------------------
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form.dataset.noBusy !== undefined) return;
  const btn = e.submitter || form.querySelector('button[type=submit], button:not([type])');
  if (!btn || btn.formNoValidate && btn.value === 'delete') return;
  // Let the request start first; a second submit from a double click is ignored.
  setTimeout(() => { btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true'); }, 0);
});

// --- Live filter: [data-filter] input hides [data-filter-item]s that do not match
for (const input of document.querySelectorAll('[data-filter]')) {
  const scope = document.getElementById(input.dataset.filter) || document;
  const items = [...scope.querySelectorAll('[data-filter-item]')];
  const groups = [...scope.querySelectorAll('[data-filter-group]')];
  const empty = scope.querySelector('[data-filter-empty]');
  const count = scope.querySelector('[data-filter-count]');
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const item of items) {
      const hit = !q || item.textContent.toLowerCase().includes(q);
      item.hidden = !hit;
      if (hit) shown++;
    }
    for (const group of groups) group.hidden = !!q && ![...group.querySelectorAll('[data-filter-item]')].some((i) => !i.hidden);
    if (empty) empty.hidden = shown > 0;
    if (count) count.textContent = q ? `${shown} of ${items.length}` : String(items.length);
  };
  input.addEventListener('input', apply);
  input.closest('form')?.addEventListener('submit', (e) => e.preventDefault());
  if (input.value) apply();
}

// --- Settings: one section at a time, chosen from the sidebar or the hash --
const sections = [...document.querySelectorAll('.settings-section[id]')];
if (sections.length) {
  const links = [...document.querySelectorAll('[data-section-link]')];
  const show = (id, focus) => {
    const target = sections.find((s) => s.id === id) || sections[0];
    for (const s of sections) s.toggleAttribute('data-active', s === target);
    for (const a of links) {
      if (a.getAttribute('href').endsWith('#' + target.id)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (focus) {
      const h = target.querySelector('h2');
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
      if (window.scrollY > 200) window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  show(location.hash.slice(1));
  window.addEventListener('hashchange', () => show(location.hash.slice(1), true));
}

// --- Forms with a save bar: say when there are unsaved changes -------------
for (const form of document.querySelectorAll('form[data-dirty-watch]')) {
  const bar = form.querySelector('[data-dirty-note]');
  const initial = new FormData(form);
  const snapshot = (fd) => [...fd.entries()].filter(([, v]) => !(v instanceof File)).map(([k, v]) => `${k}=${v}`).join('&');
  const before = snapshot(initial);
  let dirty = false;
  const check = () => {
    dirty = snapshot(new FormData(form)) !== before || [...form.querySelectorAll('input[type=file]')].some((i) => i.files.length);
    if (bar) bar.hidden = !dirty;
  };
  form.addEventListener('input', check);
  form.addEventListener('change', check);
  form.addEventListener('submit', () => { dirty = false; });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}
