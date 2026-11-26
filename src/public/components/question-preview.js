// <question-preview>: one question rendered the way a member will see it.
// Mirrors the markup in views/form.ejs so the builder's preview and the real
// form share the page stylesheet and look the same. The controls are inert:
// they're there to be looked at, not filled in.
//
//   preview.field -> the field object; set it again to re-render

import { t } from '../i18n.js';

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export class QuestionPreview extends HTMLElement {
  #field = null;

  get field() { return this.#field; }
  set field(f) { this.#field = f; this.#render(); }

  connectedCallback() {
    this.inert = true;
    this.setAttribute('aria-hidden', 'true');
    this.#render();
  }

  #render() {
    const f = this.#field;
    if (!this.isConnected || !f) return;
    const untitled = t('editor.untitled_question');
    const icon = `<svg class="ficon q-icon" aria-hidden="true" focusable="false"><use href="#ficon-${esc(f.type)}"/></svg>`;
    const label = (f.type === 'heading' ? '' : icon) + (f.label?.trim() ? esc(f.label) : `<span class="untitled">${untitled}</span>`);
    const star = f.required && f.type !== 'heading' ? ` <abbr title="${t('common.required')}">*</abbr>` : '';
    const help = f.help?.trim() ? `<small>${esc(f.help)}</small>` : '';
    const options = f.options?.filter((o) => o.trim()) || [];

    let html;
    if (f.type === 'heading') {
      html = `<div class="form-section"><h2>${label}</h2>${f.help?.trim() ? `<p class="muted">${esc(f.help)}</p>` : ''}</div>`;
    } else if (f.type === 'radio' || f.type === 'checkbox' || f.type === 'yesno') {
      const choices = f.type === 'yesno' ? [t('common.yes'), t('common.no')] : options.length ? options : [t('editor.option_1')];
      const type = f.type === 'yesno' ? 'radio' : f.type;
      html = `<div class="field"><fieldset><legend>${label}${star}</legend>${help}${
        choices.map((o) => `<label class="choice"><input type="${type}" tabindex="-1"> ${esc(o)}</label>`).join('')
      }</fieldset></div>`;
    } else {
      const ph = `placeholder="${esc(f.placeholder)}"`;
      let control;
      if (f.type === 'textarea') control = `<textarea rows="3" ${ph}></textarea>`;
      else if (f.type === 'select') control = `<select><option>${t('common.choose')}</option>${options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
      else if (f.type === 'file') control = `<input type="file">`;
      else control = `<input type="${f.type === 'text' ? 'text' : esc(f.type)}" ${ph}>`;
      html = `<div class="field"><label><span>${label}${star}</span></label>${help}${control}</div>`;
    }
    this.innerHTML = html;
  }
}

customElements.define('question-preview', QuestionPreview);
