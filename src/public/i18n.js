// Client-side i18n lookup
export function t(key, params = {}) {
  const dict = typeof window !== 'undefined' ? window.__I18N__ : null;
  let str = (dict && dict[key]) || key;
  return str.replace(/(?:%\{|\{)([a-zA-Z0-9_-]+)(?:\})/g, (match, k) => (k in params ? String(params[k]) : match));
}
