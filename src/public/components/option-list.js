// <option-list>: the choices for a dropdown / choose-one / choose-several
// question, one row each. Enter moves on to a new option, Backspace on an
// empty one removes it, so a list can be typed straight through.
//
//   list.options -> array of strings (read/write)
//   list.kind    -> 'select' | 'radio' | 'checkbox'; sets the row marker
//
//   'options-change'  detail: { options }   bubbles

const MARK = { radio: '○', checkbox: '☐' };

export class OptionList extends HTMLElement {
  #options = [];
  #kind = 'select';
  #ready = false;

  get options() { return this.#options; }
  set options(v) { this.#options = [...(v || [])]; this.#render(); }

  get kind() { return this.#kind; }
  set kind(k) { this.#kind = k; this.#render(); }

  connectedCallback() {
    if (this.#ready) return;
    this.#ready = true;
    this.addEventListener('input', this.#onInput);
    this.addEventListener('click', this.#onClick);
    this.addEventListener('keydown', this.#onKeydown);
    this.#render();
  }

  add(at = this.#options.length, value = '') {
    this.#options.splice(at, 0, value);
    this.#render();
    this.#emit();
    this.#focus(at);
  }

  remove(i) {
    if (this.#options.length <= 1) return;
    this.#options.splice(i, 1);
    this.#render();
    this.#emit();
    this.#focus(Math.max(0, i - 1));
  }

  #inputs() {
    return [...this.querySelectorAll('input')];
  }

  #focus(i) {
    const input = this.#inputs()[i];
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  #render() {
    if (!this.#ready) return;
    const rows = this.#options.map((o, i) => {
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML = `
        <span class="opt-mark" aria-hidden="true"></span>
        <input maxlength="200" placeholder="Option ${i + 1}" aria-label="Option ${i + 1}">
        <button type="button" class="icon-btn" data-act="remove" aria-label="Remove option" title="Remove option">✕</button>`;
      row.querySelector('.opt-mark').textContent = MARK[this.#kind] || String(i + 1);
      row.querySelector('input').value = o;
      row.querySelector('button').disabled = this.#options.length <= 1;
      return row;
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'linklike opt-add';
    add.dataset.act = 'add';
    add.textContent = 'Add option';
    this.replaceChildren(...rows, add);
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('options-change', { detail: { options: this.#options }, bubbles: true }));
  }

  #index(el) {
    return this.#inputs().indexOf(el.closest('.opt-row')?.querySelector('input'));
  }

  #onInput = (e) => {
    if (e.target.tagName !== 'INPUT') return;
    this.#options[this.#index(e.target)] = e.target.value;
    this.#emit();
  };

  #onClick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'add') this.add();
    if (btn.dataset.act === 'remove') this.remove(this.#index(btn));
  };

  #onKeydown = (e) => {
    if (e.target.tagName !== 'INPUT') return;
    const i = this.#index(e.target);
    if (e.key === 'Enter') {
      e.preventDefault(); // never submit the whole builder form from here
      this.add(i + 1);
    } else if (e.key === 'Backspace' && e.target.value === '' && this.#options.length > 1) {
      e.preventDefault();
      this.remove(i);
    }
  };
}

customElements.define('option-list', OptionList);
