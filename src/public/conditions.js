// Conditional questions. A field with a `showIf` rule is only shown while an
// earlier question has (or lacks) a given answer:
//
//   showIf: { field: '<id of a question above>', op, value? }
//   op: 'is' | 'not'          value is one of that question's choices
//       'answered' | 'empty'  any question type, no value
//
// A rule on a section heading covers the whole section (everything up to the
// next heading). Rules may only point upwards, so one pass down the form
// settles everything and there is nothing to loop over.
//
// This module is shared: the server validates submissions with it (src/
// fields.js) and the member's form shows and hides questions with it
// (form-conditions.js), so the two can never disagree about what a rule means.
// Keep it free of Node and browser specifics.

export const OPS = {
  is: 'is',
  not: 'is not',
  answered: 'is answered',
  empty: 'is not answered',
};

// The answers a rule can compare against: the question's options, or Yes /
// No. Empty for questions that are typed rather than picked, which only
// support 'answered' / 'empty'.
export function choicesOf(field) {
  if (!field) return [];
  if (field.type === 'yesno') return ['Yes', 'No'];
  return Array.isArray(field.options) ? field.options : [];
}

// Does an answer satisfy a rule? `value` is a string or, for choose-several,
// an array of strings; blank means unanswered. 'not' needs an answer, so a
// question shown when another "is not Yes" stays hidden until Yes or No is
// picked, rather than appearing straight away.
export function matches(rule, value) {
  const picked = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null && v !== '');
  switch (rule.op) {
    case 'is': return picked.includes(rule.value);
    case 'not': return picked.length > 0 && !picked.includes(rule.value);
    case 'answered': return picked.length > 0;
    case 'empty': return picked.length === 0;
    default: return true;
  }
}

// The ids of the fields that are shown, given a way to read each answer.
// Walks the form top to bottom: a hidden heading hides its section, and a
// field whose target is itself hidden is hidden too.
export function visibleIds(fields, valueOf) {
  const shown = new Set();
  let sectionHidden = false;
  for (const f of fields) {
    if (f.type === 'heading') sectionHidden = false;
    let show = !sectionHidden;
    if (show && f.showIf) show = shown.has(f.showIf.field) && matches(f.showIf, valueOf(f.showIf.field));
    if (f.type === 'heading' && !show) sectionHidden = true;
    if (show) shown.add(f.id);
  }
  return shown;
}
