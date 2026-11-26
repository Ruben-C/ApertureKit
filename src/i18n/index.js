import en from './locales/en.js';
import ptBR from './locales/pt-BR.js';
import { STATUS } from '../status.js';
import { FIELD_TYPES } from '../fields.js';

export const SUPPORTED_LOCALES = ['en', 'pt-BR'];
export const DEFAULT_LOCALE = 'en';

export const LOCALE_LABELS = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
};

const LOCALES = {
  en,
  'pt-BR': ptBR,
};

function getNested(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const p of parts) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = curr[p];
  }
  return curr;
}

function interpolate(str, params) {
  if (!params || typeof str !== 'string') return str;
  return str.replace(/(?:%\{|\{)([a-zA-Z0-9_-]+)(?:\})/g, (match, key) => {
    return key in params ? String(params[key]) : match;
  });
}

export function translate(key, params, locale = DEFAULT_LOCALE) {
  const dict = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  let val = getNested(dict, key);
  if (val === undefined && locale !== DEFAULT_LOCALE) {
    val = getNested(LOCALES[DEFAULT_LOCALE], key);
  }
  if (val === undefined) return key;
  return interpolate(val, params);
}

export function getTranslator(locale = DEFAULT_LOCALE) {
  return (key, params) => translate(key, params, locale);
}

export function parseAcceptLanguage(header) {
  if (!header) return [];
  return header
    .split(',')
    .map((item) => {
      const [lang, qVal] = item.trim().split(';');
      const q = qVal && qVal.trim().startsWith('q=') ? parseFloat(qVal.trim().slice(2)) : 1.0;
      return { lang: lang.trim(), q: isNaN(q) ? 0 : q };
    })
    .sort((a, b) => b.q - a.q)
    .map((item) => item.lang);
}

export function matchLocale(languages, supported = SUPPORTED_LOCALES) {
  for (const lang of languages) {
    const l = lang.toLowerCase();
    const exact = supported.find((s) => s.toLowerCase() === l);
    if (exact) return exact;
    if (l.startsWith('pt')) {
      const ptMatch = supported.find((s) => s.startsWith('pt'));
      if (ptMatch) return ptMatch;
    }
    if (l.startsWith('en')) {
      const enMatch = supported.find((s) => s.startsWith('en'));
      if (enMatch) return enMatch;
    }
  }
  return null;
}

export function resolveLocale(req, settings = {}) {
  // 1. Explicit query parameter ?lang=
  const q = req.query?.lang;
  if (q && SUPPORTED_LOCALES.includes(q)) {
    if (req.session) req.session.locale = q;
    return q;
  }

  // 2. Session preference if user previously switched
  if (req.session?.locale && SUPPORTED_LOCALES.includes(req.session.locale)) {
    return req.session.locale;
  }

  // 3. Portal setting (default: 'en')
  const settingLocale = settings.locale || 'en';
  if (settingLocale !== 'auto' && SUPPORTED_LOCALES.includes(settingLocale)) {
    return settingLocale;
  }

  // 4. Accept-Language header (used when setting is 'auto' or not specified)
  const header = req.headers?.['accept-language'];
  if (header) {
    const matched = matchLocale(parseAcceptLanguage(header));
    if (matched) return matched;
  }

  // 5. Default
  return DEFAULT_LOCALE;
}

export function getLocalizedStatus(locale = DEFAULT_LOCALE) {
  const t = getTranslator(locale);
  const out = {};
  for (const key of Object.keys(STATUS)) {
    out[key] = t(`status.${key}`);
  }
  return out;
}

export function getLocalizedFieldTypes(locale = DEFAULT_LOCALE) {
  const t = getTranslator(locale);
  const out = {};
  for (const [key, val] of Object.entries(FIELD_TYPES)) {
    out[key] = {
      ...val,
      label: t(`fields.${key}`),
    };
  }
  return out;
}

export function getClientTranslations(locale = DEFAULT_LOCALE) {
  const t = getTranslator(locale);
  return {
    'common.preview': t('common.preview'),
    'common.choose': t('common.choose'),
    'common.yes': t('common.yes'),
    'common.no': t('common.no'),
    'common.required': t('common.required'),
    'editor.question_type': t('editor.question_type'),
    'editor.question_label': t('editor.question_label'),
    'editor.help_text': t('editor.help_text'),
    'editor.help_text_placeholder': t('editor.help_text_placeholder'),
    'editor.placeholder_label': t('editor.placeholder_label'),
    'editor.required': t('editor.required'),
    'editor.show_question': t('editor.show_question'),
    'editor.show_section': t('editor.show_section'),
    'editor.when_condition': t('editor.when_condition'),
    'editor.always_no_rule': t('editor.always_no_rule'),
    'editor.no_questions_above': t('editor.no_questions_above'),
    'editor.questions_above_no_answers': t('editor.questions_above_no_answers'),
    'editor.untitled_question': t('editor.untitled_question'),
    'editor.option_n': t('editor.option_n'),
    'editor.remove_option': t('editor.remove_option'),
    'editor.add_option': t('editor.add_option'),
    'editor.option_1': t('editor.option_1'),
    'editor.remove_question': t('editor.remove_question'),
    'editor.move_up': t('editor.move_up'),
    'editor.move_down': t('editor.move_down'),
    'conditions.is': t('conditions.is'),
    'conditions.not': t('conditions.not'),
    'conditions.answered': t('conditions.answered'),
    'conditions.filled': t('conditions.answered'),
    'conditions.empty': t('conditions.empty'),
  };
}

function parseDate(iso) {
  const str = String(iso).replace(' ', 'T');
  return new Date(str.endsWith('Z') ? str : str + 'Z');
}

export function fmtDate(iso, locale = DEFAULT_LOCALE) {
  if (!iso) return '';
  return parseDate(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtAgo(iso, locale = DEFAULT_LOCALE) {
  if (!iso) return '';
  const d = parseDate(iso);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) {
    return locale.startsWith('pt') ? 'agora mesmo' : 'just now';
  }
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 30 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
  return d.toLocaleDateString(locale, { dateStyle: 'medium' });
}
