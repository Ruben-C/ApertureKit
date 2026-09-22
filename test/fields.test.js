import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFields, validateSubmission } from '../src/fields.js';

test('sanitizeFields normalises builder output', () => {
  const fields = sanitizeFields(
    JSON.stringify([
      { type: 'select', label: ' Room ', options: 'A\n\nB\nA', id: 'room!' },
      { type: 'bogus', label: '' },
      { type: 'heading', label: 'Section', required: true },
      { type: 'text', label: 'Dup', id: 'room' },
    ]),
  );
  assert.equal(fields[0].id, 'room');
  assert.deepEqual(fields[0].options, ['A', 'B']);
  assert.equal(fields[0].label, 'Room');
  assert.equal(fields[1].type, 'text');
  assert.equal(fields[1].label, 'Question 2');
  assert.equal(fields[2].required, false, 'display fields cannot be required');
  assert.notEqual(fields[3].id, 'room', 'duplicate ids are made unique');
});

test('sanitizeFields rejects bad input', () => {
  assert.throws(() => sanitizeFields('not json'), /valid JSON/);
  assert.throws(() => sanitizeFields('{}'), /list/);
});

test('validateSubmission enforces required fields and option membership', () => {
  const fields = sanitizeFields([
    { id: 'name', type: 'text', label: 'Name', required: true },
    { id: 'room', type: 'select', label: 'Room', options: ['A', 'B'], required: true },
    { id: 'days', type: 'checkbox', label: 'Days', options: ['Mon', 'Tue'] },
    { id: 'ok', type: 'yesno', label: 'OK?' },
    { id: 'when', type: 'date', label: 'When' },
    { id: 'file', type: 'file', label: 'File', required: true },
  ]);
  const { answers, errors } = validateSubmission(
    fields,
    { name: '', room: 'C', days: ['Mon', 'Zzz'], ok: 'yes', when: 'tomorrow' },
    {},
  );
  assert.equal(errors.name, 'This field is required.');
  assert.equal(errors.room, 'Choose an option.');
  assert.deepEqual(answers.days, ['Mon']);
  assert.equal(answers.ok, 'Yes');
  assert.equal(errors.when, 'Enter a date.');
  assert.equal(errors.file, 'Attach a file.');

  const good = validateSubmission(
    fields,
    { name: 'Mo', room: 'A', days: 'Tue', ok: 'no', when: '2026-10-01' },
    { file: { originalname: 'x.pdf' } },
  );
  assert.deepEqual(good.errors, {});
  assert.equal(good.answers.file, 'x.pdf');
  assert.deepEqual(good.answers.days, ['Tue']);
});

test('sanitizeFields keeps valid show-when rules and refuses broken ones', () => {
  const fields = sanitizeFields([
    { id: 'parking', type: 'yesno', label: 'Need parking?' },
    { id: 'plate', type: 'text', label: 'Plate', showIf: { field: 'parking', op: 'is', value: 'Yes', junk: 1 } },
    { id: 'notes', type: 'textarea', label: 'Notes', showIf: { field: 'plate', op: 'answered', value: 'ignored' } },
  ]);
  assert.deepEqual(fields[1].showIf, { field: 'parking', op: 'is', value: 'Yes' });
  assert.deepEqual(fields[2].showIf, { field: 'plate', op: 'answered' }, 'value is dropped for answered / empty');
  assert.equal('showIf' in fields[0], false);

  const base = { id: 'a', type: 'select', label: 'A', options: ['One', 'Two'] };
  assert.throws(() => sanitizeFields([{ id: 'b', type: 'text', label: 'B', showIf: { field: 'a', op: 'is', value: 'One' } }, base]), /not above it/);
  assert.throws(() => sanitizeFields([base, { id: 'b', type: 'text', label: 'B', showIf: { field: 'a', op: 'is', value: 'Three' } }]), /not one of its answers/);
  assert.throws(() => sanitizeFields([base, { id: 'b', type: 'text', label: 'B', showIf: { field: 'a', op: 'like' } }]), /unknown condition/);
  assert.throws(
    () => sanitizeFields([{ id: 'h', type: 'heading', label: 'H' }, { id: 'b', type: 'text', label: 'B', showIf: { field: 'h', op: 'answered' } }]),
    /not above it/,
    'headings cannot be watched',
  );
});

test('validateSubmission ignores questions hidden by show-when rules', () => {
  const fields = sanitizeFields([
    { id: 'parking', type: 'yesno', label: 'Need parking?' },
    { id: 'plate', type: 'text', label: 'Plate', required: true, showIf: { field: 'parking', op: 'is', value: 'Yes' } },
    { id: 'why', type: 'text', label: 'Why not?', showIf: { field: 'parking', op: 'not', value: 'Yes' } },
    { id: 'colour', type: 'text', label: 'Colour', required: true, showIf: { field: 'plate', op: 'answered' } },
    { id: 'extras', type: 'heading', label: 'Extras', showIf: { field: 'parking', op: 'answered' } },
    { id: 'ev', type: 'checkbox', label: 'Charging', options: ['AC', 'DC'], required: true },
    { id: 'more', type: 'heading', label: 'More' },
    { id: 'name', type: 'text', label: 'Name', required: true },
  ]);

  // Nothing answered: "is not Yes" waits for an answer too, and the whole
  // Extras section is out, so only Name is required.
  let r = validateSubmission(fields, { plate: 'ABC', ev: 'AC' });
  assert.deepEqual(Object.keys(r.errors), ['name']);
  assert.deepEqual(r.answers, { parking: '', name: '' });

  // No parking: the plate is hidden (and its required rule with it), even
  // though the browser posted a value; Colour depends on the hidden plate.
  r = validateSubmission(fields, { parking: 'no', plate: 'ABC', why: 'Bike', ev: 'DC', name: 'Mo' });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.answers, { parking: 'No', why: 'Bike', ev: ['DC'], name: 'Mo' });

  // Parking: plate required, then colour once the plate is filled in.
  r = validateSubmission(fields, { parking: 'yes', name: 'Mo' });
  assert.deepEqual(Object.keys(r.errors).sort(), ['ev', 'plate']);
  r = validateSubmission(fields, { parking: 'yes', plate: 'ABC', ev: 'AC', name: 'Mo' });
  assert.deepEqual(r.errors, { colour: 'This field is required.' });
});
