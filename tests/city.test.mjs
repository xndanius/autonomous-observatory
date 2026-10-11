import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, applyDecision, forecastCityTurn, validateExperiment, summarizeExperiment, toPublicExperiment } from '../engine.mjs';

const createdAt = '2026-10-11T10:00:00.000Z';
const create = () => createExperiment({ id: 'city-test', type: 'flood-city', createdAt });
const copy = value => JSON.parse(JSON.stringify(value));
const ids = ['hill', 'canal', 'marsh'];
const initialParams = { planner_action: 'clear', planner_district: 'canal', residents_action: 'relief', residents_district: 'marsh', spend_limit: 8, priority: 'infrastructure' };
const hold = { planner_action: 'hold', planner_district: 'none', residents_action: 'hold', residents_district: 'none', spend_limit: 0, priority: 'infrastructure' };
const advance = (state, params) => applyDecision(state, { action: 'govern', params, reason: 'Decide from the public forcing, treasury and district state.' }, { now: new Date(Date.parse(createdAt) + (state.turn + 1) * 60000).toISOString() });
const valid = state => assert.deepEqual(validateExperiment(state), { valid: true, errors: [] });

test('zero-history seed and initial council action yield exact water, household and treasury consequences', () => {
  const before = create();
  assert.equal(before.world.total_unserved, 0);
  assert.deepEqual(before.world.districts.map(district => district.cumulative_unserved), [0, 0, 0]);
  assert.equal(before.world.forcing_turn, 0);
  assert.equal(before.world.next_forcing.rain, 4);
  const bytes = JSON.stringify(before);
  const after = advance(before, initialParams);
  assert.equal(JSON.stringify(before), bytes);
  const receipt = after.world.latest_receipt;
  assert.deepEqual(receipt.districts.map(district => district.water_after), [3, 2, 6]);
  assert.deepEqual(receipt.districts.map(district => district.drained), [1, 3, 0]);
  assert.deepEqual(receipt.districts.map(district => district.flood_units), [1, 0, 5]);
  assert.deepEqual(receipt.districts.map(district => district.exposed), [6, 0, 8]);
  assert.deepEqual(receipt.districts.map(district => district.protected), [0, 0, 4]);
  assert.deepEqual(receipt.districts.map(district => district.unserved), [6, 0, 4]);
  assert.deepEqual(after.world.districts.map(district => district.wear), [2, 1, 3]);
  assert.equal(receipt.total_unserved, 10);
  assert.equal(after.world.equity_gap, 50);
  assert.deepEqual(receipt.budget, { before: 12, limit: 8, spent: 5, income: 4, clipped_income: 0, after: 11 });
  assert.deepEqual(receipt.water_balance, { before: 3, rain_added: 12, drained: 4, after: 11, river_outflow: 0, difference: 0 });
  assert.deepEqual(forecastCityTurn(before.world, initialParams), after.world);
  assert.equal(after.timeline[0].evidence.find(entry => entry.label === 'Water balance difference').value, 0);
  assert.equal(after.timeline[0].snapshot.metrics.find(entry => entry.label === 'Treasury').value, 11);
  assert.equal(Object.hasOwn(after.timeline[0].snapshot.world, 'receipts'), false);
  valid(after); valid(toPublicExperiment(after));
});

test('initial council choice minimizes immediate harm, then equity, then spending among all 168 choices', () => {
  const seed = create().world;
  const projects = [['hold', 'none'], ...['clear', 'expand'].flatMap(action => ids.map(id => [action, id]))];
  const reliefs = [['hold', 'none'], ...ids.map(id => ['relief', id])];
  const scores = [];
  for (const [planner_action, planner_district] of projects) for (const [residents_action, residents_district] of reliefs) for (const spend_limit of [0, 4, 8]) for (const priority of ['infrastructure', 'relief']) {
    const result = forecastCityTurn(seed, { planner_action, planner_district, residents_action, residents_district, spend_limit, priority });
    scores.push([result.latest_receipt.total_unserved, result.equity_gap, result.latest_receipt.budget.spent]);
  }
  scores.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  assert.equal(scores.length, 168);
  assert.deepEqual(scores[0], [10, 50, 5]);
  assert.equal(forecastCityTurn(seed, { ...initialParams, planner_district: 'hill' }).equity_gap, 60);
  assert.equal(forecastCityTurn(seed, { ...initialParams, planner_action: 'hold', planner_district: 'none' }).latest_receipt.total_unserved, 16);
});

test('auditor priority changes which full request fits and relief uses actual exposed households', () => {
  const seed = create().world;
  const worksFirst = forecastCityTurn(seed, { ...initialParams, spend_limit: 4 });
  const reliefFirst = forecastCityTurn(seed, { ...initialParams, spend_limit: 4, priority: 'relief' });
  assert.deepEqual(worksFirst.latest_receipt.requests.map(request => request.status), ['funded', 'declined']);
  assert.deepEqual(reliefFirst.latest_receipt.requests.map(request => request.status), ['funded', 'declined']);
  assert.equal(worksFirst.latest_receipt.requests[0].kind, 'infrastructure');
  assert.equal(reliefFirst.latest_receipt.requests[0].kind, 'relief');
  assert.equal(worksFirst.latest_receipt.total_unserved, 14);
  assert.equal(reliefFirst.latest_receipt.total_unserved, 16);
  assert.equal(worksFirst.latest_receipt.budget.spent, 3);
  assert.equal(reliefFirst.latest_receipt.budget.spent, 2);
  const dryRelief = forecastCityTurn(seed, { ...initialParams, residents_district: 'canal' });
  assert.equal(dryRelief.latest_receipt.total_protected, 0);
  assert.equal(dryRelief.latest_receipt.budget.spent, 5);
});

test('80 varied turns conserve water, reconcile civic credits, retain exact histories and bounded memory', () => {
  let state = create();
  for (let i = 0; i < 80; i += 1) {
    const planner_action = ['hold', 'clear', 'expand', 'clear'][i % 4];
    const residents_action = i % 2 ? 'relief' : 'hold';
    const priorEvents = copy(state.timeline);
    state = advance(state, { planner_action, planner_district: planner_action === 'hold' ? 'none' : ids[i % 3], residents_action,
      residents_district: residents_action === 'hold' ? 'none' : ids[(i + 1) % 3], spend_limit: [0, 4, 8][i % 3], priority: i % 2 ? 'relief' : 'infrastructure' });
    const { world } = state; const receipt = world.latest_receipt;
    assert.equal(receipt.water_balance.difference, 0);
    assert.equal(receipt.water_balance.before + receipt.water_balance.rain_added, receipt.water_balance.drained + receipt.water_balance.after + receipt.water_balance.river_outflow);
    assert.equal(world.budget, 12 + world.cumulative_income - world.cumulative_spent - world.cumulative_clipped_income);
    assert.equal(receipt.budget.after, receipt.budget.before - receipt.budget.spent + 4 - receipt.budget.clipped_income);
    assert.equal(world.total_unserved, world.districts.reduce((total, district) => total + district.cumulative_unserved, 0));
    assert.equal(world.total_unserved, state.timeline.reduce((total, event) => total + event.snapshot.latest_receipt.total_unserved, 0));
    assert.deepEqual(state.timeline.slice(0, -1), priorEvents);
    valid(state);
  }
  assert.equal(state.status, 'active');
  assert.equal(state.world.forcing_turn, 80);
  assert.equal(state.world.cumulative_income, 320);
  assert.equal(state.world.receipts.length, 12);
  assert.equal(state.world.receipts[0].turn, 69);
  assert.equal(state.memory.observations.length, 12);
  assert.equal(state.world.agent_memory.planner.turn, 80);
  assert.equal(summarizeExperiment(state).snapshot.metrics.length > 0, true);
});

test('malformed joint decisions and invalid overrides are atomic, including pure forecast input', () => {
  const seed = create(); const bytes = JSON.stringify(seed); const paramsBytes = JSON.stringify(initialParams);
  for (const delta of [
    { planner_action: 'invent' }, { planner_district: 'none' }, { residents_action: 'hold' }, { residents_district: 'unknown' },
    { spend_limit: '8' }, { spend_limit: 3 }, { priority: 'secret' }, { extra_rain: 7 }, { extra_rain: 0.5 },
    { debris_district: 'moon' }, { extra_rain: null }, { debris_district: null }, { unknown_parameter: true },
  ]) { assert.throws(() => advance(seed, { ...initialParams, ...delta })); assert.throws(() => forecastCityTurn(seed.world, { ...initialParams, ...delta })); }
  for (const options of [{ extraRain: -1 }, { extraRain: 7 }, { extraRain: 1.2 }, { extraRain: null }, { debrisDistrict: 'moon' }, { unknown: true }]) assert.throws(() => forecastCityTurn(seed.world, initialParams, options));
  forecastCityTurn(seed.world, initialParams, { extraRain: 6, debrisDistrict: 'marsh' });
  assert.equal(JSON.stringify(seed), bytes);
  assert.equal(JSON.stringify(initialParams), paramsBytes);
  const forged = copy(seed); forged.world.budget += 1;
  assert.equal(validateExperiment(forged).valid, false);
  assert.throws(() => forecastCityTurn(forged.world, initialParams), /treasury/);
});

test('expansion adds persistent drain capacity, wear erodes it, and upgrade cap declines without spending', () => {
  const params = { ...hold, planner_action: 'expand', planner_district: 'canal', spend_limit: 8 };
  const first = forecastCityTurn(create().world, params);
  assert.equal(first.districts[1].upgrades, 1);
  assert.equal(first.latest_receipt.districts[1].drain_capacity, 3);
  const worn = forecastCityTurn(first, hold);
  assert.equal(worn.latest_receipt.districts[1].drain_capacity, 2);
  const cleared = forecastCityTurn(first, { ...params, planner_action: 'clear' });
  assert.equal(cleared.latest_receipt.districts[1].drain_capacity, 5);
  assert.equal(cleared.districts[1].wear, 1);
  let upgraded = first;
  upgraded = forecastCityTurn(upgraded, params);
  upgraded = forecastCityTurn(upgraded, params);
  assert.equal(upgraded.districts[1].upgrades, 3);
  const capped = forecastCityTurn(upgraded, params);
  assert.equal(capped.latest_receipt.requests[0].status, 'declined');
  assert.equal(capped.latest_receipt.requests[0].reason, 'Upgrade cap reached.');
  assert.equal(capped.latest_receipt.budget.spent, 0);
});

test('overlapping announced crises and bounded branch overrides stack explicitly without changing public state', () => {
  let state = create();
  for (let i = 0; i < 39; i += 1) state = advance(state, hold);
  assert.equal(state.world.next_forcing.turn, 40);
  assert.equal(state.world.next_forcing.rain, 10);
  assert.equal(state.world.next_forcing.debris_district, 'canal');
  const bytes = JSON.stringify(state);
  const branch = forecastCityTurn(state.world, { ...hold, extra_rain: 6, debris_district: 'canal' });
  assert.equal(branch.latest_receipt.forcing.rain, 16);
  assert.equal(branch.latest_receipt.forcing.debris_penalties.canal, 6);
  assert.equal(branch.latest_receipt.forcing.crises.length, 4);
  assert.equal(branch.latest_receipt.water_balance.difference, 0);
  assert.equal(JSON.stringify(state), bytes);
  assert.equal(branch.next_forcing.rain, 2);
  assert.equal(branch.next_forcing.overrides.extra_rain, 0);
  const branchExperiment = create(); branchExperiment.world = copy(state.world);
  valid(branchExperiment); // timeline turn 0; copied forcing turn 39
  const advancedBranch = advance(branchExperiment, { ...hold, extra_rain: 6, debris_district: 'canal' });
  valid(advancedBranch);
  assert.equal(advancedBranch.turn, 1);
  assert.equal(advancedBranch.world.forcing_turn, 40);
  assert.equal(advancedBranch.timeline[0].evidence.find(entry => entry.label === 'Explicit extra rain').value, 6);
  assert.match(advancedBranch.timeline[0].observation, /Explicit simulation input/);
  assert.deepEqual(advancedBranch.world, branch);
});
