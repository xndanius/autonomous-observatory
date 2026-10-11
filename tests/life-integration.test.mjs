import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, applyDecision, validateExperiment } from '../engine.mjs';

test('life experiments retain actual decision chronology and bounded snapshots', () => {
  const initial = createExperiment({ id: 'life-integration', type: 'life-research', createdAt: '2026-10-11T00:00:00.000Z' });
  assert.equal(initial.turn, 0);
  assert.equal(initial.timeline.length, 0);
  const original = structuredClone(initial);
  let world = initial;
  for (let turn = 1; turn <= 14; turn++) {
    world = applyDecision(world, {
      action: 'experiment', params: { name: `Controlled blinker ${turn}`, seed_template: 'blinker', steps: 8, hypothesis: { kind: 'oscillator', period: 2 } },
      reason: 'Test whether the declared period is reproduced under the deterministic rule.', decision_id: `life-test-${turn}`,
    }, { now: `2026-10-11T00:00:${String(turn).padStart(2, '0')}.000Z` });
  }
  assert.deepEqual(initial, original);
  assert.equal(world.turn, 14);
  assert.equal(world.timeline.length, 14);
  assert.equal(world.memory.observations.length, 12);
  assert.equal(world.world.records.length, 12);
  assert.equal(world.timeline[0].turn, 1);
  assert.equal(world.timeline.at(-1).snapshot.world.records, undefined);
  assert.ok(validateExperiment(world).valid);
  const duplicate = applyDecision(world, { ...world.timeline.at(-1).decision, decision_id: 'life-test-14' }, { now: '2026-10-11T00:00:20.000Z' });
  assert.deepEqual(duplicate, world);
  const unchanged = structuredClone(world);
  assert.throws(() => applyDecision(world, { action: 'experiment', params: { name: 'bad', seed_template: 'blinker', steps: 999, hypothesis: { kind: 'unknown' } } }));
  assert.deepEqual(world, unchanged);
});
