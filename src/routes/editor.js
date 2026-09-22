import { Router } from 'express';
import { one, all, run } from '../db.js';
import { requireRole } from '../auth.js';
import { sanitizeFields } from '../fields.js';

const router = Router();
router.use(requireRole('editor'));

// --- Categories --------------------------------------------------------------

router.get('/', (req, res) => {
  const categories = all(
    `SELECT c.*, COUNT(f.id) AS form_count, SUM(f.published) AS published_count
       FROM categories c LEFT JOIN forms f ON f.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order, c.name`,
  );
  const forms = all('SELECT id, category_id, slug, title, published, updated_at FROM forms ORDER BY sort_order, title');
  const byCategory = Object.groupBy(forms, (f) => f.category_id);
  res.render('editor/index', { title: 'Categories and forms', categories, byCategory });
});

router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) { req.flash('Give the category a name.', 'error'); return res.redirect('/editor'); }
  const last = one('SELECT MAX(sort_order) AS m FROM categories')?.m ?? 0;
  run(
    'INSERT INTO categories (slug, name, description, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    uniqueSlug('categories', name),
    name,
    String(req.body.description || '').trim().slice(0, 500),
    color(req.body.color),
    last + 1,
  );
  req.flash(`Added ${name}.`, 'success');
  res.redirect('/editor');
});

router.post('/categories/:id', (req, res) => {
  const cat = one('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!cat) return res.status(404).end();
  if (req.body.action === 'delete') {
    run('DELETE FROM categories WHERE id = ?', cat.id);
    req.flash(`Deleted ${cat.name} and its forms.`, 'success');
    return res.redirect('/editor');
  }
  if (req.body.action === 'up' || req.body.action === 'down') {
    swapOrder('categories', cat, req.body.action);
    return res.redirect('/editor');
  }
  const name = String(req.body.name || '').trim().slice(0, 100) || cat.name;
  run(
    'UPDATE categories SET name = ?, description = ?, color = ? WHERE id = ?',
    name,
    String(req.body.description || '').trim().slice(0, 500),
    color(req.body.color, cat.color),
    cat.id,
  );
  req.flash('Category saved.', 'success');
  res.redirect('/editor');
});

// --- Forms -------------------------------------------------------------------

router.get('/forms/new', (req, res) => {
  const categories = all('SELECT id, name FROM categories ORDER BY sort_order, name');
  if (!categories.length) { req.flash('Create a category first.', 'error'); return res.redirect('/editor'); }
  res.render('editor/form', {
    title: 'New form',
    form: { title: '', description: '', confirmation: '', fields: [], published: 0, category_id: Number(req.query.category) || categories[0].id },
    categories,
  });
});

router.post('/forms', (req, res) => saveForm(req, res, null));

router.get('/forms/:id', (req, res) => {
  const form = one('SELECT * FROM forms WHERE id = ?', req.params.id);
  if (!form) return res.status(404).render('error', { title: 'Form not found', message: 'It may have been deleted.' });
  form.fields = JSON.parse(form.fields);
  const categories = all('SELECT id, name FROM categories ORDER BY sort_order, name');
  res.render('editor/form', { title: `Edit: ${form.title}`, form, categories });
});

router.post('/forms/:id', (req, res) => {
  const form = one('SELECT * FROM forms WHERE id = ?', req.params.id);
  if (!form) return res.status(404).end();
  if (req.body.action === 'delete') {
    run('DELETE FROM forms WHERE id = ?', form.id);
    req.flash(`Deleted ${form.title}.`, 'success');
    return res.redirect('/editor');
  }
  if (req.body.action === 'publish' || req.body.action === 'unpublish') {
    run("UPDATE forms SET published = ?, updated_at = datetime('now') WHERE id = ?", req.body.action === 'publish' ? 1 : 0, form.id);
    req.flash(req.body.action === 'publish' ? 'Published.' : 'Unpublished. Members can no longer see this form.', 'success');
    return res.redirect('/editor');
  }
  if (req.body.action === 'up' || req.body.action === 'down') {
    swapOrder('forms', form, req.body.action, 'category_id');
    return res.redirect('/editor');
  }
  saveForm(req, res, form);
});

function saveForm(req, res, existing) {
  const categories = all('SELECT id, name FROM categories ORDER BY sort_order, name');
  const title = String(req.body.title || '').trim().slice(0, 150);
  const draft = {
    ...(existing || { published: 0 }),
    title,
    description: String(req.body.description || '').trim().slice(0, 2000),
    confirmation: String(req.body.confirmation || '').trim().slice(0, 2000),
    category_id: Number(req.body.category_id),
    published: req.body.published === '1' ? 1 : 0,
  };
  let fields;
  let error = null;
  try {
    fields = sanitizeFields(req.body.fields || '[]');
  } catch (e) {
    error = e.message;
  }
  if (!title) error = 'Give the form a title.';
  if (!categories.some((c) => c.id === draft.category_id)) error = 'Pick a category.';
  if (error) {
    draft.fields = safeParse(req.body.fields);
    return res.status(400).render('editor/form', { title: existing ? `Edit: ${existing.title}` : 'New form', form: draft, categories, error });
  }
  if (existing) {
    run(
      "UPDATE forms SET title = ?, description = ?, confirmation = ?, category_id = ?, fields = ?, published = ?, updated_at = datetime('now') WHERE id = ?",
      title, draft.description, draft.confirmation, draft.category_id, JSON.stringify(fields), draft.published, existing.id,
    );
    req.flash('Form saved.', 'success');
    return res.redirect(`/editor/forms/${existing.id}`);
  }
  const last = one('SELECT MAX(sort_order) AS m FROM forms WHERE category_id = ?', draft.category_id)?.m ?? 0;
  const r = run(
    'INSERT INTO forms (category_id, slug, title, description, confirmation, fields, published, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    draft.category_id, uniqueSlug('forms', title), title, draft.description, draft.confirmation, JSON.stringify(fields), draft.published, last + 1,
  );
  req.flash(draft.published ? 'Form created and published.' : 'Form created as a draft. Publish it when it is ready.', 'success');
  res.redirect(`/editor/forms/${Number(r.lastInsertRowid)}`);
}

// --- helpers -----------------------------------------------------------------

function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

function uniqueSlug(table, name) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; one(`SELECT 1 FROM ${table} WHERE slug = ?`, slug); n++) slug = `${base}-${n}`;
  return slug;
}

function color(input, fallback = '#2A4BC7') {
  return /^#[0-9a-fA-F]{6}$/.test(input || '') ? input.toUpperCase() : fallback;
}

function swapOrder(table, row, direction, scopeColumn) {
  const scope = scopeColumn ? `AND ${scopeColumn} = ?` : '';
  const scopeArgs = scopeColumn ? [row[scopeColumn]] : [];
  const rows = all(`SELECT id FROM ${table} WHERE 1=1 ${scope} ORDER BY sort_order, id`, ...scopeArgs).map((r) => r.id);
  // Normalise to 0..n so swapping is well-defined even with duplicate sort_order values.
  const idx = rows.indexOf(row.id);
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= rows.length) return;
  [rows[idx], rows[target]] = [rows[target], rows[idx]];
  rows.forEach((id, i) => run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, i, id));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}

export default router;
