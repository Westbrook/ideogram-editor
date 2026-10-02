import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCampaignPlan } from '../../tooling/qualification/campaigns/inventory.mjs';

const resourceNames = cell => cell.requiredMeasurements.filter(rule => rule.budgetId === 'R18').map(rule => rule.name).sort();
const browserResources = ['R18CpuAllocationBytes', 'R18GpuAllocationBytes', 'R18PreviewCacheBytes', 'R18TextureDeviceOr2048BoundViolations'];

test('canonical C WA import and lifecycle cells require actual backend CPU and RSS without fictitious browser resource rows', () => {
  for (const campaign of ['P', 'Q3']) {
    const plan = makeCampaignPlan({ campaign, features: 'adapters' });
    const cells = plan.cells.filter(cell => cell.host === 'C' && cell.workload === 'WA' && ['adapter.import', 'adapter.lifecycle'].includes(cell.operation));
    assert(cells.some(cell => cell.operation === 'adapter.import')); assert(cells.some(cell => cell.operation === 'adapter.lifecycle'));
    for (const cell of cells) {
      assert.equal(cell.handler, 'adapters');
      assert.deepEqual(resourceNames(cell), ['R18CpuAllocationBytes'], cell.id);
      assert(cell.requiredMeasurements.some(rule => rule.name === 'R17BackendRssBytes' && rule.ceiling === 512 * 1024 ** 2));
      assert(cell.budgets.includes('R18')); assert(cell.budgets.includes('T05')); assert(cell.budgets.includes('T06'));
    }
  }
});

test('independent H WA lifecycle retains every browser resource requirement and its own fixed baseline and cycles', () => {
  for (const campaign of ['P', 'Q3']) {
    const plan = makeCampaignPlan({ campaign, features: 'adapters' });
    assert.equal(plan.jobs.length, campaign === 'P' ? 30 : 19);
    const cells = plan.cells.filter(cell => cell.operation === 'adapter.lifecycle');
    assert.equal(cells.length, 2);
    for (const cell of cells) {
      assert.equal(cell.parameters.cycles, 2); assert.equal(cell.parameters.baselineIdleMs, 30000); assert.equal(cell.parameters.idleMs, 30000);
      assert.equal(cell.cold, 1); assert.equal(cell.warm, 0); assert.equal(cell.primes, 0);
      assert.deepEqual(cell.parameters.restarts, []); assert.equal(cell.parameters.processResetBetweenCycles, false);
    }
    const browser = cells.find(cell => cell.host === 'H');
    assert.equal(browser.handler, 'browser'); assert.deepEqual(resourceNames(browser), browserResources);
    assert(browser.requiredMeasurements.some(rule => rule.name === 'R17BrowserProcessTreeRssBytes'));
  }
});
