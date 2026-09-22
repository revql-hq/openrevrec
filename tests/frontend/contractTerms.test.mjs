import assert from 'node:assert/strict';
import test from 'node:test';
import { changeComponentKind, contractTerms } from '../../frontend/src/contractTerms.ts';

const price = { id: 'price', label: 'Fee', kind: 'variable', amount: '100', included_amount: '25' };
const contract = {
  consideration: [price],
  obligations: [{ id: 'original', name: 'Original service' }],
  activities: [
    { type: 'modification', effective_date: '2026-12-01', consideration: [{ ...price, amount: '300', included_amount: '300' }] },
    { type: 'modification', effective_date: '2026-10-01', consideration: [{ ...price, amount: '200', included_amount: '100' }] },
    { type: 'modification', effective_date: '2026-11-01', obligations: [{ id: 'replacement', name: 'Replacement' }] },
    { type: 'reassessment', effective_date: '2026-11-01', component_id: 'price', included_amount: '150' },
  ],
};

test('effective terms retain partial amendments and reassessments in date order', () => {
  const original = structuredClone(contract);
  assert.deepEqual(contractTerms(contract, '2026-09-30').consideration, [price]);
  const november = contractTerms(contract, '2026-11-15');
  assert.equal(november.consideration[0].amount, '200');
  assert.equal(november.consideration[0].included_amount, '150');
  assert.equal(november.obligations[0].id, 'replacement');
  assert.equal(contractTerms(contract, '2026-12-01').consideration[0].included_amount, '300');
  november.consideration[0].amount = '999';
  assert.deepEqual(contract, original);
});

test('term assessment follows dated amendments and clears when the term becomes fixed', () => {
  const assessed = {
    ...contract,
    term_basis: 'cancellable',
    term_assessment_rationale: 'Six months are enforceable',
    term_reassessment_trigger: 'Cancellation notice',
    activities: [
      { type: 'modification', effective_date: '2026-10-01', term_basis: 'evergreen', term_assessment_rationale: 'Renewal is enforceable', term_reassessment_trigger: 'Next notice window' },
      { type: 'modification', effective_date: '2026-12-01', term_basis: 'fixed' },
    ],
  };
  assert.equal(contractTerms(assessed, '2026-09-30').termAssessment.basis, 'cancellable');
  assert.equal(contractTerms(assessed, '2026-11-30').termAssessment.trigger, 'Next notice window');
  assert.deepEqual(contractTerms(assessed, '2026-12-31').termAssessment, { basis: 'fixed', rationale: '', trigger: '', reviewDate: '' });
});

test('same-day term changes preserve command order and empty obligation replacements', () => {
  const item = structuredClone(contract);
  item.activities.push({ type: 'modification', effective_date: '2026-11-01', obligations: [] });
  const result = contractTerms(item, '2026-11-01');
  assert.equal(result.consideration[0].included_amount, '150');
  assert.deepEqual(result.obligations, []);
});

test('switching to fixed pricing removes constrained fields without mutating the source', () => {
  const fixed = changeComponentKind(price, 'fixed');
  assert.equal(fixed.kind, 'fixed');
  assert.equal(fixed.included_amount, undefined);
  assert.equal(price.included_amount, '25');
  assert.equal(changeComponentKind(fixed, 'usage').included_amount, '100');
  assert.equal(changeComponentKind(price, 'usage').included_amount, '25');
});
