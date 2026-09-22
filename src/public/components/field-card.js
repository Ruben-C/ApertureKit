// <field-card>: one question in the form builder. Owns its editing UI and
// writes straight into the field object it was given; tells its parent about
// changes and toolbar actions through events, so it never needs to know what
// list it sits in.
//
// Renders into light DOM on purpose: the page stylesheet (.field, .choice,
// .icon-btn, .card) applies to it as-is, and the inputs stay ordinary form
// controls for keyboard and assistive tech. Uses <option-list> for choices
// and <question-preview> for the live member's-eye view; both must be
// defined before a card renders (the page loads them first). The type glyphs
// (header, preview label, type picker) are <use href="#ficon-TYPE">, so the
// page must carry a sprite with one <symbol> per type.
//
//   card.field  -> the field object (read/write)
//   card.types  -> FIELD_TYPES map, for the type switcher and per-type controls
//   card.index / card.count -> position, used to disable the move buttons
//   card.before -> the fields above this one, offered as "show when" targets
//
//   'field-change'  detail: { field, prop }     a control was edited
//   'field-action'  detail: { action }          'up' | 'down' | 'remove'
//   'field-drop'    detail: { from }            another card was dropped here

import { OPS, choicesOf } from '../conditions.js';

const TEMPLATE = document.createElement('template');
TEMPLATE.innerHTML = `
  <div class="fcard-bar">
    <svg class="ficon fcard-icon" aria-hidden="true" focusable="false"><use data-icon/></svg>
    <label class="fcard-type"><span class="visually-hidden">Question type</span><select data-prop="type"><button type="button"><selectedcontent></selectedcontent></button></select></label>
    <span class="fcard-tools">
      <button type="button" class="icon-btn" data-act="up" aria-label="Move up" title="Move up">↑</button>
      <button type="button" class="icon-btn" data-act="down" aria-label="Move down" title="Move down">↓</button>
      <button type="button" class="icon-btn" data-act="remove" aria-label="Remove question" title="Remove">✕</button>
    </span>
  </div>
  <div class="fcard-body">
    <div class="fcard-edit">
      <label class="field"><span>Question</span><input data-prop="label" maxlength="200"></label>
      <label class="field"><span>Help text</span><input data-prop="help" maxlength="500" placeholder="Optional hint shown under the question"></label>
      <label class="field" data-only="text textarea email number"><span>Placeholder</span><input data-prop="placeholder" maxlength="200"></label>
      <div class="field" data-only="select radio checkbox"><span>Options</span><option-list></option-list></div>
      <label class="choice" data-not="heading"><input type="checkbox" data-prop="required"><span>Required</span></label>
      <div class="field fcard-cond">
        <span data-cond-title>Show this question</span>
        <div class="cond-row">
          <label><span class="visually-hidden">Depending on</span><select data-cond="field"></select></label>
          <label data-cond-part="op"><span class="visually-hidden">Condition</span><select data-cond="op"></select></label>
          <label data-cond-part="value"><span class="visually-hidden">Answer</span><select data-cond="value"></select></label>
        </div>
        <small data-cond-help></small>
      </div>
    </div>
    <div class="fcard-preview">
      <div class="fcard-preview-label"><svg class="ficon" aria-hidden="true" focusable="false"><use data-icon/></svg>Preview</div>
      <question-preview></question-preview>
    </div>
  </div>
`;

let nextKey = 1;

// An <option> carrying the type's glyph and its label. Browsers that render
// the switcher as a customizable select show both; a native select shows the
// text alone, so nothing is lost either way.
function typeOption(key, label) {
  const opt = document.createElement('option');
  opt.value = key;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ficon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ficon-${key}`);
  svg.append(use);
  opt.append(svg, label);
  return opt;
}

export class FieldCard extends HTMLElement {
  #field = null;
  #types = {};
  #index = 0;
  #count = 1;
  #before = [];
  #rendered = false;
  #stashedOptions = null;
  // Stable identity across re-renders, so view transitions can track the card.
  key = `fcard-${nextKey++}`;

  get field() { return this.#field; }
  set field(f) { this.#field = f; this.#render(); }

  get types() { return this.#types; }
  set types(t) { this.#types = t || {}; this.#render(); }

  get index() { return this.#index; }
  set index(i) { this.#index = i; this.#updateTools(); }

  get count() { return this.#count; }
  set count(n) { this.#count = n; this.#updateTools(); }

  get before() { return this.#before; }
  set before(list) { this.#before = list || []; this.#renderCondition(); }

  connectedCallback() {
    if (this.#rendered) return;
    this.classList.add('card');
    this.setAttribute('role', 'listitem');
    this.draggable = true;
    this.style.viewTransitionName = this.key;

    this.addEventListener('input', this.#onInput);
    this.addEventListener('options-change', this.#onOptionsChange);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('dragstart', this.#onDragStart);
    this.addEventListener('dragover', this.#onDragOver);
    this.addEventListener('dragleave', this.#onDragLeave);
    this.addEventListener('drop', this.#onDrop);
    this.addEventListener('dragend', this.#onDragEnd);
    this.#render();
  }

  // Eases a freshly added card into place, then puts the cursor in its label.
  enter() {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.animate(
        [{ opacity: 0, transform: 'translateY(-.4rem)' }, { opacity: 1, transform: 'none' }],
        { duration: 250, easing: 'ease-out' },
      );
    }
    this.scrollIntoView({ block: 'nearest' });
    this.focusLabel();
  }

  focusLabel() {
    this.querySelector('[data-prop="label"]')?.focus();
  }

  // Focuses a toolbar button; if it has just become disabled (card reached
  // the top or bottom), the opposite move button keeps keyboard users going.
  focusTool(action) {
    const btn = this.querySelector(`[data-act="${action}"]`);
    if (!btn) return;
    if (!btn.disabled) return btn.focus();
    const other = { up: 'down', down: 'up' }[action];
    this.querySelector(`[data-act="${other}"]:not(:disabled)`)?.focus();
  }

  #render() {
    if (!this.isConnected || !this.#field) return;
    const f = this.#field;
    if (!this.#rendered) {
      this.replaceChildren(TEMPLATE.content.cloneNode(true));
      this.#rendered = true;
    }
    // The <button> must stay first: it is the closed face of the select in
    // browsers that render it as a customizable select (see .fcard-type CSS).
    const typeSelect = this.querySelector('[data-prop="type"]');
    const face = typeSelect.querySelector(':scope > button');
    typeSelect.replaceChildren(...(face ? [face] : []), ...Object.entries(this.#types).map(([key, t]) => typeOption(key, t.label)));
    if (!this.#types[f.type]) typeSelect.append(new Option(f.type, f.type));
    typeSelect.value = f.type;
    // Glyphs (header bar and preview label) from the page's sprite; an
    // unknown type just gets an empty box.
    this.querySelectorAll('[data-icon]').forEach((u) => u.setAttribute('href', `#ficon-${f.type}`));
    // Per-type controls: data-only lists the types that get a control,
    // data-not the types that don't. Hidden rather than removed, so the card
    // can switch type without rebuilding.
    this.querySelectorAll('[data-only]').forEach((el) => {
      el.hidden = !el.dataset.only.split(' ').includes(f.type);
    });
    this.querySelectorAll('[data-not]').forEach((el) => {
      el.hidden = el.dataset.not.split(' ').includes(f.type);
    });
    this.querySelectorAll('[data-prop]').forEach((input) => {
      const prop = input.dataset.prop;
      if (prop === 'required') input.checked = !!f.required;
      else if (prop !== 'type') input.value = f[prop] || '';
    });
    const options = this.querySelector('option-list');
    options.kind = f.type;
    options.options = f.options || [];
    this.#updateTools();
    this.#renderCondition();
    this.#preview();
  }

  #preview() {
    this.querySelector('question-preview').field = this.#field;
  }

  // The "show when" row: which question above this one to watch, how to
  // compare, and (for is / is not) which of its answers. Rebuilt whenever the
  // fields above change, since their wording and options are what it lists.
  #renderCondition() {
    if (!this.#rendered || !this.#field) return;
    const f = this.#field;
    const rule = f.showIf;
    const targets = this.#before
      .map((t, i) => ({ t, n: i + 1 }))
      .filter(({ t }) => !this.#types[t.type]?.display);
    const target = targets.find(({ t }) => t.id === rule?.field)?.t;
    const choices = choicesOf(target);
    const ops = choices.length ? Object.keys(OPS) : ['answered', 'empty'];

    this.querySelector('[data-cond-title]').textContent = f.type === 'heading' ? 'Show this section' : 'Show this question';

    const fieldSel = this.querySelector('[data-cond="field"]');
    fieldSel.replaceChildren(
      new Option('Always', ''),
      ...targets.map(({ t, n }) => new Option(`when ${n}. ${t.label?.trim() || 'Untitled question'}`, t.id)),
    );
    fieldSel.value = target ? target.id : '';
    fieldSel.disabled = targets.length === 0;

    const opSel = this.querySelector('[data-cond="op"]');
    opSel.replaceChildren(...ops.map((k) => new Option(OPS[k], k)));
    opSel.value = ops.includes(rule?.op) ? rule.op : ops[0];
    this.querySelector('[data-cond-part="op"]').hidden = !target;

    const valueSel = this.querySelector('[data-cond="value"]');
    const wantsValue = !!target && (opSel.value === 'is' || opSel.value === 'not');
    // An answer that was renamed or removed stays selectable, flagged, so the
    // editor sees why the server will not save it until it is fixed.
    const stale = wantsValue && rule?.value !== undefined && !choices.includes(rule.value);
    valueSel.replaceChildren(
      ...choices.map((c) => new Option(c, c)),
      ...(stale ? [new Option(`${rule.value} (no longer an answer)`, rule.value)] : []),
    );
    if (wantsValue) valueSel.value = rule.value;
    this.querySelector('[data-cond-part="value"]').hidden = !wantsValue;

    const help = this.querySelector('[data-cond-help]');
    help.textContent = !targets.length
      ? 'Add a question above this one to show it only for certain answers.'
      : f.type === 'heading'
        ? 'Hides this heading and every question under it, up to the next heading.'
        : '';
    help.hidden = !help.textContent;
  }

  // Edits one part of the rule, keeping the rest sensible: a new target starts
  // with its first answer, and is / is not fall back to the first answer when
  // the current one is not among its choices.
  #setCondition(part, value) {
    const f = this.#field;
    if (part === 'field') {
      if (!value) { delete f.showIf; return; }
      const target = this.#before.find((t) => t.id === value);
      f.showIf = choicesOf(target).length ? { field: value, op: 'is', value: choicesOf(target)[0] } : { field: value, op: 'answered' };
      return;
    }
    if (!f.showIf) return;
    if (part === 'op') {
      f.showIf.op = value;
      const choices = choicesOf(this.#before.find((t) => t.id === f.showIf.field));
      if (value === 'is' || value === 'not') { if (!choices.includes(f.showIf.value)) f.showIf.value = choices[0]; }
      else delete f.showIf.value;
    }
    if (part === 'value') f.showIf.value = value;
  }

  // Switching type keeps the wording and drops settings the new type has no
  // use for, so the JSON stays as clean as the server would make it. Options
  // are remembered on the card, so a wrong click can be undone by switching back.
  #setType(type) {
    const f = this.#field;
    f.type = type;
    const t = this.#types[type] || {};
    if (t.hasOptions) f.options = f.options?.length ? f.options : this.#stashedOptions || ['Option 1', 'Option 2'];
    else if (f.options) { this.#stashedOptions = f.options; delete f.options; }
    if (t.display) f.required = false;
    if (!['text', 'textarea', 'email', 'number'].includes(type)) delete f.placeholder;
    this.#render();
  }

  #updateTools() {
    if (!this.#rendered) return;
    this.querySelector('[data-act="up"]').disabled = this.#index === 0;
    this.querySelector('[data-act="down"]').disabled = this.#index >= this.#count - 1;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  #onInput = (e) => {
    if (!this.#field) return;
    const f = this.#field;
    const cond = e.target.dataset.cond;
    if (cond) {
      this.#setCondition(cond, e.target.value);
      this.#renderCondition();
      this.#emit('field-change', { field: f, prop: 'showIf' });
      return;
    }
    const prop = e.target.dataset.prop;
    if (!prop) return;
    if (prop === 'type') this.#setType(e.target.value);
    else if (prop === 'required') f.required = e.target.checked;
    else f[prop] = e.target.value;
    this.#preview();
    this.#emit('field-change', { field: f, prop });
  };

  #onOptionsChange = (e) => {
    // Blank rows stay in the editor while typing but never reach the schema.
    this.#field.options = e.detail.options.map((o) => o.trim()).filter(Boolean);
    this.#preview();
    this.#emit('field-change', { field: this.#field, prop: 'options' });
  };

  #onClick = (e) => {
    const btn = e.target.closest('.fcard-tools button[data-act]');
    if (btn) this.#emit('field-action', { action: btn.dataset.act });
  };

  // Drag to reorder. The card being dragged advertises its index through the
  // dataTransfer payload; the card it lands on reports the drop.
  #onDragStart = (e) => {
    // Dragging from inside an input should select text, not move the card.
    if (e.target !== this) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(this.#index));
    this.classList.add('dragging');
  };

  #onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!this.classList.contains('dragging')) this.classList.add('drop-target');
  };

  #onDragLeave = (e) => {
    if (!this.contains(e.relatedTarget)) this.classList.remove('drop-target');
  };

  #onDrop = (e) => {
    e.preventDefault();
    this.classList.remove('drop-target');
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isInteger(from) && from !== this.#index) this.#emit('field-drop', { from });
  };

  #onDragEnd = () => {
    this.classList.remove('dragging', 'drop-target');
  };
}

customElements.define('field-card', FieldCard);
