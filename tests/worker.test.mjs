import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handleApi } from '../worker/routes.mjs';

globalThis.crypto ||= webcrypto;
const TOKEN = 'test-write-token-with-at-least-32-characters';
const AT = '2026-10-11T10:00:00Z';
const clone = x => JSON.parse(JSON.stringify(x));
class Bucket {
  objects = new Map();
  sequence = 0;
  beforePut = null;
  async get(key) {
    const saved = this.objects.get(key);
    return saved ? { httpEtag: saved.etag, json: async () => JSON.parse(saved.body) } : null;
  }
  async put(key, body, options = {}) {
    if (this.beforePut) await this.beforePut(key, body);
    const current = this.objects.get(key);
    const match = options.onlyIf?.get('if-match');
    const absent = options.onlyIf?.get('if-none-match');
    if (match && current?.etag !== match) return null;
    if (absent === '*' && current) return null;
    const etag = '"' + ++this.sequence + '"';
    this.objects.set(key, { body, etag, options });
    return { httpEtag: etag };
  }
}
function entry(turn) {
  return { turn, at: AT, actor: 'Operator', observation: 'One bicycle needs repair.', decision: { action: 'repair', params: {} }, reason: 'Meet demand.', alternatives: [], consequence: 'Bicycle repaired.', evidence: [{ label: 'Repairs', value: turn }], memory: { learned: 'Check inventory.', retained: [] }, snapshot: { cash: 90 + turn } };
}
function state(revision = 1, turns = 0) {
  return { schema_version: 1, title: 'The Autonomous Observatory', created_at: AT, updated_at: AT, revision,
    schedule: { factory_minutes: 60, loop_minutes: 5, status: 'active', requires: 'Mac awake and Codex running', next_launch_at: AT, next_tick_at: AT },
    experiments: [{ schema_version: 1, id: 'bike-001', type: 'tiny_company', title: 'Bicycle Workshop', description: 'A deterministic bicycle workshop.', created_at: AT, updated_at: AT, turn: turns, status: 'active', roles: ['Operator'], metrics: [{ label: 'Cash', value: 100, unit: 'credits' }], timeline: Array.from({ length: turns }, (_, n) => entry(n + 1)).slice(-120), memory: { observations: [], facts: [], last_decision: null }, world: { cash: 100 }, allowed_actions: ['repair'] }],
    launches: [{ id: 'bike-001', type: 'tiny_company', title: 'Bicycle Workshop', at: AT, reason: 'Demonstrate operational memory.' }],
  };
}
function env() { return { BUCKET: new Bucket(), OBSERVATORY_WRITE_TOKEN: TOKEN }; }
async function put(runtime, next, expected = next.revision - 1, token = TOKEN, extra = {}, events) {
  return handleApi(new Request('https://example.test/api/state', { method: 'PUT', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, body: JSON.stringify({ expected_revision: expected, state: next, ...(events === undefined ? {} : { events }) }) }), runtime);
}
async function get(runtime, path = '/api/state') { return handleApi(new Request('https://example.test' + path), runtime); }

test('public read returns honest empty state; writes require a configured correct bearer', async () => {
  const runtime = env();
  const response = await get(runtime);
  const empty = await response.json();
  assert.equal(response.status, 200);
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.experiments, []);
  assert.equal(empty.schedule.status, 'preparing');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  for (const token of [null, 'wrong']) assert.equal((await put(runtime, state(), 0, token)).status, 401);
  assert.equal((await put({ BUCKET: runtime.BUCKET }, state())).status, 401);
  assert.equal(runtime.BUCKET.objects.size, 0);
});

test('first publication persists state and immutable revision; public status and history match', async () => {
  const runtime = env();
  const publication = await put(runtime, state(1, 1));
  assert.equal(publication.status, 200);
  assert.equal((await publication.json()).action, 'published');
  assert.deepEqual(await (await get(runtime)).json(), state(1, 1));
  assert.deepEqual(await (await get(runtime, '/api/history?revision=1')).json(), state(1, 1));
  const status = await (await get(runtime, '/api/status')).json();
  assert.equal(status.experiments, 1);
  assert.equal(status.turns, 1);
  assert.equal(status.updated_at, AT);
  assert.equal(runtime.BUCKET.objects.get('observatory/state.json').options.onlyIf.get('if-none-match'), '*');
});

test('stale revisions and future revisions fail without changing persisted state', async () => {
  const runtime = env();
  await put(runtime, state());
  const changed = state(); changed.experiments[0].world.cash = 500;
  assert.equal((await put(runtime, changed, 0)).status, 409);
  assert.equal((await put(runtime, state(3), 2)).status, 409);
  assert.equal((await put(runtime, state(3), 1)).status, 400);
  assert.deepEqual(await (await get(runtime)).json(), state());
});

test('past timeline, launches, and experiment identity cannot change or disappear', async () => {
  const runtime = env();
  await put(runtime, state(1, 1));
  const cases = [];
  let changed = state(2, 2); changed.experiments[0].timeline[0].reason = 'Rewritten past'; cases.push(changed);
  changed = state(2, 0); cases.push(changed);
  changed = state(2, 1); changed.experiments = []; changed.launches = []; cases.push(changed);
  changed = state(2, 1); changed.experiments[0].type = 'another_simulator'; cases.push(changed);
  changed = state(2, 1); changed.experiments[0].created_at = '2026-10-12T10:00:00Z'; cases.push(changed);
  changed = state(2, 1); changed.launches[0].reason = 'Changed founding reason'; cases.push(changed);
  for (const next of cases) assert.equal((await put(runtime, next)).status, 409);
  assert.deepEqual(await (await get(runtime)).json(), state(1, 1));
  assert.equal((await put(runtime, state(2, 2))).status, 200);
});

test('same semantic retry is idempotent, including an archived earlier revision', async () => {
  const runtime = env();
  await put(runtime, state(1, 1));
  const ordered = Object.fromEntries(Object.entries(state(1, 1)).reverse());
  let reply = await put(runtime, ordered, 0);
  assert.equal((await reply.json()).action, 'already_published');
  await put(runtime, state(2, 2));
  reply = await put(runtime, state(1, 1), 0);
  assert.equal((await reply.json()).current_revision, 2);
  assert.equal((await (await get(runtime)).json()).revision, 2);
});

test('two writers racing with the same base cannot lose an update or poison revision archive', async () => {
  const runtime = env();
  await put(runtime, state());
  let reached = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  runtime.BUCKET.beforePut = async key => {
    if (key !== 'observatory/state.json') return;
    if (++reached === 2) release();
    await barrier;
  };
  const a = state(2, 1), b = state(2, 1); b.experiments[0].timeline[0].reason = 'Another proposed decision';
  const results = await Promise.all([put(runtime, a), put(runtime, b)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  const winner = await (await get(runtime)).json();
  assert.equal(winner.revision, 2);
  assert.deepEqual(await (await get(runtime, '/api/history?revision=2')).json(), winner);
  assert.equal(runtime.BUCKET.objects.size, 4);
});

test('bounded timeline trimming preserves complete immutable event history and pagination', async () => {
  const runtime = env();
  assert.equal((await put(runtime, state(1, 120))).status, 200);
  const next = state(2, 121);
  assert.equal((await put(runtime, next, 1, TOKEN, {}, { 'bike-001': [entry(121)] })).status, 200);
  const live = await (await get(runtime)).json();
  assert.equal(live.experiments[0].turn, 121);
  assert.equal(live.experiments[0].timeline.length, 120);
  assert.equal(live.experiments[0].timeline[0].turn, 2);
  let page = await (await get(runtime, '/api/experiments/bike-001/history?limit=120')).json();
  assert.deepEqual(page.events.map(e => e.turn), Array.from({ length: 120 }, (_, n) => n + 2));
  assert.equal(page.next_before, 2);
  page = await (await get(runtime, '/api/experiments/bike-001/history?before=2')).json();
  assert.deepEqual(page.events, [entry(1)]);
  assert.equal(page.next_before, null);
  const changed = state(3, 122); changed.experiments[0].timeline[0].reason = 'Rewrite retained past';
  assert.equal((await put(runtime, changed)).status, 409);
});

test('conflicting or missing explicit event deltas cannot advance the pointer', async () => {
  const runtime = env();
  await put(runtime, state());
  assert.equal((await put(runtime, state(2, 1), 1, TOKEN, {}, { 'bike-001': [] })).status, 409);
  const changed = entry(1); changed.reason = 'A different event';
  assert.equal((await put(runtime, state(2, 1), 1, TOKEN, {}, { 'bike-001': [changed] })).status, 409);
  assert.equal((await (await get(runtime)).json()).revision, 1);
});

test('an archive write interruption is repaired by an idempotent retry', async () => {
  const runtime = env();
  let fail = true;
  runtime.BUCKET.beforePut = async key => {
    if (fail && key === 'observatory/revisions/1.json') { fail = false; throw new Error('Storage unavailable'); }
  };
  assert.equal((await put(runtime, state())).status, 503);
  assert.equal((await (await get(runtime)).json()).revision, 1);
  const retry = await put(runtime, state());
  assert.equal((await retry.json()).action, 'already_published');
  assert.deepEqual(await (await get(runtime, '/api/history?revision=1')).json(), state());
});

test('interrupted event archives are repaired before a later revision advances', async () => {
  const runtime = env();
  let fail = true;
  runtime.BUCKET.beforePut = async key => {
    if (fail && key === 'observatory/events/bike-001/1.json') { fail = false; throw new Error('Event write interrupted'); }
  };
  assert.equal((await put(runtime, state(1, 1))).status, 503);
  assert.deepEqual((await (await get(runtime, '/api/experiments/bike-001/history')).json()).events, [entry(1)]);
  assert.equal((await put(runtime, state(2, 2))).status, 200);
  assert.ok(runtime.BUCKET.objects.has('observatory/events/bike-001/1.json'));
  assert.deepEqual((await (await get(runtime, '/api/experiments/bike-001/history')).json()).events, [entry(1), entry(2)]);
});

test('private fields, oversized bodies, invalid timeline sequences, and anonymous methods fail safely', async () => {
  const runtime = env();
  for (const key of ['oracle', '_private', 'secrets', 'write_token']) {
    const next = state(); next.experiments[0].world[key] = { hidden: 'not public' };
    assert.equal((await put(runtime, next)).status, 400);
  }
  assert.equal((await put(runtime, state(), 0, TOKEN, { 'content-length': String(4 * 1024 * 1024 + 1) })).status, 413);
  const bad = state(1, 1); bad.experiments[0].timeline[0].turn = 2;
  assert.equal((await put(runtime, bad)).status, 400);
  const response = await handleApi(new Request('https://example.test/api/state', { method: 'POST', body: '{}' }), runtime);
  assert.equal(response.status, 405);
  assert.equal(runtime.BUCKET.objects.size, 0);
  assert.equal(await handleApi(new Request('https://example.test/'), runtime), null);
});
