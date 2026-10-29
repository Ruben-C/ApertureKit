import { OPS, choicesOf, visibleIds } from './public/conditions.js';

// Field types a form can contain. `hasOptions` types take a list of choices.
export const FIELD_TYPES = {
  text:     { label: 'Short answer' },
  textarea: { label: 'Long answer' },
  email:    { label: 'Email' },
  number:   { label: 'Number' },
  date:     { label: 'Date' },
  select:   { label: 'Dropdown', hasOptions: true },
  radio:    { label: 'Choose one', hasOptions: true },
  checkbox: { label: 'Choose several', hasOptions: true },
  yesno:    { label: 'Yes / no' },
  file:     { label: 'File upload' },
  heading:  { label: 'Section heading', display: true },
};

const MAX_FIELDS = 100;

// Turns whatever the builder posted into a clean, trusted schema.
export function sanitizeFields(input) {
  let raw;
  try {
    raw = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    throw new Error('Fields are not valid JSON.');
  }
  if (!Array.isArray(raw)) throw new Error('Fields must be a list.');
  if (raw.length > MAX_FIELDS) throw new Error(`A form can have at most ${MAX_FIELDS} fields.`);

  const seen = new Set();
  const fields = raw.map((f, i) => {
    const type = FIELD_TYPES[f?.type] ? f.type : 'text';
    let id = String(f?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `f${i + 1}`;
    while (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    const field = {
      id,
      type,
      label: String(f?.label || '').trim().slice(0, 200) || `Question ${i + 1}`,
      help: String(f?.help || '').trim().slice(0, 500),
      required: !FIELD_TYPES[type].display && !!f?.required,
    };
    if (FIELD_TYPES[type].hasOptions) {
      const options = Array.isArray(f?.options) ? f.options : String(f?.options || '').split('\n');
      field.options = [...new Set(options.map((o) => String(o).trim().slice(0, 200)).filter(Boolean))].slice(0, 100);
      if (field.options.length === 0) field.options = ['Option 1'];
    }
    if (type === 'text' || type === 'textarea' || type === 'email' || type === 'number') {
      field.placeholder = String(f?.placeholder || '').trim().slice(0, 200);
    }
    return field;
  });

  // Show-when rules, once every id is settled. The builder only offers valid
  // choices, so a bad rule means hand-edited JSON: say what is wrong rather
  // than quietly dropping it.
  raw.forEach((f, i) => {
    const rule = f?.showIf;
    if (!rule || typeof rule !== 'object') return;
    const field = fields[i];
    const target = fields.slice(0, i).find((t) => t.id === rule.field && !FIELD_TYPES[t.type].display);
    if (!target) throw new Error(`"${field.label}" is shown depending on a question that is not above it.`);
    if (!OPS[rule.op]) throw new Error(`"${field.label}" has an unknown condition "${rule.op}".`);
    field.showIf = { field: target.id, op: rule.op };
    if (rule.op === 'is' || rule.op === 'not') {
      const value = String(rule.value ?? '');
      if (!choicesOf(target).includes(value)) {
        throw new Error(`"${field.label}" is shown when "${target.label}" ${OPS[rule.op]} "${value}", which is not one of its answers.`);
      }
      field.showIf.value = value;
    }
  });
  return fields;
}

// Validates a submission against a schema. Returns { answers, errors }.
// `files` maps field id -> uploaded file (from multer), for file fields.
// Fields hidden by a show-when rule are left out of `answers` altogether
// and never raise an error, whatever was posted for them.
export function validateSubmission(fields, body, files = {}) {
  const answers = {};
  const errors = {};
  for (const f of fields) {
    if (FIELD_TYPES[f.type].display) continue;
    const raw = body[f.id];
    let value;
    switch (f.type) {
      case 'checkbox': {
        const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((o) => f.options.includes(o));
        value = picked;
        if (f.required && picked.length === 0) errors[f.id] = 'Pick at least one.';
        break;
      }
      case 'select':
      case 'radio': {
        value = typeof raw === 'string' && f.options.includes(raw) ? raw : '';
        if (f.required && !value) errors[f.id] = 'Choose an option.';
        break;
      }
      case 'yesno':
        value = raw === 'yes' ? 'Yes' : raw === 'no' ? 'No' : '';
        if (f.required && !value) errors[f.id] = 'Choose yes or no.';
        break;
      case 'number': {
        const s = String(raw ?? '').trim().slice(0, 100);
        value = s;
        if (s && !Number.isFinite(Number(s))) errors[f.id] = 'Enter a number.';
        else if (f.required && !s) errors[f.id] = 'This field is required.';
        break;
      }
      case 'email': {
        const s = String(raw ?? '').trim().slice(0, 320);
        value = s;
        if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errors[f.id] = 'Enter a valid email address.';
        else if (f.required && !s) errors[f.id] = 'This field is required.';
        break;
      }
      case 'date': {
        const s = String(raw ?? '').trim();
        value = s;
        if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[f.id] = 'Enter a date.';
        else if (f.required && !s) errors[f.id] = 'This field is required.';
        break;
      }
      case 'file': {
        const file = files[f.id];
        value = file ? file.originalname : '';
        if (f.required && !file) errors[f.id] = 'Attach a file.';
        break;
      }
      default: {
        const s = String(raw ?? '').trim().slice(0, f.type === 'textarea' ? 20000 : 2000);
        value = s;
        if (f.required && !s) errors[f.id] = 'This field is required.';
      }
    }
    answers[f.id] = value;
  }
  // Rules only look upwards and skip hidden targets, so the answers above
  // are enough to settle every rule in one pass.
  const shown = visibleIds(fields, (id) => answers[id]);
  for (const f of fields) {
    if (shown.has(f.id)) continue;
    delete answers[f.id];
    delete errors[f.id];
  }
  return { answers, errors };
}
