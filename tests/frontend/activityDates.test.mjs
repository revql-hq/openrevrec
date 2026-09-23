import assert from 'node:assert/strict';
import test from 'node:test';
import { activityEarliestDate, suggestedActivityDate } from '../../frontend/src/activityDates.ts';

const contract = {
  id: 'contract', start_date: '2026-09-15', end_date: '2027-08-31', consideration: [],
  obligations: [{ id: 'build', kind: 'implementation', method: 'progress', start_date: '2026-09-20', end_date: '2026-12-31' }],
  activities: [],
};

test('activity date starts with the service while advance billing keeps the working period', () => {
  assert.equal(suggestedActivityDate(contract, '2026-09', 'billing'), '2026-09-01');
  assert.equal(suggestedActivityDate(contract, '2026-09', 'rate_change'), '2026-09-15');
  assert.equal(suggestedActivityDate(contract, '2026-09', 'progress'), '2026-09-20');
  assert.equal(suggestedActivityDate(contract, '2026-09', 'adjustment'), '2026-09-15');
  assert.equal(activityEarliestDate(contract, 'progress', contract.obligations[0]), '2026-09-20');
  assert.equal(activityEarliestDate(contract, 'adjustment', contract.obligations[0]), '2026-09-15');
  assert.equal(suggestedActivityDate(contract, '2026-09', 'progress', '2026-10-12'), '2026-10-12');
});

test('activity date finds a compatible obligation added by a later amendment', () => {
  const amended = { ...contract, activities: [{ type: 'modification', effective_date: '2026-09-25',
    obligations: [...contract.obligations, { id: 'meter', kind: 'service', method: 'usage', start_date: '2026-09-25', end_date: '2027-08-31' }] }] };
  assert.equal(suggestedActivityDate(amended, '2026-09', 'usage'), '2026-09-25');
});

test('material-right dates respect the exercise window and delivery', () => {
  const right = { ...contract, start_date: '2026-09-01', obligations: [{ id: 'option', kind: 'material_right', method: 'point_in_time',
    start_date: '2026-09-01', end_date: '2026-12-31', exercise_start: '2026-09-10', exercise_end: '2026-12-31' }] };
  assert.equal(suggestedActivityDate(right, '2026-09', 'right_exercise'), '2026-09-10');
  assert.equal(suggestedActivityDate(right, '2026-09', 'milestone'), '2026-09-10');
  const exercised = { ...right, activities: [{ type: 'right_exercise', obligation_id: 'option', effective_date: '2026-09-20', delivery_start: '2026-10-01' }] };
  assert.equal(suggestedActivityDate(exercised, '2026-09', 'milestone'), '2026-10-01');
});
