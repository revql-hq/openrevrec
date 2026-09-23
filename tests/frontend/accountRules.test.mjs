import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApprovedCombinations } from '../../frontend/src/accountRules.ts';

test('spreadsheet paste preserves exact dimension combinations and blank means absent', () => {
  assert.deepEqual(
    parseApprovedCombinations('Account\tDepartment\tProject\n4000\tRecurring\tP-17\n2300\t\tP-17\n1100\t\t'),
    [
      { account: '4000', dimensions: { Department: 'Recurring', Project: 'P-17' } },
      { account: '2300', dimensions: { Project: 'P-17' } },
      { account: '1100', dimensions: {} },
    ],
  );
});

test('spreadsheet paste rejects duplicate, unnamed, and wider combinations', () => {
  assert.throws(() => parseApprovedCombinations('Account\tDepartment\tDepartment\n4000\tA\tB'), /unique/);
  assert.throws(() => parseApprovedCombinations('Account\tDepartment\n4000\tA\n4000\tA'), /repeats/);
  assert.throws(() => parseApprovedCombinations('Account\tDepartment\n\tA'), /needs an account/);
  assert.throws(() => parseApprovedCombinations('Account\tDepartment\n4000\tA\tExtra'), /extra columns/);
});
