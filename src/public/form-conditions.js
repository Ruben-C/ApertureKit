// Shows and hides conditional questions on the member's form as answers
// change. The server applies the same rules when the form is sent
// (src/fields.js), so this only spares people questions that don't apply.
//
// Wires itself to the form carrying `data-conditions="<id>"`, where <id> is a
// <script type="application/json"> holding the fields as [{ id, type, showIf }],
// and every question sits in an element with data-field="<id>". Hidden
// questions are also disabled, so the browser neither insists on a required
// answer nobody can see nor sends whatever was typed before they were hidden.
// Their controls keep their values, so hiding and showing again loses nothing.

import { visibleIds } from './conditions.js';

const form = document.querySelector('form[data-conditions]');
const rules = form && JSON.parse(document.getElementById(form.dataset.conditions)?.textContent || 'null');

if (Array.isArray(rules)) {
  const types = Object.fromEntries(rules.map((f) => [f.id, f.type]));
  const wrappers = [...form.querySelectorAll('[data-field]')];

  // An answer as the server will see it: 'yes' / 'no' radios become Yes / No,
  // a file counts once one is chosen. Read straight from the controls rather
  // than FormData, so a question being shown again in this same pass still
  // counts the value it kept while hidden and disabled.
  const valueOf = (id) => {
    const named = form.elements.namedItem(id);
    const controls = named instanceof RadioNodeList ? [...named] : named ? [named] : [];
    return controls.flatMap((c) => {
      if (c.type === 'checkbox' || c.type === 'radio') {
        if (!c.checked) return [];
        return [types[id] === 'yesno' ? (c.value === 'yes' ? 'Yes' : 'No') : c.value];
      }
      if (c.type === 'file') return [...c.files].map((file) => file.name);
      return [c.value];
    });
  };

  const apply = () => {
    const shown = visibleIds(rules, valueOf);
    for (const wrap of wrappers) {
      const on = shown.has(wrap.dataset.field);
      if (wrap.hidden === !on) continue;
      wrap.hidden = !on;
      for (const control of wrap.querySelectorAll('input, select, textarea')) control.disabled = !on;
    }
  };

  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  apply();
}
