// <form-builder>: the list of questions on the editor page. Keeps an array of
// field objects, shows one <field-card> per field, and mirrors the array into
// the JSON textarea the server actually reads. The page works without it
// (the textarea is editable), so this only ever enhances what's already there.
//
// Wires itself to markup the server rendered inside it:
//   [data-add]    buttons, one per type (data-add="email"); a click adds one
//   [data-list]   container the cards go in
//   [data-empty]  message shown when there are no questions
//   textarea      the JSON the form posts (attribute `for` = its id, or the
//                 first textarea inside)
//   `types`       attribute: id of a <script type="application/json"> holding
//                 the FIELD_TYPES map

export class FormBuilder extends HTMLElement {
  #fields = [];
  #types = {};
  #json = null;
  #list = null;
  #empty = null;

  async connectedCallback() {
    // Cards may be created before their definition has loaded; wait so the
    // properties we set land on a real FieldCard instance.
    await customElements.whenDefined('field-card');

    const forId = this.getAttribute('for');
    this.#json = (forId && document.getElementById(forId)) || this.querySelector('textarea');
    this.#list = this.querySelector('[data-list]');
    this.#empty = this.querySelector('[data-empty]');
    if (!this.#json || !this.#list || !this.querySelector('[data-add]')) return;

    this.#types = this.#readTypes();
    this.#fields = this.#readFields();
    // Existing fields keep their ids so past requests still line up with
    // them; any without one (pasted JSON) get one now, since show-when rules
    // point at ids and every field must have its own from the start.
    this.#fields.forEach((f, i) => {
      if (f.id) f.locked = true;
      else f.id = this.#uniqueId(idFor(f.label, i));
    });
    // With the builder running, the raw JSON is an advanced option: fold it away.
    const fallback = this.#json.closest('details');
    if (fallback) fallback.open = false;

    this.#list.setAttribute('role', 'list');
    this.addEventListener('click', (e) => {
      const type = e.target.closest('[data-add]')?.dataset.add;
      if (type && this.#types[type]) this.add(type);
    });
    this.addEventListener('field-change', this.#onFieldChange);
    this.addEventListener('field-action', this.#onFieldAction);
    this.addEventListener('field-drop', this.#onFieldDrop);

    this.#render();
  }

  get fields() { return this.#fields; }

  add(type) {
    const f = { id: this.#uniqueId(idFor('', this.#fields.length)), type, label: '', help: '', required: false };
    if (this.#types[type].hasOptions) f.options = ['Option 1', 'Option 2'];
    this.#fields.push(f);
    this.#render();
    this.#list.lastElementChild?.enter();
  }

  // Both resolve once the list has been re-rendered.
  remove(i) {
    this.#fields.splice(i, 1);
    return this.#transition(() => this.#render());
  }

  move(from, to) {
    if (to < 0 || to >= this.#fields.length || from === to) return Promise.resolve();
    const [moved] = this.#fields.splice(from, 1);
    this.#fields.splice(to, 0, moved);
    return this.#transition(() => this.#render());
  }

  #readTypes() {
    const id = this.getAttribute('types');
    const el = id && document.getElementById(id);
    try { return (el && JSON.parse(el.textContent)) || {}; } catch { return {}; }
  }

  #readFields() {
    try {
      const parsed = JSON.parse(this.#json.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  #cards() {
    return [...this.#list.children];
  }

  // `base`, or base_2, base_3… if another field already has it.
  #uniqueId(base, self) {
    let id = base;
    for (let n = 2; this.#fields.some((f) => f !== self && f.id === id); n++) id = `${base}_${n}`;
    return id;
  }

  // One card per field, reused across renders so typing never loses focus
  // and view transitions can follow a card to its new slot.
  #render() {
    this.#pruneRules();
    const existing = new Map(this.#cards().map((c) => [c.field, c]));
    const cards = this.#fields.map((f, i) => {
      const card = existing.get(f) || document.createElement('field-card');
      card.types = this.#types;
      card.field = f;
      card.index = i;
      card.count = this.#fields.length;
      card.before = this.#fields.slice(0, i);
      return card;
    });
    this.#list.replaceChildren(...cards);
    if (this.#empty) this.#empty.hidden = this.#fields.length > 0;
    this.#sync();
  }

  // A show-when rule can only point at a question above it. Once the target
  // is removed, moved below, or turned into a heading, the rule is dropped:
  // the card can't show it and the server would refuse it.
  #pruneRules() {
    this.#fields.forEach((f, i) => {
      if (!f.showIf) return;
      const target = this.#fields.slice(0, i).find((t) => t.id === f.showIf.field);
      if (!target || this.#types[target.type]?.display) delete f.showIf;
    });
  }

  // Cards below a field see it in their "show when" list, so a change to its
  // wording, options, or type has to reach them.
  #refreshRules() {
    this.#pruneRules();
    this.#cards().forEach((card, i) => { card.before = this.#fields.slice(0, i); });
  }

  #sync() {
    this.#json.value = JSON.stringify(this.#fields.map(({ locked, ...f }) => f), null, 2);
  }

  // Animates a re-render where the browser supports it; plain re-render
  // otherwise. Resolves once `update` has run (the animation may still be going).
  #transition(update) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!document.startViewTransition || reduce) { update(); return Promise.resolve(); }
    return document.startViewTransition(update).updateCallbackDone;
  }

  #onFieldChange = (e) => {
    const { field, prop } = e.detail;
    if (prop === 'label' && !field.locked) {
      const was = field.id;
      field.id = this.#uniqueId(idFor(field.label, this.#fields.indexOf(field)), field);
      // Rules on the cards below point at the id, so they follow the rename.
      if (field.id !== was) for (const f of this.#fields) if (f.showIf?.field === was) f.showIf.field = field.id;
    }
    if (prop === 'label' || prop === 'options' || prop === 'type') this.#refreshRules();
    this.#sync();
  };

  // Keep keyboard focus on the same button after the list has moved around.
  #onFieldAction = (e) => {
    const card = e.target;
    const i = this.#fields.indexOf(card.field);
    const { action } = e.detail;
    if (action === 'remove') {
      this.remove(i).then(() => this.#cards()[Math.min(i, this.#fields.length - 1)]?.focusTool('remove'));
    } else if (action === 'up') {
      this.move(i, i - 1).then(() => card.focusTool('up'));
    } else if (action === 'down') {
      this.move(i, i + 1).then(() => card.focusTool('down'));
    }
  };

  #onFieldDrop = (e) => {
    this.move(e.detail.from, this.#fields.indexOf(e.target.field));
  };
}

// Derives a stable-looking id from the question text: "Your name?" -> "your_name".
function idFor(label, i) {
  const base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return base || `q${i + 1}`;
}

customElements.define('form-builder', FormBuilder);
