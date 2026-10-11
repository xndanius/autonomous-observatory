import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createExperiment, applyDecision, toPublicExperiment, validateExperiment, TYPE_CATALOG } from '../engine.mjs';
import { createSeededCloudLaunch, CLOUD_SEEDED_TYPES } from '../cloud-seeds.mjs';

const createdAt = '2026-10-11T00:00:00.000Z';
const copy = value => JSON.parse(JSON.stringify(value));
const seeded = (type, value = 'seed-alpha') => createExperiment({ id: 'seeded-fixture', type, createdAt,
  goal: 'Measure the consequences in this independent seeded world.', seed: { version: 1, value } });
const valid = state => assert.deepEqual(validateExperiment(state), { valid: true, errors: [] });
const advance = (state, decision) => applyDecision(state, decision, { now: new Date(Date.parse(createdAt) + (state.turn + 1) * 60000).toISOString() });

test('legacy constructor JSON and identity remain exactly unchanged for every existing type', () => {
  // Recorded before introducing optional seeds or checkpoints.
  const expected = {
    'bicycle-company': '420a2f97647bae1953ae6d3ceb08fce6462dc65b8935835792d9e9ed5948738c',
    'alien-language': 'ee55a2fd7b4d78914c80d29b5305f72e6c297dff451d357eb956e6710e5c9614',
    'invention-league': '1e125dd16b01f82177d6bbc8008b9f234795725ba166978b6884a46ccee7eaae',
    'flood-city': '58a4e9bf8ae64d0aad7fd4e4f932248f8f5ea04d565bf8a982225656ad559b8d',
    'life-research': '55180fba9fdb76babc42625d4bf4b9caad9947ee5b83facad68f7c61bfac9a56',
  };
  for (const type of Object.keys(TYPE_CATALOG)) {
    const state = createExperiment({ id: 'legacy-fixture', type, createdAt });
    assert.equal(createHash('sha256').update(JSON.stringify(state)).digest('hex'), expected[type], type);
    assert.equal(state.seed, undefined);
    assert.equal(state.goal, undefined);
    assert.equal(state.timeline_start_turn, undefined);
  }
});

test('seed version, unknown keys, malformed seeds and goals are rejected', () => {
  const base = { id: 'seeded-fixture', type: 'alien-language', createdAt };
  for (const seed of [null, 'seed-alpha', {}, { version: 2, value: 'alpha' }, { version: 1, value: '' },
    { version: 1, value: 'a'.repeat(161) }, { version: 1, value: 'alpha', oracle: {} }]) {
    assert.throws(() => createExperiment({ ...base, seed }), /seed/);
  }
  assert.throws(() => createExperiment({ ...base, goal: '' }), /goal/);
  assert.throws(() => createExperiment({ ...base, type: 'invented-type', seed: { version: 1, value: 'alpha' } }), /Unknown experiment type/);
  const forged = seeded('alien-language');
  forged.seed.version = 2;
  assert.equal(validateExperiment(forged).valid, false);
});

test('all five seeded types replay exactly and have observable different starting worlds', () => {
  for (const type of CLOUD_SEEDED_TYPES) {
    const alpha = seeded(type);
    const beta = seeded(type, 'seed-beta');
    valid(alpha); valid(beta);
    assert.deepEqual(copy(alpha), seeded(type), type);
    assert.notDeepEqual(alpha.world, beta.world, `${type} must change its world, not only metadata`);
    assert.deepEqual(alpha.world, createExperiment({ id: 'independent-id', type, createdAt, seed: alpha.seed }).world, `${type} seeds do not depend on the instance id`);
    assert.equal(alpha.turn, 0);
    assert.deepEqual(alpha.timeline, []);
    const published = toPublicExperiment(alpha);
    assert.deepEqual(published.seed, alpha.seed);
    assert.equal(published.goal, alpha.goal);
  }
});

test('seeded language and routing private and public forks produce exactly the same decisions', () => {
  const decisions = {
    'alien-language': [
      { action: 'probe', params: { subject: 'we', verb: 'find', object: 'water', tense: 'past' } },
      { action: 'hypothesize', params: { rule: 'word-order', answer: 'SOV' } },
      { action: 'validate', params: { rule: 'word-order' } },
    ],
    'invention-league': [
      { action: 'candidate', params: { name: 'Nearest seeded route', heuristic: 'nearest' } },
      { action: 'candidate', params: { name: 'Seeded lookahead', heuristic: 'lookahead', params: { lookahead_weight: 0.7 } } },
      { action: 'replay', params: { fixture_id: 'training-2' } },
    ],
  };
  for (const [type, actions] of Object.entries(decisions)) {
    let privateState = seeded(type), publicState = toPublicExperiment(privateState);
    for (const decision of actions) {
      privateState = advance(privateState, decision);
      publicState = advance(publicState, decision);
      assert.deepEqual(publicState, toPublicExperiment(privateState));
      valid(publicState);
      assert.doesNotMatch(JSON.stringify(publicState), /_private|language_oracle|withheld_sentences|routing_holdout|withheld-[123]/);
    }
  }
});

test('seeded language heldout has coverage, excludes initial examples and remains private', () => {
  const state = seeded('alien-language');
  const withheld = state._private.withheld_sentences;
  assert.equal(withheld.length, 9);
  for (const fixture of withheld) assert(!state.world.examples.some(example =>
    ['subject', 'verb', 'object', 'tense'].every(field => fixture[field] === example[field])));
  const covered = new Set(withheld.flatMap(fixture => [fixture.subject, fixture.verb, fixture.object]));
  for (const word of ['I', 'you', 'we', 'see', 'carry', 'find', 'star', 'stone', 'water']) assert(covered.has(word));
  const forged = copy(state);
  forged._private.language_oracle.word_order = state._private.language_oracle.word_order === 'SOV' ? 'SVO' : 'SOV';
  assert.equal(validateExperiment(forged).valid, false);
});

test('seeded routing fixtures are unique, reachable, reproducible and heldout locations stay private', () => {
  for (let i = 0; i < 16; i += 1) {
    const state = seeded('invention-league', `warehouse-${i}`);
    const world = state.world;
    const walls = new Set(world.challenge.walls.map(cell => `${cell.x},${cell.y}`));
    const fixtures = [...world.fixtures, ...state._private.routing_holdout];
    assert.equal(world.fixtures.length, 4);
    assert.equal(state._private.routing_holdout.length, 3);
    const signatures = fixtures.map(fixture => fixture.picks.map(cell => `${cell.x},${cell.y}`).sort().join(';'));
    assert.equal(new Set(signatures).size, 7);
    for (const fixture of fixtures) {
      assert.equal(new Set(fixture.picks.map(cell => `${cell.x},${cell.y}`)).size, fixture.picks.length);
      for (const pick of fixture.picks) assert(!walls.has(`${pick.x},${pick.y}`));
    }
    // Candidate evaluation traverses every training and withheld location with BFS.
    const next = advance(toPublicExperiment(state), { action: 'candidate', params: { name: 'Reachability check', heuristic: 'nearest' } });
    valid(next);
    assert.doesNotMatch(JSON.stringify(next), /routing_holdout|withheld-[123]/);
    assert.throws(() => advance(next, { action: 'replay', params: { fixture_id: 'withheld-1' } }), /published training/);
  }
  const forged = seeded('invention-league');
  forged.world.fixtures[0].picks[0] = { x: 3, y: 1 };
  assert.equal(validateExperiment(forged).valid, false);
});

test('bounded company, city and life openings support their normal actions with no invented evidence', () => {
  const company = seeded('bicycle-company');
  const { world } = company;
  assert(world.cash_cents >= 90000 && world.cash_cents <= 150000);
  assert.equal(world.accounting.opening_equity_cents, world.cash_cents + world.accounting.opening_inventory_cents);
  assert.equal(world.accounting.revenue_cents, 0);
  valid(advance(company, { action: 'service', params: { order_id: 'order-0001' } }));
  const city = seeded('flood-city');
  assert.equal(city.world.total_unserved, 0);
  for (const district of city.world.districts) assert(district.water <= district.storage_cap && district.wear <= 3);
  valid(advance(city, { action: 'govern', params: { planner_action: 'clear', planner_district: 'canal',
    residents_action: 'relief', residents_district: 'marsh', spend_limit: 8, priority: 'infrastructure' } }));
  const life = seeded('life-research');
  assert.equal(life.world.experiments_tested, 0);
  assert.equal(life.world.verified_reproductions, 0);
  assert(life.world.cells.length >= 5 && life.world.cells.length <= 16);
  valid(advance(life, { action: 'experiment', params: { name: 'Test seeded opening', seed_cells: life.world.cells,
    steps: 16, hypothesis: { kind: 'unknown' } } }));
});

test('factory cycles implemented types, publishes goals/full initial observations and changes worlds each hourly cycle', () => {
  const existingExperiments = [];
  for (let sequence = 0; sequence < 10; sequence += 1) {
    const scheduledAt = new Date(Date.parse(createdAt) + sequence * 3600000 + 12345).toISOString();
    const before = copy(existingExperiments);
    const launch = createSeededCloudLaunch({ scheduledAt, sequence, existingExperiments });
    assert.deepEqual(launch, createSeededCloudLaunch({ scheduledAt, sequence, existingExperiments }));
    assert.deepEqual(existingExperiments, before);
    assert.equal(launch.type, CLOUD_SEEDED_TYPES[sequence % 5]);
    assert(Object.hasOwn(TYPE_CATALOG, launch.type));
    assert.equal(launch.experiment.created_at, scheduledAt);
    assert.equal(launch.at, scheduledAt);
    assert.equal(launch.experiment.id, launch.id);
    assert.equal(launch.experiment.goal, launch.goal);
    assert.deepEqual(launch.experiment.seed, launch.seed);
    assert.equal(launch.campaign_turn_limit, 12);
    assert.equal(launch.experiment.campaign_turn_limit, 12);
    assert.equal(launch.initial_observation.campaign_turn_limit, 12);
    assert.match(launch.goal, /12-decision campaign/);
    assert.deepEqual(launch.initial_observation, toPublicExperiment(launch.experiment));
    assert.match(launch.reason, /existing implemented type/);
    assert.match(launch.state_hash, /^fnv128:[a-f0-9]{32}$/);
    assert.doesNotMatch(JSON.stringify(launch.initial_observation), /_private|language_oracle|withheld_sentences|routing_holdout/);
    for (const prior of existingExperiments) if (prior.type === launch.type) assert.notDeepEqual(prior.world, launch.initial_observation.world);
    assert(!existingExperiments.some(prior => prior.id === launch.id));
    existingExperiments.push(launch.initial_observation);
  }
});

test('factory retries a colliding identity or visible opening without changing retained history', () => {
  const first = createSeededCloudLaunch({ scheduledAt: createdAt });
  const retained = [first.initial_observation];
  const before = copy(retained);
  const next = createSeededCloudLaunch({ scheduledAt: createdAt, existingExperiments: retained });
  assert.notEqual(first.id, next.id);
  assert.notDeepEqual(first.seed, next.seed);
  assert.notDeepEqual(first.initial_observation.world, next.initial_observation.world);
  assert.deepEqual(retained, before);
  assert.throws(() => createSeededCloudLaunch({ scheduledAt: 'invalid' }), /scheduledAt/);
  assert.throws(() => createSeededCloudLaunch({ scheduledAt: createdAt, sequence: -1 }), /sequence/);
});

test('an explicit 52-turn public checkpoint resumes identical consequences without rewriting history', () => {
  let full = seeded('alien-language');
  const probe = { action: 'probe', params: { subject: 'we', verb: 'find', object: 'water', tense: 'past' } };
  for (let turn = 0; turn < 52; turn += 1) full = advance(full, probe);
  const priorHistory = copy(full.timeline);
  const checkpoint = toPublicExperiment(full);
  checkpoint.timeline = checkpoint.timeline.slice(-12);
  checkpoint.timeline_start_turn = checkpoint.timeline[0].turn;
  assert.equal(checkpoint.timeline_start_turn, 41);
  valid(checkpoint);
  const nextFull = advance(full, probe);
  const nextCheckpoint = advance(checkpoint, probe);
  assert.deepEqual(full.timeline, priorHistory);
  assert.equal(nextCheckpoint.turn, 53);
  assert.equal(nextCheckpoint.timeline_start_turn, 41);
  assert.equal(nextCheckpoint.timeline.length, 13);
  assert.deepEqual(nextCheckpoint.timeline, toPublicExperiment(nextFull).timeline.slice(-13));
  for (const field of ['id', 'type', 'goal', 'seed', 'world', 'memory', 'metrics', 'status', 'updated_at']) {
    assert.deepEqual(nextCheckpoint[field], toPublicExperiment(nextFull)[field], field);
  }
  valid(nextCheckpoint);
  const missing = copy(checkpoint); delete missing.timeline_start_turn;
  assert.equal(validateExperiment(missing).valid, false);
  const mismatch = copy(checkpoint); mismatch.timeline_start_turn = 40;
  assert.equal(validateExperiment(mismatch).valid, false);
  const hole = copy(checkpoint); hole.timeline[4].turn += 1;
  assert.equal(validateExperiment(hole).valid, false);
  for (const offset of [null, 0, -1, 42.5, 53]) {
    const malformed = copy(checkpoint); malformed.timeline_start_turn = offset;
    assert.equal(validateExperiment(malformed).valid, false);
  }
  const empty = copy(checkpoint); empty.timeline = []; empty.timeline_start_turn = 53;
  assert.equal(validateExperiment(empty).valid, false);
  const zero = seeded('alien-language'); zero.timeline_start_turn = 1;
  valid(zero);
});
