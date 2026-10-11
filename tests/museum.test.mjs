import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, applyDecision, validateExperiment, TYPE_CATALOG, toPublicExperiment } from '../engine.mjs';
import { initializeMuseum, applyMuseumDecision, validateMuseumWorld, MUSEUM_ACTIONS, museumDisplay } from '../museum.mjs';

const base = { name: 'Canal tally vessel', year: 125, material: 'clay', technology: 'kiln-firing', form: 'vessel', purpose: 'recording',
  site: 'canal', layer: 'middle', motif_count: 6, inscription_marks: 3, evidence_id: 'survey-canal-middle' };
const propose = (params = {}) => ({ action: 'propose', params: { ...base, ...params }, reason: 'Test the declared fictional interpretation against retained evidence.' });
const initial = () => createExperiment({ id: 'museum-test', type: 'civilization-museum', createdAt: '2026-10-11T00:00:00.000Z' });
const tick = (world, decision) => applyDecision(world, decision, { now: new Date(Date.parse(world.updated_at) + 1000).toISOString() });
const canonicalRoundTrip = value => JSON.parse(JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const designFromSpecimen = specimen => {
  const { id, status, display, ...params } = specimen;
  return params;
};

test('museum begins with exactly three fictional premises, no fabricated activity and publicly bounded actions', () => {
  const e = initial();
  assert.equal(e.world.civilization.facts.length, 3);
  assert.ok(e.world.civilization.facts.every(f => f.scope === 'fictional premise'));
  assert.equal(e.turn, 0);
  assert.equal(e.world.accepted_proposals, 0);
  assert.deepEqual(e.world.artifacts, []);
  assert.deepEqual(e.world.records, []);
  assert.equal(e.world.evidence.length, 3);
  assert.deepEqual(e.allowed_actions, MUSEUM_ACTIONS);
  assert.deepEqual(TYPE_CATALOG['civilization-museum'].allowed_actions.map(a => a.action), ['propose', 'excavate', 'revise']);
  assert.ok(validateExperiment(e).valid);
  assert.throws(() => createExperiment({ id: 'museum-seed', type: 'civilization-museum', seed: { version: 1, value: 'ignored' } }), /does not support seeded/);
});

test('a consistent object creates measured acceptance and actual deterministic SVG data atomically', () => {
  const e = initial(), prior = structuredClone(e);
  const next = tick(e, propose());
  assert.deepEqual(e, prior);
  const trial = next.world.latest_record;
  assert.equal(trial.verdict.status, 'accepted');
  assert.equal(trial.verdict.checks.length, 10);
  assert.ok(trial.verdict.checks.every(c => c.passed));
  assert.equal(next.world.accepted_proposals, 1);
  assert.equal(next.world.rejected_proposals, 0);
  assert.equal(trial.artifact.display.motifs.length, 6);
  assert.equal(trial.artifact.display.marks.length, 3);
  assert.match(trial.artifact.display.base.d, /^M52/);
  assert.deepEqual(trial.artifact.display, museumDisplay(base));
  assert.match(next.timeline[0].consequence, /not external historical authenticity/);
  assert.deepEqual(toPublicExperiment(next).world, next.world);
});

test('anachronistic inscriptions are recorded rejections with independently recomputed failed checks', () => {
  const next = tick(initial(), propose({ year: 49, site: 'marsh', layer: 'lower', evidence_id: 'survey-marsh-lower' }));
  const trial = next.world.latest_record;
  assert.equal(trial.verdict.status, 'rejected');
  assert.deepEqual(trial.verdict.checks.filter(c => !c.passed).map(c => c.id), ['technology-date', 'script']);
  assert.equal(next.world.rejected_proposals, 1);
  assert.equal(next.world.artifacts.length, 0);
  assert.deepEqual(next.world.contradictions[0], trial);
  assert.ok(validateExperiment(next).valid);
  assert.equal(next.timeline.length, 1);
});

test('iron and mismatched context remain legitimate visible failed experiments', () => {
  const next = tick(initial(), propose({ material: 'iron', technology: 'iron-forging', form: 'tool', purpose: 'irrigation', year: 170,
    site: 'exchange', layer: 'upper' }));
  assert.equal(next.world.latest_record.verdict.status, 'rejected');
  const failures = next.world.latest_record.verdict.checks.filter(c => !c.passed).map(c => c.id);
  for (const id of ['resource', 'technology-date', 'script', 'evidence-context', 'evidence-date', 'evidence-material']) assert.ok(failures.includes(id));
  assert.ok(validateMuseumWorld(next.world).valid);
});

test('excavation generates a reproducible narrow dated specimen that supports only matching interpretations', () => {
  const a = applyMuseumDecision(initializeMuseum(), { action: 'excavate', params: { site: 'exchange', layer: 'upper' } });
  const b = applyMuseumDecision(initializeMuseum(), { action: 'excavate', params: { site: 'exchange', layer: 'upper' } });
  assert.deepEqual(a, b);
  assert.equal(a.world.excavations, 1);
  assert.equal(a.world.proposals_tested, 0);
  assert.equal(a.world.latest_record.verdict.status, 'excavated');
  const evidence = a.world.evidence.at(-1);
  assert.equal(evidence.materials.length, 1);
  assert.ok(evidence.end_year - evidence.start_year <= 10);
  const accepted = applyMuseumDecision(a.world, { action: 'propose', params: designFromSpecimen(evidence.specimen) });
  assert.equal(accepted.world.latest_record.verdict.status, 'accepted');
  const otherYear = evidence.end_year + 1 <= 239 ? evidence.end_year + 1 : evidence.start_year - 1;
  const rejected = applyMuseumDecision(a.world, { action: 'propose', params: { ...designFromSpecimen(evidence.specimen), year: otherYear } });
  assert.equal(rejected.world.latest_record.verdict.status, 'rejected');
  assert.equal(rejected.world.latest_record.verdict.checks.find(c => c.id === 'evidence-date').passed, false);
});

test('revision accepts a corrected interpretation while retaining the original rejection', () => {
  const bad = tick(initial(), propose({ year: 99 }));
  const next = tick(bad, { action: 'revise', params: { proposal_id: 'museum-1', ...base } });
  assert.equal(next.world.revisions, 1);
  assert.equal(next.world.accepted_proposals, 1);
  assert.equal(next.world.rejected_proposals, 1);
  assert.equal(next.world.latest_record.revision_of, 'museum-1');
  assert.equal(next.world.records[0].verdict.status, 'rejected');
  assert.deepEqual(next.world.contradictions[0], bad.world.latest_record);
  assert.ok(validateExperiment(next).valid);
  assert.throws(() => tick(next, { action: 'revise', params: { proposal_id: 'museum-404', ...base } }), /retained twelve-record/);
});

test('schema errors and nonexistent evidence throw without changing the supplied experiment', () => {
  const e = initial(), before = structuredClone(e);
  for (const decision of [propose({ motif_count: 13 }), propose({ inscription_marks: 1.5 }), propose({ arbitrary_svg: '<script />' }),
    propose({ evidence_id: 'unrecorded-source' }), propose({ material: 'gold' }), { action: 'excavate', params: { site: 'exchange', layer: 'future' } },
    { action: 'rest', params: {} }]) assert.throws(() => tick(e, decision));
  assert.deepEqual(e, before);
  assert.ok(validateExperiment(e).valid);
});

test('bounded museum memory reconciles retired records, accepted objects and excavations', () => {
  let world = initializeMuseum();
  for (let i = 0; i < 60; i++) world = applyMuseumDecision(world, propose({ name: `Consistent vessel ${i}` })).world;
  for (let i = 0; i < 15; i++) world = applyMuseumDecision(world, propose({ year: 99, name: `Rejected early writing ${i}` })).world;
  for (let i = 0; i < 30; i++) world = applyMuseumDecision(world, { action: 'excavate', params: { site: 'exchange', layer: 'upper' } }).world;
  assert.equal(world.decisions, 105);
  assert.equal(world.proposals_tested, 75);
  assert.equal(world.accepted_proposals, 60);
  assert.equal(world.rejected_proposals, 15);
  assert.equal(world.records.length, 12);
  assert.equal(world.artifacts.length, 48);
  assert.equal(world.archived_artifacts, 12);
  assert.equal(world.evidence.length, 24);
  assert.equal(world.archived_evidence, 9);
  assert.equal(world.contradictions.length, 12);
  assert.equal(world.agent_memory.last_results.length, 6);
  assert.equal(world.archived_records.decisions, 93);
  assert.ok(validateMuseumWorld(canonicalRoundTrip(world)).valid);
  assert.ok(world.artifacts.every(a => a.evidence_context.kind === 'survey'));
  const continuation = applyMuseumDecision(canonicalRoundTrip(world), { action: 'propose', params: designFromSpecimen(world.evidence.at(-1).specimen) });
  assert.equal(continuation.world.latest_record.verdict.status, 'accepted');
  assert.ok(validateMuseumWorld(continuation.world).valid);
});

test('R2 canonical key order and a twelve-event checkpoint remain a usable original experiment', () => {
  let e = initial();
  for (let i = 0; i < 17; i++) e = tick(e, i % 3 ? propose({ name: `Vessel ${i}` }) : propose({ year: 99 }));
  e.timeline = e.timeline.slice(-12);
  e.timeline_start_turn = e.turn - 11;
  e = canonicalRoundTrip(e);
  assert.ok(validateExperiment(e).valid, validateExperiment(e).errors.join('; '));
  const continued = tick(e, { action: 'excavate', params: { site: 'canal', layer: 'upper' } });
  assert.equal(continued.turn, 18);
  assert.equal(continued.id, e.id);
  assert.equal(continued.world.decisions, 18);
  assert.ok(validateExperiment(canonicalRoundTrip(continued)).valid);
  assert.equal(continued.world.latest_record.verdict.status, 'excavated');
});

test('validation detects forged curator verdicts, geometry, provenance, counters and timeline input', () => {
  const accepted = tick(initial(), propose());
  const rejected = tick(initial(), propose({ year: 99 }));
  const mutations = [
    e => { e.world.accepted_proposals++; },
    e => { e.world.artifacts[0].year = 49; },
    e => { e.world.artifacts[0].display.marks[0].x1 = 10000; },
    e => { e.world.artifacts[0].evidence_context.start_year = 0; },
    e => { e.world.latest_record.verdict.checks[0].passed = false; },
    e => { e.world.civilization.facts[0].scope = 'verified historical fact'; },
    e => { e.world.decisions++; },
    e => { e.timeline[0].decision.params.year = 49; },
    e => { e.allowed_actions[0].params.year.max = 1000000; },
  ];
  for (const mutate of mutations) { const forged = structuredClone(accepted); mutate(forged); assert.equal(validateExperiment(forged).valid, false); }
  const forgedRejected = structuredClone(rejected);
  forgedRejected.world.contradictions[0].verdict.checks.find(c => c.id === 'script').passed = true;
  assert.equal(validateExperiment(forgedRejected).valid, false);
});
