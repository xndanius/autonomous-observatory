import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, applyDecision, validateExperiment, toPublicExperiment, summarizeExperiment, TYPE_CATALOG } from '../engine.mjs';

const createdAt = '2026-10-11T10:00:00.000Z';
const at = turn => new Date(Date.parse(createdAt) + turn * 60000).toISOString();
const create = type => createExperiment({ id: 'test-world', type, createdAt });
const advance = (state, decision) => applyDecision(state, decision, { now: at(state.turn + 1) });
const jsonCopy = state => JSON.parse(JSON.stringify(state));

function assertValid(state) {
  assert.deepEqual(validateExperiment(state), { valid: true, errors: [] });
}

test('every environment initializes valid serializable state and has bounded action schemas', () => {
  for (const type of Object.keys(TYPE_CATALOG)) {
    const state = create(type);
    assertValid(state);
    assertValid(jsonCopy(state));
    assertValid(toPublicExperiment(state));
    assert.equal(state.turn, 0);
    assert.deepEqual(state.timeline, []);
    assert(state.allowed_actions.every(action => typeof action.action === 'string' && typeof action.params === 'object'));
  }
});

test('three real repairs reconcile cash, inventory, revenue and expenses exactly', () => {
  const before = create('bicycle-company');
  const after = advance(before, { action: 'service', params: { order_ids: ['order-0001', 'order-0002', 'order-0003'] },
    action_author: 'Codex', reason: 'Clear quoted orders while the required parts are in stock.' });
  assert.equal(before.world.cash_cents, 120000);
  assert.equal(before.timeline.length, 0);
  assert.equal(after.world.cash_cents, 133400); // €170 receipts - €24 labor - €12 overhead
  assert.equal(after.world.accounting.revenue_cents, 17000);
  assert.equal(after.world.accounting.expense_cents, 9200); // €56 stock + €24 labor + €12 overhead
  assert.deepEqual(Object.fromEntries(Object.entries(after.world.inventory).map(([part, stock]) => [part, stock.quantity])), { tube: 5, chain: 2, brake: 3 });
  assert.equal(after.timeline[0].snapshot.profit, 78);
  assert.equal(after.timeline[0].action_author, 'Codex');
  assert.equal(after.timeline[0].evidence.find(entry => entry.label === 'Accounting difference').value, 0);
  assertValid(after);
});

test('invalid actions are atomic, including an invalid batch after a valid order', () => {
  const state = create('bicycle-company');
  const bytes = JSON.stringify(state);
  for (const decision of [
    { action: 'service', params: { order_ids: ['order-0001', 'missing'] } },
    { action: 'service', params: { order_ids: ['order-0001', 'order-0001'] } },
    { action: 'purchase', params: { part: 'chain', quantity: 100 } },
    { action: 'purchase', params: { part: 'chain', quantity: 0.5 } },
    { action: 'price', params: { service: 'puncture', price: 35.555 } },
    { action: 'price', params: { service: 'puncture', price: 35, invented_param: true } },
    { action: 'invent-profit', params: {} },
  ]) assert.throws(() => advance(state, decision));
  assert.equal(JSON.stringify(state), bytes);
});

test('supplier shock occurs on actual turn four, and purchases use weighted book cost', () => {
  let state = create('bicycle-company');
  for (let i = 0; i < 4; i += 1) state = advance(state, { action: 'rest' });
  assert.equal(state.world.supplier.multiplier, 2);
  assert.equal(state.world.supplier.prices_cents.chain, 5600);
  const bought = advance(state, { action: 'purchase', params: { part: 'chain', quantity: 2 } });
  assert.equal(bought.world.cash_cents, state.world.cash_cents - 11200 - 1200);
  assert.equal(bought.world.inventory.chain.quantity, 5);
  assert.equal(bought.world.inventory.chain.book_value_cents, 19600);
  assert.equal(bought.world.expired_orders >= 3, true); // initial orders reach their deadlines
  assertValid(bought);
});

test('price changes cannot alter existing customer quotes and demand is deterministic', () => {
  const initial = create('bicycle-company');
  const decision = { action: 'price', params: { service: 'puncture', price: 110 } };
  const a = advance(initial, decision);
  const b = advance(jsonCopy(initial), decision);
  assert.deepEqual(a, b);
  assert.equal(a.world.orders.find(order => order.id === 'order-0001').quoted_price_cents, 4000);
  assert.equal(a.world.prices_cents.puncture, 11000);
  assertValid(a);
});

test('decision IDs prevent duplicate turns while rejecting ID collisions', () => {
  const initial = create('bicycle-company');
  const decision = { action: 'service', params: { order_id: 'order-0001' }, decision_id: 'job-1' };
  const first = advance(initial, decision);
  const duplicate = applyDecision(first, decision, { now: at(20) });
  assert.deepEqual(first, duplicate);
  assert.notEqual(first, duplicate);
  assert.throws(() => advance(first, { action: 'rest', decision_id: 'job-1' }), /different action/);
  assert.equal(first.turn, 1);
  assert.equal(Object.hasOwn(first.timeline[0], 'action_author'), false);
});

test('persisted events replay deterministically and preserve every earlier timeline entry', () => {
  const initial = create('bicycle-company');
  let state = initial;
  const decisions = [
    { action: 'service', params: { order_id: 'order-0001' }, reason: 'Repair puncture.' },
    { action: 'service', params: { order_ids: ['order-0002', 'order-0003'] }, action_author: 'Codex' },
    { action: 'purchase', params: { part: 'tube', quantity: 4 } },
    { action: 'rest' },
    { action: 'price', params: { service: 'chain', price: 95 } },
  ];
  for (const decision of decisions) {
    const priorEvents = jsonCopy(state.timeline);
    state = advance(jsonCopy(state), decision);
    assert.deepEqual(state.timeline.slice(0, -1), priorEvents);
    assertValid(state);
  }
  let replay = initial;
  for (const event of state.timeline) replay = applyDecision(replay, { ...event.decision, reason: event.reason, alternatives: event.alternatives,
    actor: event.actor, ...(event.action_author ? { action_author: event.action_author } : {}) }, { now: event.at });
  assert.deepEqual(replay, state);
  assert.equal(summarizeExperiment(state).turn, 5);
  assert.throws(() => applyDecision(state, { action: 'rest' }, { now: createdAt }), /cannot precede/);
});

test('long running company remains auditable while compacting its working memory and ledger', () => {
  let state = create('bicycle-company');
  for (let turn = 1; turn <= 75; turn += 1) {
    const repairable = state.world.orders.filter(order => order.status === 'waiting' && state.world.inventory[Object.keys(order.parts)[0]].quantity > 0).slice(0, 1);
    const empty = Object.entries(state.world.inventory).find(([, stock]) => stock.quantity < 2);
    const decision = repairable.length ? { action: 'service', params: { order_id: repairable[0].id } }
      : empty ? { action: 'purchase', params: { part: empty[0], quantity: 6 } } : { action: 'rest' };
    state = advance(state, decision);
    assertValid(state);
  }
  assert.equal(state.status, 'active');
  assert.equal(state.timeline.length, 75);
  assert.equal(state.memory.observations.length, 64);
  assert.equal(state.memory.observations[0].turn, 12);
  assert(state.world.accounting.ledger.length <= 120);
  assert(state.world.accounting.archived_ledger.entries > 0);
  assert(state.world.orders.filter(order => order.status !== 'waiting').length <= 48);
});

test('language probes reveal only selected examples and public snapshots omit answer sheets', () => {
  const initial = create('alien-language');
  const publicInitial = toPublicExperiment(initial);
  assert.equal(Object.hasOwn(publicInitial, '_private'), false);
  assert.equal(JSON.stringify(publicInitial).includes('language_oracle'), false);
  assert.equal(JSON.stringify(publicInitial).includes('withheld_sentences'), false);
  const decision = { action: 'probe', params: { subject: 'we', verb: 'find', object: 'water', tense: 'past' } };
  const privateNext = advance(initial, decision);
  const publicNext = advance(publicInitial, decision);
  assert.deepEqual(toPublicExperiment(privateNext), publicNext);
  assert.equal(privateNext.world.examples.length, 3);
  assert.equal(privateNext.world.examples.at(-1).kind, 'probe');
  assert.equal(privateNext.timeline[0].evidence.length, 1);
  assert.equal(JSON.stringify(toPublicExperiment(privateNext)).includes('language_oracle'), false);
  assertValid(publicNext);
});

test('an incorrect grammar proposal fails, confidence falls, and a corrected full system translates withheld sentences', () => {
  let state = create('alien-language');
  const oracle = state._private.language_oracle;
  const wrong = oracle.word_order === 'SOV' ? 'SVO' : 'SOV';
  state = advance(state, { action: 'hypothesize', params: { rule: 'word-order', answer: wrong } });
  state = advance(state, { action: 'validate', params: { rule: 'word-order' } });
  assert.equal(state.world.latest_validation.checks_passed, 0);
  assert(state.world.hypotheses[0].confidence < 0.25);
  const confidence = state.world.hypotheses[0].confidence;
  state = advance(state, { action: 'validate', params: { rule: 'word-order' } });
  assert.equal(state.world.hypotheses[0].confidence, confidence, 'Repeating a fixed batch cannot manufacture new evidence.');
  const answers = { 'word-order': oracle.word_order, 'past-marker': oracle.past_marker,
    ...Object.fromEntries(Object.entries(oracle.lexicon).map(([word, token]) => [`lexicon:${word}`, token])) };
  for (const [rule, answer] of Object.entries(answers)) state = advance(state, { action: 'hypothesize', params: { rule, answer } });
  state = advance(state, { action: 'validate' });
  assert.equal(state.world.translation_accuracy, 1);
  assert.equal(state.world.latest_validation.sentences_correct, 9);
  assert.equal(state.world.latest_validation.counterexample, null);
  assert(state.world.hypotheses.every(hypothesis => hypothesis.confidence > 0.5));
  assertValid(toPublicExperiment(state));
});

test('routing scores come from actual obstacle respecting replay paths and genuine promotion', () => {
  const initial = create('invention-league');
  assert.equal(initial.world.champion.training_steps, 210);
  assert.equal(initial.world.champion.unseen_steps, 154);
  const next = advance(initial, { action: 'candidate', params: { name: 'Nearest pick', heuristic: 'nearest' } });
  assert.equal(next.world.candidates[0].training_steps, 200);
  assert.equal(next.world.candidates[0].unseen_steps, 152);
  assert.equal(next.world.candidates[0].promoted, true);
  assert.equal(next.world.champion.name, 'Nearest pick');
  assert.equal(next.world.promotions, 1);
  const replay = next.world.replay;
  const walls = new Set(next.world.challenge.walls.map(cell => `${cell.x},${cell.y}`));
  assert.equal(replay.steps, replay.path.length - 1);
  assert.deepEqual(replay.path[0], next.world.challenge.depot);
  assert.deepEqual(replay.path.at(-1), next.world.challenge.depot);
  for (let i = 1; i < replay.path.length; i += 1) {
    assert(!walls.has(`${replay.path[i].x},${replay.path[i].y}`));
    assert.equal(Math.abs(replay.path[i].x - replay.path[i - 1].x) + Math.abs(replay.path[i].y - replay.path[i - 1].y), 1);
  }
  const rejected = advance(next, { action: 'candidate', params: { name: 'Same nearest', heuristic: 'nearest' } });
  assert.equal(rejected.world.candidates[1].promoted, false);
  assert.equal(rejected.world.champion.adopted_turn, 1);
  assert.equal(JSON.stringify(toPublicExperiment(rejected)).includes('routing_holdout'), false);
  const replay2 = advance(rejected, { action: 'replay', params: { fixture_id: 'training-2' } });
  assert.equal(replay2.world.replay.fixture_id, 'training-2');
  assert.throws(() => advance(replay2, { action: 'replay', params: { fixture_id: 'withheld-1' } }), /published training/);
  assertValid(replay2);
});

test('validation catches forged cash and teleported paths without throwing on malformed input', () => {
  const company = create('bicycle-company');
  company.world.cash_cents += 10000;
  assert.equal(validateExperiment(company).valid, false);
  const league = create('invention-league');
  league.world.replay.path[1] = { x: 11, y: 8 };
  assert.equal(validateExperiment(league).valid, false);
  assert.equal(validateExperiment(null).valid, false);
  assert.equal(validateExperiment({}).valid, false);
});
