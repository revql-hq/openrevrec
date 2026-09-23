import assert from 'node:assert/strict';
import test from 'node:test';
import { changeComponentKind, changeObligationKind, changeObligationMethod, contractTerms, suggestedModificationDate, termReviewStatus } from '../../frontend/src/contractTerms.ts';

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

test('unchanged term review reschedules only until a newer assessment supersedes it', () => {
  const assessed = { ...contract, id: 'con_1', start_date: '2026-01-01', version: 1,
    term_basis: 'cancellable', term_review_date: '2026-05-01',
    activities: [{ type: 'modification', effective_date: '2026-06-01', version: 3, term_review_date: '2026-07-01' }] };
  const state = { term_reviews: [{ contract_id: 'con_1', effective_date: '2026-05-05', version: 2,
    next_review_date: '2026-08-01', reviewer: 'Accountant' }] };
  assert.equal(termReviewStatus(state, assessed, '2026-05-31').reviewDate, '2026-08-01');
  assert.equal(termReviewStatus(state, assessed, '2026-06-30').reviewDate, '2026-07-01');
  assert.equal(termReviewStatus(state, assessed, '2026-06-30').latestReview, undefined);
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
  const monthly = { ...price, allocation_scope: 'specific', target_obligation_ids: ['service'], target_period: '2026-06', allocation_rationale: 'June outcome' };
  assert.equal(changeComponentKind(monthly, 'credit').target_period, undefined);
  assert.equal(changeComponentKind(monthly, 'usage').target_period, '2026-06');
  assert.equal(changeComponentKind(monthly, 'fixed').target_period, undefined);
});

test('modification starts no earlier than the contract, and method changes require a fresh SSP', () => {
  const terms = { start_date: '2026-09-15' };
  assert.equal(suggestedModificationDate(terms, '2026-09'), '2026-09-15');
  assert.equal(suggestedModificationDate(terms, '2026-10'), '2026-10-01');
  const service = { id: 'service', kind: 'service', method: 'usage', ssp: '200', total_units: '100' };
  const metered = changeObligationMethod(service, 'metered');
  assert.equal(metered.ssp, '0');
  assert.equal(metered.total_units, undefined);
  assert.equal(changeObligationMethod(metered, 'exact_days').ssp, '');
  const right = changeObligationKind(metered, 'material_right');
  assert.equal(right.method, 'point_in_time');
  assert.equal(right.ssp, '');
  assert.equal(changeObligationKind({ ...right, exercise_start: '2026-09-20', exercise_end: '2026-12-31' }, 'service').exercise_start, undefined);
  assert.equal(service.total_units, '100');
});

test('metered rate changes appear only from their delivery-effective date', () => {
  const metered = {
    consideration: [{ id: 'meter', kind: 'metered', unit_rate: '0.015' }],
    obligations: [{ id: 'units', method: 'metered' }],
    activities: [
      { type: 'rate_change', component_id: 'meter', effective_date: '2026-02-10', unit_rate: '0.019' },
      { type: 'rate_change', component_id: 'meter', effective_date: '2026-01-15', unit_rate: '0.017' },
    ],
  };
  assert.equal(contractTerms(metered, '2026-01-14').consideration[0].unit_rate, '0.015');
  assert.equal(contractTerms(metered, '2026-01-15').consideration[0].unit_rate, '0.017');
  assert.equal(contractTerms(metered, '2026-02-10').consideration[0].unit_rate, '0.019');
  assert.equal(metered.consideration[0].unit_rate, '0.015');
});
