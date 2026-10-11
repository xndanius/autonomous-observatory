import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleApi } from '../worker/routes.mjs';

globalThis.crypto ||= webcrypto;
const TOKEN = 'test-split-storage-token-with-at-least-32-characters';
const AT = '2026-10-11T10:00:00Z';
const clone = x => JSON.parse(JSON.stringify(x));
const META = ['id', 'type', 'title', 'description', 'created_at', 'updated_at', 'status', 'turn', 'roles', 'metrics'];
class Bucket {
  objects = new Map(); sequence = 0; beforePut = null; reads = [];
  async get(key) {
    this.reads.push(key);
    const saved = this.objects.get(key);
    return saved ? { httpEtag: saved.etag, json: async () => JSON.parse(saved.body) } : null;
  }
  async put(key, body, options = {}) {
    if (this.beforePut) await this.beforePut(key, body);
    const current = this.objects.get(key);
    const match = options.onlyIf?.get('if-match'), absent = options.onlyIf?.get('if-none-match');
    if ((match && current?.etag !== match) || (absent === '*' && current)) return null;
    const etag = '"' + ++this.sequence + '"';
    this.objects.set(key, { body, etag, options });
    return { httpEtag: etag };
  }
}
function event(turn) {
  return { turn, at: AT, actor: 'Researcher', observation: 'Observe public evidence.', decision: { action: 'test', params: { steps: 8 } }, reason: 'Test a claim.', alternatives: ['Hold'], consequence: 'Measured result.', evidence: [{ label: 'Turn', value: turn }], snapshot: { cells: [[1, 2]], facts: ['Preserve exact evidence.'] } };
}
function experiment(id, turns) {
  return { schema_version: 1, id, type: 'life-research', title: `Research ${id}`, description: 'A reproducible simulation.', created_at: AT, updated_at: AT, turn: turns, status: 'active', roles: ['Explorer', 'Reviewer'], metrics: [{ label: 'Tests', value: turns, unit: 'experiments' }], timeline: Array.from({ length: turns }, (_, n) => event(n + 1)).slice(-12), memory: { observations: ['Measured and remembered.'], facts: [{ turn: 1, value: 'A retained fact.' }], last_decision: null }, world: { cells: [[1, 2], [2, 3]], records: [{ frames: ['123456'], outcomes: [true, false], text: 'Exact nested world.' }] }, allowed_actions: [{ id: 'test', params: ['steps'] }] };
}
function state(revision = 1, turns = 1) {
  return { schema_version: 1, title: 'The Autonomous Observatory', created_at: AT, updated_at: AT, revision,
    schedule: { factory_minutes: 60, loop_minutes: 5, status: 'active', requires: 'Mac awake and Codex running', next_launch_at: AT, next_tick_at: AT },
    experiments: [experiment('life-001', turns), experiment('life-002', turns)],
    launches: ['life-001', 'life-002'].map(id => ({ id, type: 'life-research', title: `Research ${id}`, at: AT, reason: 'Demonstrate consequences and memory.' })),
  };
}
const env = () => ({ BUCKET: new Bucket(), OBSERVATORY_WRITE_TOKEN: TOKEN });
async function get(runtime, path = '/api/state') { return handleApi(new Request('https://example.test' + path), runtime); }
async function put(runtime, path, data, token = TOKEN, headers = {}) {
  return handleApi(new Request('https://example.test' + path, { method: 'PUT', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(data) }), runtime);
}
async function stage(runtime, e) {
  const response = await put(runtime, `/api/experiments/${e.id}/state`, { experiment: e });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return (await response.json()).state_ref;
}
async function indexed(runtime, full) {
  const experiments = [];
  for (const e of full.experiments) experiments.push({ ...Object.fromEntries(META.map(k => [k, e[k]])), state_ref: await stage(runtime, e) });
  return { ...full, storage_format: 'split-v1', experiments };
}
const publish = (runtime, index, expected = index.revision - 1) => put(runtime, '/api/index', { expected_revision: expected, state: index });

test('legacy-to-split migration preserves exact nested worlds, revisions, events, and public links', async () => {
  const runtime = env(), legacy = state(1, 1);
  assert.equal((await put(runtime, '/api/state', { expected_revision: 0, state: legacy })).status, 200);
  const legacyIndex = await (await get(runtime, '/api/index')).json();
  assert.equal(legacyIndex.storage_format, 'legacy');
  assert.equal(legacyIndex.experiments[0].state_ref.length, 64);
  assert.deepEqual(Object.keys(legacyIndex.experiments[0]).sort(), [...META, 'state_ref'].sort());
  const next = state(2, 2), index = await indexed(runtime, next);
  assert.equal((await publish(runtime, index)).status, 200);
  assert.deepEqual(await (await get(runtime)).json(), next);
  assert.deepEqual(await (await get(runtime, '/api/index')).json(), index);
  assert.deepEqual(await (await get(runtime, '/api/history?revision=1')).json(), legacy);
  assert.deepEqual(await (await get(runtime, '/api/history?revision=2')).json(), next);
  for (const e of next.experiments) {
    assert.deepEqual(await (await get(runtime, `/api/experiments/${e.id}/state`)).json(), e);
    assert.deepEqual(await (await get(runtime, `/api/experiments/${e.id}/state?revision=1`)).json(), legacy.experiments.find(x => x.id === e.id));
    assert.deepEqual((await (await get(runtime, `/api/experiments/${e.id}/history?before=3&limit=2`)).json()).events, [event(1), event(2)]);
  }
  assert.equal(JSON.parse(runtime.BUCKET.objects.get('observatory/state.json').body).storage_format, 'split-v1');
  assert.equal(JSON.parse(runtime.BUCKET.objects.get('observatory/revisions/1.json').body).storage_format, undefined);
  assert.equal(JSON.parse(runtime.BUCKET.objects.get('observatory/revisions/2.json').body).storage_format, 'split-v1');
});

test('staging is idempotent, content addressed, and invisible until a successful pointer commit', async () => {
  const runtime = env(), e = experiment('life-001', 1);
  const ref = await stage(runtime, e), size = runtime.BUCKET.objects.size;
  assert.match(ref, /^[a-f0-9]{64}$/);
  assert.equal(await stage(runtime, Object.fromEntries(Object.entries(e).reverse())), ref);
  assert.equal(runtime.BUCKET.objects.size, size);
  assert.equal((await get(runtime, '/api/experiments/life-001/state')).status, 404);
  assert.equal((await get(runtime, '/api/experiments/life-001/state?revision=1')).status, 404);
  assert.equal((await (await get(runtime)).json()).revision, 0);
  assert.equal((await (await get(runtime, '/api/index')).json()).experiments.length, 0);
  const full = state(), index = await indexed(runtime, full);
  assert.equal((await publish(runtime, index)).status, 200);
  const changed = clone(full.experiments[0]); changed.world.cells.push([8, 9]);
  assert.notEqual(await stage(runtime, changed), ref);
  assert.deepEqual(await (await get(runtime, '/api/experiments/life-001/state')).json(), e);
});

test('experiment complexity is independently bounded while legacy roots and depth retain their limits', async () => {
  const runtime = env(), full = state(), large = full.experiments[0];
  large.world.measured_grid = Array.from({ length: 30 }, () => Array(10000).fill(0));
  assert(Buffer.byteLength(JSON.stringify({ experiment: large })) < 4 * 1024 * 1024);
  const ref = await stage(runtime, large);
  assert.match(ref, /^[a-f0-9]{64}$/);
  const legacy = await put(runtime, '/api/state', { expected_revision: 0, state: full });
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json()).error, 'Public state is too complex');
  const before = runtime.BUCKET.objects.size;
  const excessive = clone(large);
  excessive.world.measured_grid.push(...Array.from({ length: 6 }, () => Array(10000).fill(0)));
  const rejected = await put(runtime, `/api/experiments/${large.id}/state`, { experiment: excessive });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'Public state is too complex');
  assert.equal(runtime.BUCKET.objects.size, before);
  const deep = clone(large);
  delete deep.world.measured_grid;
  deep.world.probe = Array.from({ length: 26 }).reduce(value => ({ nested: value }), {});
  assert.equal((await put(runtime, `/api/experiments/${large.id}/state`, { experiment: deep })).status, 400);
  assert.equal(runtime.BUCKET.objects.size, before);
  const index = await indexed(runtime, full);
  assert.equal((await publish(runtime, index)).status, 200);
  assert.deepEqual(await (await get(runtime, `/api/experiments/${large.id}/state`)).json(), large);
});

test('compact index and status read no experiment blobs; individual and event reads load only the selected world', async () => {
  const runtime = env(), index = await indexed(runtime, state());
  await publish(runtime, index);
  for (const path of ['/api/index', '/api/status']) {
    runtime.BUCKET.reads.length = 0;
    assert.equal((await get(runtime, path)).status, 200);
    assert.deepEqual(runtime.BUCKET.reads, ['observatory/state.json']);
  }
  for (const path of ['/api/experiments/life-001/state', '/api/experiments/life-001/history']) {
    runtime.BUCKET.reads.length = 0;
    assert.equal((await get(runtime, path)).status, 200);
    const refs = runtime.BUCKET.reads.filter(k => k.startsWith('observatory/experiment-states/'));
    assert.deepEqual(refs, [`observatory/experiment-states/${index.experiments[0].state_ref}.json`]);
  }
});

test('idempotent current and earlier split retries keep committed archives and pointer unchanged', async () => {
  const runtime = env(), first = await indexed(runtime, state(1, 1));
  await publish(runtime, first);
  assert.equal((await (await publish(runtime, first)).json()).action, 'already_published');
  const second = await indexed(runtime, state(2, 2)); await publish(runtime, second);
  const retry = await (await publish(runtime, first)).json();
  assert.equal(retry.action, 'already_published'); assert.equal(retry.current_revision, 2);
  assert.deepEqual(await (await get(runtime, '/api/index')).json(), second);
  // Legacy full-state clients may also retry a revision originally committed split.
  assert.equal((await (await put(runtime, '/api/state', { expected_revision: 0, state: state(1, 1) })).json()).action, 'already_published');
  assert.deepEqual(await (await get(runtime, '/api/history?revision=1')).json(), state(1, 1));
  assert.equal((await put(runtime, '/api/state', { expected_revision: 2, state: state(3, 3) })).status, 200);
  assert.deepEqual(await (await get(runtime)).json(), state(3, 3));
  assert.deepEqual(await (await get(runtime, '/api/history?revision=2')).json(), state(2, 2));
});

test('stale proposals and racing split commits cannot advance twice or publish losing staged experiments', async () => {
  const runtime = env(); await publish(runtime, await indexed(runtime, state(1, 1)));
  const a = await indexed(runtime, state(2, 2));
  const competing = state(2, 2); competing.experiments[0].timeline[1].reason = 'Another independently proposed action.';
  const b = await indexed(runtime, competing);
  let reached = 0, release; const barrier = new Promise(resolve => { release = resolve; });
  runtime.BUCKET.beforePut = async key => { if (key === 'observatory/state.json') { if (++reached === 2) release(); await barrier; } };
  const results = await Promise.all([publish(runtime, a), publish(runtime, b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  runtime.BUCKET.beforePut = null;
  const winner = await (await get(runtime, '/api/index')).json();
  const loser = winner.experiments[0].state_ref === a.experiments[0].state_ref ? b : a;
  assert.equal((await publish(runtime, loser)).status, 409);
  assert.deepEqual(await (await get(runtime, '/api/history?revision=2')).json(), await (await get(runtime)).json());
});

test('metadata, arbitrary references, hash corruption, private fields and invalid staging identity are rejected', async () => {
  const runtime = env(), first = await indexed(runtime, state(1, 1)); await publish(runtime, first);
  const next = await indexed(runtime, state(2, 2));
  for (const change of [
    x => { x.experiments[0].metrics[0].value = 999; },
    x => { x.experiments[0].state_ref = 'observatory/state.json'; },
    x => { x.experiments[0].state_ref = 'a'.repeat(64); },
    x => { x.experiments[0].world = {}; },
    x => { x.schedule.credentials = 'not public'; },
  ]) { const bad = clone(next); change(bad); assert.equal((await publish(runtime, bad)).status, 400); }
  const key = `observatory/experiment-states/${next.experiments[0].state_ref}.json`, stored = runtime.BUCKET.objects.get(key);
  const changed = JSON.parse(stored.body); changed.world.cells.push([9, 9]); stored.body = JSON.stringify(changed);
  assert.equal((await publish(runtime, next)).status, 400);
  for (const key of ['oracle', '_private', 'access_token', 'credentials']) {
    const bad = experiment('life-001', 2); bad.world[key] = 'forbidden';
    assert.equal((await put(runtime, '/api/experiments/life-001/state', { experiment: bad })).status, 400);
  }
  assert.equal((await put(runtime, '/api/experiments/wrong-id/state', { experiment: experiment('life-001', 2) })).status, 400);
  assert.equal((await (await get(runtime)).json()).revision, 1);
});

test('split commits preserve overlapping events, experiment identities, launches, and all additions fitting the tail', async () => {
  const runtime = env(); await publish(runtime, await indexed(runtime, state(1, 2)));
  for (const alter of [
    x => { x.experiments[0].timeline[0].reason = 'Rewritten past'; },
    x => { x.experiments[0].turn = 1; x.experiments[0].timeline = [event(1)]; },
    x => { x.experiments[0].type = 'different-engine'; },
    x => { x.launches[0].reason = 'Rewritten origin'; },
    x => { x.experiments = x.experiments.slice(1); x.launches = x.launches.slice(1); },
  ]) {
    const bad = state(2, 3); alter(bad);
    assert.equal((await publish(runtime, await indexed(runtime, bad))).status, 409);
  }
  assert.equal((await publish(runtime, await indexed(runtime, state(2, 15)))).status, 409); // Thirteen new turns cannot be repaired from twelve retained frames.
  assert.equal((await publish(runtime, await indexed(runtime, state(2, 14)))).status, 200);
  assert.deepEqual((await (await get(runtime, '/api/experiments/life-001/history?before=3')).json()).events, [event(1), event(2)]);
});

test('interrupted revision and event archives repair on retry or before the following split pointer advances', async () => {
  for (const failedKey of ['observatory/revisions/1.json', 'observatory/events/life-001/1.json']) {
    const runtime = env(), first = await indexed(runtime, state(1, 2)); let fail = true;
    runtime.BUCKET.beforePut = async key => { if (fail && key === failedKey) { fail = false; throw new Error('Interrupted archive write'); } };
    assert.equal((await publish(runtime, first)).status, 503);
    assert.equal((await (await get(runtime)).json()).revision, 1);
    if (failedKey.includes('revisions')) assert.equal((await (await publish(runtime, first)).json()).action, 'already_published');
    else assert.equal((await publish(runtime, await indexed(runtime, state(2, 3)))).status, 200);
    assert.ok(runtime.BUCKET.objects.has(failedKey));
    assert.deepEqual((await (await get(runtime, '/api/experiments/life-001/history?before=3')).json()).events, [event(1), event(2)]);
    assert.deepEqual(await (await get(runtime, '/api/history?revision=1')).json(), state(1, 2));
  }
});

test('new writes authenticate before body and storage, and enforce the independent staging size guard', async () => {
  for (const path of ['/api/index', '/api/experiments/life-001/state']) {
    const runtime = { OBSERVATORY_WRITE_TOKEN: TOKEN, BUCKET: { get() { throw new Error('Must not read storage'); }, put() { throw new Error('Must not write storage'); } } };
    assert.equal((await put(runtime, path, { credentials: 'not public' }, null)).status, 401);
    assert.equal((await put(runtime, path, {}, 'wrong')).status, 401);
  }
  const runtime = env();
  assert.equal((await put(runtime, '/api/experiments/life-001/state', { experiment: experiment('life-001', 1) }, TOKEN, { 'content-length': String(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(runtime.BUCKET.objects.size, 0);
  for (const revision of ['', '0', '-1', 'bogus']) assert.equal((await get(runtime, '/api/experiments/life-001/state?revision=' + revision)).status, 400);
});


test('independently bounded experiment blobs can exceed the legacy combined request limit', async () => {
  const runtime = env(), full = state();
  full.experiments.push(experiment('life-003', 1));
  full.launches.push({ id: 'life-003', type: 'life-research', title: 'Research life-003', at: AT, reason: 'Independent large state.' });
  for (const e of full.experiments) e.world.public_documents = Array.from({ length: 42 }, (_, n) => String(n).padEnd(50000, 'x'));
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 4 * 1024 * 1024);
  const index = await indexed(runtime, full);
  assert.ok(Buffer.byteLength(JSON.stringify(index)) < 10000);
  assert.equal((await publish(runtime, index)).status, 200);
  const returned = await (await get(runtime, '/api/experiments/life-003/state')).json();
  assert.deepEqual(returned, full.experiments[2]);
  assert.equal((await (await get(runtime, '/api/status')).json()).experiments, 3);
});
