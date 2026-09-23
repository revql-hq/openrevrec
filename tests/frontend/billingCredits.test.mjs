import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleBillingOriginals } from '../../frontend/src/billingCredits.ts';

test('credit originals follow the selected legal source and effective date', () => {
  const contract = {
    reference: 'AG-A', source_contracts: [{ reference: 'AG-A' }, { reference: 'AG-B' }],
    activities: [
      { id: 'a', type: 'billing', amount: '100', effective_date: '2026-01-15', source_contract_reference: 'AG-A' },
      { id: 'b', type: 'billing', amount: '200', effective_date: '2026-02-15', source_contract_reference: 'AG-B' },
      { id: 'future', type: 'billing', amount: '50', effective_date: '2026-03-01', source_contract_reference: 'AG-A' },
      { id: 'credit', type: 'billing', amount: '-10', effective_date: '2026-01-20', source_contract_reference: 'AG-A' },
    ],
  };
  assert.deepEqual(eligibleBillingOriginals(contract, '2026-02-16', '').map((item) => item.id), []);
  assert.deepEqual(eligibleBillingOriginals(contract, '2026-02-16', 'AG-A').map((item) => item.id), ['a']);
  assert.deepEqual(eligibleBillingOriginals(contract, '2026-02-16', 'AG-B').map((item) => item.id), ['b']);
  assert.deepEqual(eligibleBillingOriginals({ ...contract, source_contracts: [] }, '2026-02-16', '').map((item) => item.id), ['a', 'b']);
});
