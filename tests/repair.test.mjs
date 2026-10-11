import test from 'node:test';
import assert from 'node:assert/strict';
import { REPAIR_APPS, REPAIR_ACTIONS, initializeRepair, applyRepairDecision, repairSnapshot, repairMetrics, validateRepairParams, validateRepairWorld, evaluateRepairSource, parseRepairSource, testRepairSource } from '../repair.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const act = (world, app_id, source) => applyRepairDecision(world, source === undefined ? { action: 'inspect', params: { app_id } } : { action: 'repair', params: { app_id, source } }).world;
const fixes = { checkout: 'floor(x*y*(100-z)/100)', temperature: 'x*9/5+32', boxes: 'ceil(x/y)', travel: 'x/y*60' };

test('repair opening apps really execute broken source, with independent golden examples', () => {
  const world = initializeRepair();
  assert.deepEqual(validateRepairWorld(world), { valid: true, errors: [] });
  assert.equal(world.decisions, 0);
  assert.equal(world.queue.length, 4);
  assert.ok(world.apps.every(app => app.original.passed < app.original.total));
  assert.deepEqual(evaluateRepairSource(world.apps[0].original.source, { x: 1299, y: 3, z: 10 }), { ok: true, value: 3887, error: null });
  assert.equal(world.apps[0].original.tests.find(row => row.id === 'ten-percent').expected, 3507);
  assert.equal(world.apps[1].original.tests[0].actual, 30);
  assert.equal(world.apps[2].original.tests[0].actual, 2);
  assert.equal(world.apps[3].original.tests[0].actual, 0.5);
});

test('safe evaluator is a real arithmetic interpreter with precedence and bounded functions', () => {
  const examples = [['2+3*4', {}, 14], ['(2+3)*4', {}, 20], ['-x*2+3', { x: 4 }, -5], ['max(0,min(100,x))', { x: 150 }, 100], ['ceil(x/y)', { x: 17, y: 6 }, 3], ['abs(-3)+round(1.6)', {}, 5], ['x-y-z', { x: 10, y: 3, z: 2 }, 5], ['x/y/2', { x: 12, y: 3 }, 2]];
  for (const [source, inputs, value] of examples) assert.deepEqual(evaluateRepairSource(source, inputs), { ok: true, value, error: null });
  assert.deepEqual(evaluateRepairSource('-0', {}), { ok: true, value: 0, error: null });
});

test('source parser rejects arbitrary JavaScript, malformed arity, depth and unbounded execution', () => {
  for (const source of ['globalThis.process', 'x;alert(1)', 'constructor(1)', 'Math.floor(x)', 'x**2', 'min(1)', 'floor(1,2)', '(()=>1)()', '1e300', '1000001', 'x x', '((((((((((((((x))))))))))))))', 'x+'.repeat(80) + 'x']) {
    assert.throws(() => parseRepairSource(source), undefined, source);
    assert.equal(evaluateRepairSource(source, { x: 1 }).ok, false, source);
  }
  for (const [source, inputs] of [['x/0', { x: 1 }], ['x*x*x', { x: 1000000 }], ['x', { x: Infinity }], ['x', { x: '10' }], ['x', { x: 1000001 }], ['x', { x: 1, alien: 2 }]]) assert.equal(evaluateRepairSource(source, inputs).ok, false);
});

test('inspection records actual measured deployed outputs without inventing a patch', () => {
  const prior = initializeRepair(), world = act(prior, 'checkout');
  assert.equal(world.inspections, 1);
  assert.equal(world.patches_tested, 0);
  assert.equal(world.latest_record.id, 'repair-1');
  assert.equal(world.latest_record.candidate, null);
  assert.equal(world.latest_record.verdict, 'inspected');
  assert.deepEqual(world.apps, prior.apps);
  assert.deepEqual(validateRepairWorld(world), { valid: true, errors: [] });
});

test('accepted source really fixes every app and original before versions stay executable', () => {
  let world = initializeRepair();
  for (const [id, source] of Object.entries(fixes)) {
    const old = clone(world), next = act(world, id, source), app = next.apps.find(app => app.id === id);
    assert.equal(next.latest_record.verdict, 'accepted');
    assert.equal(app.current.source, source);
    assert.ok(app.current.tests.every(row => row.passed && row.actual === row.expected));
    assert.equal(app.original.source, REPAIR_APPS.find(app => app.id === id).source);
    assert.ok(app.original.tests.some(row => !row.passed));
    assert.deepEqual(world, old, 'transition must not mutate the prior world');
    assert.deepEqual(validateRepairWorld(next), { valid: true, errors: [] });
    world = next;
  }
  assert.equal(world.accepted_patches, 4);
  assert.equal(world.queue.length, 0);
  assert.equal(repairMetrics(world).find(row => row.label === 'Working apps').value, 4);
  assert.equal(evaluateRepairSource(world.apps[0].current.source, { x: 1299, y: 3, z: 10 }).value, 3507);
  assert.equal(evaluateRepairSource(world.apps[0].original.source, { x: 1299, y: 3, z: 10 }).value, 3887);
});

test('bad but syntactically valid patches are rejected, retained and returned to queue', () => {
  let world = act(initializeRepair(), 'boxes', fixes.boxes);
  const accepted = clone(world.apps.find(app => app.id === 'boxes').current);
  world = act(world, 'boxes', 'round(x/y)');
  const app = world.apps.find(app => app.id === 'boxes');
  assert.equal(world.latest_record.verdict, 'rejected');
  assert.equal(world.latest_record.requeued, true);
  assert.ok(world.queue.includes('boxes'));
  assert.deepEqual(app.current, accepted);
  assert.equal(app.versions.at(-1).source, 'round(x/y)');
  assert.equal(app.versions.at(-1).status, 'rejected');
  assert.ok(app.versions.at(-1).tests.some(row => !row.passed));
  assert.deepEqual(validateRepairWorld(world), { valid: true, errors: [] });
});

test('no-op patch cannot claim progress and numeric fixture matching is exact', () => {
  const current = act(initializeRepair(), 'temperature', fixes.temperature);
  const next = act(current, 'temperature', fixes.temperature);
  assert.equal(next.latest_record.verdict, 'rejected');
  assert.equal(next.accepted_patches, 1);
  assert.match(next.latest_record.reason, /no source change/);
  assert.equal(testRepairSource('temperature', 'x*9/5+32+0.00000001').every(row => row.passed), false);
  assert.deepEqual(validateRepairWorld(next), { valid: true, errors: [] });
});

test('source/schema errors reject atomically without made-up reviewer activity', () => {
  const world = initializeRepair(), before = clone(world);
  for (const decision of [{ action: 'repair', params: { app_id: 'checkout', source: 'eval(x)' } }, { action: 'repair', params: { app_id: 'checkout', source: 'x', expected: 42 } }, { action: 'inspect', params: { app_id: 'unknown' } }, { action: 'invent', params: {} }]) assert.throws(() => applyRepairDecision(world, decision));
  assert.deepEqual(world, before);
  assert.deepEqual(validateRepairParams('repair', { app_id: 'boxes', source: ' ceil(x/y) ' }), { app_id: 'boxes', source: 'ceil(x/y)' });
  assert.equal(REPAIR_ACTIONS.length, 2);
});

test('validator recomputes executable artifacts and rejects receipt, fixture and queue tampering', () => {
  const world = act(act(initializeRepair(), 'checkout'), 'checkout', fixes.checkout);
  const mutations = [
    value => { value.apps[0].current.tests[0].actual = 999; },
    value => { value.apps[0].current.source = '0'; },
    value => { value.apps[0].fixtures[1].expected = 3887; },
    value => { value.apps[0].original.source = fixes.checkout; },
    value => { value.apps[0].versions[0].status = 'rejected'; },
    value => { value.queue.push('checkout'); },
    value => { value.records[1].candidate.tests[1].passed = false; },
    value => { value.latest_record.verdict = 'rejected'; },
    value => { value.agent_memory.last_results[0].passed = 777; },
    value => { value.apps[0].last_accepted_decision = 1; },
    value => { value.apps[1].last_patch_decision = 1; },
    value => { value.accepted_patches += 1; },
    value => { value.records[1].params.source = '0'; },
  ];
  for (const mutate of mutations) { const changed = clone(world); mutate(changed); assert.equal(validateRepairWorld(changed).valid, false, mutate.toString()); }
});

test('bounded working state preserves executable originals/current while immutable snapshots retain every attempt', () => {
  let world = initializeRepair(); const snapshots = [];
  for (let i = 0; i < 60; i++) {
    world = act(world, 'temperature', i % 3 === 0 ? `x*9/5+32+${i}-(${i})` : 'x*9/5+30');
    assert.deepEqual(validateRepairWorld(world), { valid: true, errors: [] });
    snapshots.push(repairSnapshot(world));
  }
  assert.equal(world.records.length, 12);
  assert.equal(world.apps[1].versions.length, 8);
  assert.equal(world.apps[1].archived_versions, 52);
  assert.equal(world.archived_records.decisions, 48);
  assert.equal(world.patches_tested, 60);
  assert.equal(snapshots[0].world.latest_record.id, 'repair-1');
  assert.equal(snapshots[0].world.latest_record.candidate.source, 'x*9/5+32+0-(0)');
  assert.equal(snapshots.at(-1).world.latest_record.id, 'repair-60');
  assert.equal(snapshots[0].world.records.length, 1);
  assert.equal(snapshots.at(-1).world.records.length, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshots.at(-1))) < 55000);
  const keySorted = value => Array.isArray(value) ? value.map(keySorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, keySorted(value[key])])) : value;
  assert.deepEqual(validateRepairWorld(keySorted(world)), { valid: true, errors: [] }, 'R2 canonical object key sorting cannot alter evidence');
});

test('opening artifact identities cannot hide a self-consistent unrecorded repair', () => {
  const world = act(initializeRepair(), 'temperature');
  const forged = clone(world), app = forged.apps[0];
  app.current.source = fixes.checkout;
  app.current.tests = testRepairSource(app.id, app.current.source);
  app.current.passed = app.current.tests.filter(row => row.passed).length;
  assert.equal(app.current.passed, app.current.total);
  assert.equal(validateRepairWorld(forged).valid, false);
  const receiptForgery = clone(world);
  receiptForgery.records[0].before.source = fixes.temperature;
  receiptForgery.records[0].before.tests = testRepairSource('temperature', fixes.temperature);
  receiptForgery.records[0].before.passed = receiptForgery.records[0].before.total;
  receiptForgery.latest_record = clone(receiptForgery.records[0]);
  receiptForgery.apps[1].current = clone(receiptForgery.records[0].before);
  assert.equal(validateRepairWorld(receiptForgery).valid, false);
});

test('every retained historical snapshot carries independently checkable full bounded receipts', () => {
  let world = initializeRepair(); const snapshots = [];
  for (let i = 0; i < 40; i++) { world = act(world, 'checkout', i === 0 ? fixes.checkout : 'floor(x*y-z)'); snapshots.push(repairSnapshot(world)); }
  for (const snapshot of snapshots) assert.deepEqual(validateRepairWorld(snapshot.world), { valid: true, errors: [] });
  for (const index of [0, 13, 28, 39]) {
    const sourceForgery = clone(snapshots[index]); sourceForgery.world.apps[0].current.source = '0';
    assert.equal(validateRepairWorld(sourceForgery.world).valid, false);
    const fixtureForgery = clone(snapshots[index]); fixtureForgery.world.apps[0].fixtures[0].expected = 999;
    assert.equal(validateRepairWorld(fixtureForgery.world).valid, false);
    const receiptForgery = clone(snapshots[index]); receiptForgery.world.records.at(-1).before.tests[0].actual = -1;
    assert.equal(validateRepairWorld(receiptForgery.world).valid, false);
  }
});
