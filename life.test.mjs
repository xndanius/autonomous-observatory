import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeLife, applyLifeDecision, validateLifeParams, validateLifeWorld, lifeMetrics, lifeSnapshot,
  packLifeFrame, unpackLifeFrame, translateLifeCells, stepLife, resolveLifeSeed } from './life.mjs';

const experiment = (seed_template, hypothesis, extra = {}) => ({ action: 'experiment', params: {
  name: `Test ${seed_template}`, seed_template, steps: 8, hypothesis, ...extra } });
const run = decision => applyLifeDecision(initializeLife(), decision).world;

test('canonical public storage preserves Life validation and deterministic replay without weakening evidence checks', () => {
  const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  let world = run(experiment('glider', { kind: 'traveller', period: 4, dx: 1, dy: 1 }, { steps: 16 }));
  world = applyLifeDecision(world, experiment('blinker', { kind: 'fixed' })).world;
  world = applyLifeDecision(world, experiment('r-pentomino', { kind: 'unknown' }, { steps: 4 })).world;
  const restored = JSON.parse(JSON.stringify(sortKeys(world)));
  // The latest-record copy may independently preserve a different key order.
  restored.latest_record = reverseKeys(restored.latest_record);
  assert.deepEqual(validateLifeWorld(restored), { valid: true, errors: [] });
  const next = experiment('beacon', { kind: 'oscillator', period: 2 });
  assert.deepEqual(applyLifeDecision(restored, next), applyLifeDecision(world, next));
  for (const corrupt of [
    w => { w.records[0].actual.period += 1; },
    w => { w.records[0].hypothesis.dx = -1; },
    w => { w.records[0].claim.status = 'rejected'; },
    w => { w.records[0].replication.actual.dy = -1; },
    w => { w.records[0].frames[1] = w.records[0].frames[0]; },
  ]) {
    const forged = JSON.parse(JSON.stringify(restored));
    corrupt(forged);
    assert.equal(validateLifeWorld(forged).valid, false);
  }
});

test('still block, blinker and beacon classifications are measured from actual generations', () => {
  const block = run(experiment('block', { kind: 'fixed' }));
  assert.equal(new Set(block.latest_record.frames).size, 1);
  assert.deepEqual(block.latest_record.actual, { kind: 'fixed', period: 1, dx: 0, dy: 0, start_step: 0, observed_until: 8 });
  assert.equal(block.latest_record.claim.status, 'confirmed');
  const blinker = run(experiment('blinker', { kind: 'oscillator', period: 2 }));
  const frames = blinker.latest_record.frames;
  assert.notEqual(frames[0], frames[1]);
  assert.equal(frames[0], frames[2]);
  assert.deepEqual(unpackLifeFrame(frames[1]), [[7, 5], [7, 6], [7, 7]]);
  assert.equal(blinker.latest_record.actual.period, 2);
  const beacon = run(experiment('beacon', { kind: 'oscillator', period: 2 }));
  assert.equal(beacon.latest_record.alive_initial, 8);
  assert.equal(unpackLifeFrame(beacon.latest_record.frames[1]).length, 6);
  assert.equal(beacon.latest_record.actual.kind, 'oscillator');
});

test('glider has the earliest period four and actual displacement including toroidal wrap', () => {
  const world = run(experiment('glider', { kind: 'traveller', period: 4, dx: 1, dy: 1 }, { origin: [14, 14], steps: 16 }));
  const trial = world.latest_record;
  assert.deepEqual(trial.actual, { kind: 'traveller', period: 4, dx: 1, dy: 1, start_step: 0, observed_until: 16 });
  assert.equal(trial.frames[4], packLifeFrame(translateLifeCells(trial.initial_seed, 1, 1)));
  assert.equal(trial.frames[16], packLifeFrame(translateLifeCells(trial.initial_seed, 4, 4)));
  assert.equal(trial.claim.status, 'confirmed');
  assert.equal(trial.replication.passed, true);
  assert.deepEqual(trial.replication.actual, trial.actual);
  assert.equal(trial.replication.compared_frames, 17);
  assert.equal(trial.replication.final_frame, packLifeFrame(translateLifeCells(world.cells, 5, 7)));
});

test('extinction records the first empty generation and live cells really reach zero', () => {
  const world = run({ action: 'experiment', params: { name: 'Isolated cell', seed_cells: [[15, 15]], steps: 4, hypothesis: { kind: 'extinction' } } });
  assert.equal(world.latest_record.actual.kind, 'extinction');
  assert.equal(world.latest_record.actual.start_step, 1);
  assert.equal(world.latest_record.frames[1], '0'.repeat(64));
  assert.deepEqual(world.cells, []);
  assert.equal(world.confirmed_claims, 1);
});

test('claim mismatches preserve contradictions and never manufacture confirmed discoveries', () => {
  const world = run(experiment('glider', { kind: 'fixed' }));
  assert.equal(world.latest_record.actual.kind, 'traveller');
  assert.equal(world.latest_record.claim.status, 'rejected');
  assert.equal(world.confirmed_claims, 0);
  assert.equal(world.rejected_claims, 1);
  assert.equal(world.contradictions.length, 1);
  assert.equal(world.field_guide[0].actual.kind, 'traveller');
  assert.equal(world.field_guide[0].confirmed_claims, 0);
  const unknown = run(experiment('r-pentomino', { kind: 'unknown' }, { steps: 4 }));
  assert.equal(unknown.latest_record.actual.kind, 'unknown');
  assert.equal(unknown.latest_record.claim.status, 'unassessed');
  assert.equal(unknown.confirmed_claims, 0);
});

test('eight-neighbor B3/S23 update is synchronous and translation equivariant across edges', () => {
  // Horizontal edge-crossing triplet births its vertical neighbors and kills its ends.
  const edge = [[15, 0], [0, 0], [1, 0]];
  assert.deepEqual(stepLife(edge), [[0, 0], [0, 1], [0, 15]]);
  const asymmetric = [[0, 0], [15, 0], [1, 1], [5, 6], [5, 7], [6, 7], [10, 14]];
  assert.deepEqual(stepLife(translateLifeCells(asymmetric, 5, 7)), translateLifeCells(stepLife(asymmetric), 5, 7));
  assert.deepEqual(stepLife([[4, 4], [5, 4]]), [], 'Two neighbors cannot birth a dead cell.');
});

test('packed frames preserve the exact grid with documented row-major bit order', () => {
  const cells = [[0, 0], [3, 0], [4, 0], [15, 15]];
  assert.equal(packLifeFrame(cells), '98' + '0'.repeat(61) + '1');
  assert.deepEqual(unpackLifeFrame(packLifeFrame(cells)), cells);
  assert.throws(() => unpackLifeFrame('0'.repeat(63)), /64/);
});

test('custom seeds and bounded toggles produce actual new experiments with translation-deduplicated catalogue', () => {
  let world = run(experiment('block', { kind: 'fixed' }));
  world = applyLifeDecision(world, experiment('block', { kind: 'fixed' }, { origin: [14, 15] })).world;
  assert.equal(world.novel_patterns, 1);
  assert.equal(world.field_guide[0].tested, 2);
  const mutated = experiment('block', { kind: 'unknown' }, { toggle_cells: [[6, 6]], name: 'Three-cell block mutation' });
  assert.equal(resolveLifeSeed(mutated.params).length, 3);
  world = applyLifeDecision(world, mutated).world;
  assert.equal(world.novel_patterns, 2);
  assert.equal(world.latest_record.initial_seed.length, 3);
  assert.equal(world.latest_record.params.toggle_cells.length, 1);
  assert.equal(world.verified_reproductions, 3);
});

test('invalid bounded parameters are rejected atomically', () => {
  const base = experiment('glider', { kind: 'traveller', period: 4, dx: 1, dy: 1 });
  const prior = initializeLife();
  const bytes = JSON.stringify(prior);
  for (const params of [
    { ...base.params, steps: 49 }, { ...base.params, steps: 3 }, { ...base.params, steps: 4.5 },
    { ...base.params, origin: [16, 0] }, { ...base.params, seed_template: 'fake' },
    { ...base.params, seed_cells: [[1, 1]] }, { ...base.params, invented: true },
    { ...base.params, toggle_cells: [[1, 1], [1, 1]] },
    { ...base.params, toggle_cells: Array.from({ length: 9 }, (_, i) => [i, 0]) },
    { ...base.params, hypothesis: { kind: 'oscillator', period: 1 } },
    { ...base.params, hypothesis: { kind: 'traveller', period: 4, dx: 0, dy: 0 } },
    { ...base.params, hypothesis: { kind: 'extinction', period: 1 } },
    { ...base.params, hypothesis: { kind: 'traveller', period: 4, dx: 5, dy: 1 } },
  ]) assert.throws(() => applyLifeDecision(prior, { action: 'experiment', params }));
  assert.throws(() => validateLifeParams({ name: 'Dup', seed_cells: [[1, 1], [1, 1]], steps: 8, hypothesis: { kind: 'unknown' } }));
  assert.equal(JSON.stringify(prior), bytes);
});

test('deterministic replay leaves inputs unchanged, bounds record memory and preserves metric evidence', () => {
  const initial = initializeLife();
  const bytes = JSON.stringify(initial);
  const decisions = Array.from({ length: 14 }, (_, i) => experiment(i % 2 ? 'blinker' : 'block', i % 2 ? { kind: 'oscillator', period: 2 } : { kind: 'fixed' }, { origin: [i, i] }));
  let world = initial;
  for (const decision of decisions) {
    const previous = JSON.stringify(world);
    const next = applyLifeDecision(world, decision).world;
    assert.equal(JSON.stringify(world), previous);
    assert.deepEqual(validateLifeWorld(next), { valid: true, errors: [] });
    world = next;
  }
  let replay = JSON.parse(bytes);
  for (const decision of decisions) replay = applyLifeDecision(replay, JSON.parse(JSON.stringify(decision))).world;
  assert.deepEqual(replay, world);
  assert.equal(JSON.stringify(initial), bytes);
  assert.equal(world.records.length, 12);
  assert.equal(world.records[0].id, 'life-0003');
  assert.equal(world.agent_memory.last_results.length, 6);
  assert.equal(world.experiments_tested, 14);
  assert.equal(world.confirmed_claims, 14);
  assert.equal(world.novel_patterns, 2);
  assert.equal(world.verified_reproductions, 14);
  assert.equal(lifeMetrics(world).find(m => m.label === 'Alive cells').value, world.cells.length);
  assert.equal(Object.hasOwn(lifeSnapshot(world).world, 'records'), false);
});

test('world validation catches forged synchronous updates and malformed input', () => {
  const world = run(experiment('blinker', { kind: 'oscillator', period: 2 }));
  world.records[0].frames[1] = '0'.repeat(64);
  assert.equal(validateLifeWorld(world).valid, false);
  assert.equal(validateLifeWorld(null).valid, false);
  assert.equal(validateLifeWorld({}).valid, false);
});

test('world validation independently rejects forged seed parameters, classifications, claims and counters', () => {
  const valid = run(experiment('glider', { kind: 'traveller', period: 4, dx: 1, dy: 1 }));
  for (const mutate of [
    w => { w.records[0].actual.period = 2; },
    w => { w.records[0].claim.status = 'rejected'; },
    w => { w.records[0].params.origin = [0, 0]; },
    w => { w.records[0].replication.actual.kind = 'fixed'; },
    w => { w.confirmed_claims = 0; w.rejected_claims = 1; },
  ]) {
    const forged = JSON.parse(JSON.stringify(valid));
    mutate(forged);
    assert.equal(validateLifeWorld(forged).valid, false);
  }
});
