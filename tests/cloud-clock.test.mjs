import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  CLOCK_REPOSITORY, CLOCK_STATE_PATH, initialClockState, readClockState, cloudClockStatus,
  clockRunUrl, clockReceiptPath, claimClock, tickClock, verifyClockChild, dispatchWorkflow,
} from '../scripts/cloud-clock.mjs';

const claimedAt = new Date('2026-10-11T15:00:00Z');
const tickedAt = new Date('2026-10-11T15:15:00Z');
const ownerEnv = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: CLOCK_REPOSITORY,
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: 'xndanius', GITHUB_TRIGGERING_ACTOR: 'xndanius',
  CLOCK_COMMAND: 'start', CLOCK_CHAIN_ID: '', CLOCK_PARENT_RUN_ID: '', CLOCK_PARENT_RUN_ATTEMPT: '', CLOCK_GENERATION: '' };
const run = (id, extra = {}) => ({ id: Number(id), run_attempt: 1,
  repository: { full_name: CLOCK_REPOSITORY }, head_repository: { full_name: CLOCK_REPOSITORY },
  head_branch: 'main', path: '.github/workflows/clock.yml', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', ...extra });
const response = id => ({ workflow_run_id: id, html_url: clockRunUrl(id),
  run_url: `https://api.github.com/repos/${CLOCK_REPOSITORY}/actions/runs/${id}` });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observatory-cloud-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveState(root, initialClockState());
  return root;
}
async function saveState(root, state) {
  await mkdir(path.join(root, 'data/cloud-clock'), { recursive: true });
  await writeFile(path.join(root, CLOCK_STATE_PATH), JSON.stringify(state));
}
async function start(root, extra = {}) {
  return claimClock({ root, env: ownerEnv, now: claimedAt, commit: async () => {}, ...extra });
}
async function successfulTick(root, extra = {}) {
  let nextId = 200;
  return tickClock({ root, env: ownerEnv, now: tickedAt, commit: async () => {},
    api: async () => response(nextId++), ...extra });
}
const childClaimEnv = { ...ownerEnv, GITHUB_RUN_ID: '201', GITHUB_ACTOR: 'github-actions[bot]',
  GITHUB_TRIGGERING_ACTOR: 'github-actions[bot]', CLOCK_COMMAND: 'continue',
  CLOCK_CHAIN_ID: 'clock-100-1', CLOCK_PARENT_RUN_ID: '100', CLOCK_PARENT_RUN_ATTEMPT: '1', CLOCK_GENERATION: '1' };
const decisionEnv = { ...childClaimEnv, GITHUB_RUN_ID: '200', SOURCE_CLOCK_RUN_ID: '100',
  SOURCE_CLOCK_RUN_ATTEMPT: '1', SOURCE_CLOCK_CHAIN_ID: 'clock-100-1', SOURCE_CLOCK_GENERATION: '0' };

test('repository starts paused and only an explicit first-attempt owner start arms it', async t => {
  const root = await fixture(t);
  assert.equal((await readClockState(root)).armed, false);
  for (const change of [{ GITHUB_ACTOR: 'github-actions[bot]' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
    { GITHUB_RUN_ATTEMPT: '2' }, { CLOCK_CHAIN_ID: 'fake' }, { GITHUB_REF: 'refs/heads/other' }]) {
    await assert.rejects(start(root, { env: { ...ownerEnv, ...change } }));
  }
  assert.equal((await start(root)).claimed, 'true');
  const state = await readClockState(root);
  assert.equal(state.phase, 'waiting'); assert.equal(state.chainId, 'clock-100-1');
  assert.equal(state.nextTickAt, tickedAt.toISOString());
});

test('double starts and replayed claims cannot replace an armed singleton', async t => {
  const root = await fixture(t); await start(root);
  const state = await readFile(path.join(root, CLOCK_STATE_PATH), 'utf8');
  let commits = 0;
  assert.equal((await start(root, { env: { ...ownerEnv, GITHUB_RUN_ID: '101' }, commit: async () => commits++ })).claimed, 'false');
  assert.equal((await start(root, { commit: async () => commits++ })).claimed, 'false');
  assert.equal(commits, 0); assert.equal(await readFile(path.join(root, CLOCK_STATE_PATH), 'utf8'), state);
});

test('a tick requires the exact claim and full environment wait', async t => {
  const root = await fixture(t); await start(root);
  const never = async () => assert.fail('No dispatch is allowed before the exact timer claim.');
  await assert.rejects(successfulTick(root, { now: new Date('2026-10-11T15:14:59Z'), api: never }), /wait/);
  assert.equal((await successfulTick(root, { env: { ...ownerEnv, GITHUB_RUN_ID: '999' }, api: never })).ticked, 'false');
  assert.equal((await successfulTick(root, { env: { ...ownerEnv, GITHUB_RUN_ATTEMPT: '2' }, api: never })).ticked, 'false');
});

test('successful tick checkpoints before requests and records exact decision and successor once', async t => {
  const root = await fixture(t); await start(root);
  const events = []; let id = 200;
  const result = await successfulTick(root, { commit: async ({ message }) => events.push(message),
    api: async (endpoint, options) => {
      assert.equal((await readClockState(root)).phase, 'ticking');
      assert.ok(events[0].includes('checkpoint'));
      events.push(endpoint); assert.equal(options.body.ref, 'main');
      if (endpoint.includes('/tick.yml/')) assert.deepEqual(options.body.inputs, {
        source_clock_run_id: '100', source_clock_run_attempt: '1', source_clock_chain_id: 'clock-100-1', source_clock_generation: '0' });
      else assert.deepEqual(options.body.inputs, { command: 'continue', chain_id: 'clock-100-1', parent_run_id: '100', parent_run_attempt: '1', generation: '1' });
      return response(id++);
    } });
  assert.equal(result.ticked, 'true'); assert.equal(result.decision_run_id, '200'); assert.equal(result.child_run_id, '201');
  assert.equal(events.length, 4);
  const state = await readClockState(root), receipt = JSON.parse(await readFile(path.join(root, clockReceiptPath('100')), 'utf8'));
  assert.equal(state.phase, 'queued'); assert.equal(state.expectedRunId, '201'); assert.equal(state.generation, 1);
  assert.equal(receipt.child.runId, '201'); assert.equal(receipt.dispatches[0].runId, '200');
  assert.equal(cloudClockStatus(state).lastDecisionRunUrl, clockRunUrl('200'));
  assert.equal((await successfulTick(root, { api: async () => assert.fail('Recorded tick must not repeat any dispatch.') })).ticked, 'false');
});

test('successor claim validates chain, generation, exact immutable receipt and successful parent metadata', async t => {
  const root = await fixture(t); await start(root); await successfulTick(root);
  const queued = await readClockState(root);
  for (const change of [{ CLOCK_CHAIN_ID: 'fake' }, { CLOCK_PARENT_RUN_ID: '99' },
    { CLOCK_PARENT_RUN_ATTEMPT: '2' }, { CLOCK_GENERATION: '2' }, { GITHUB_RUN_ID: '999' }, { GITHUB_RUN_ATTEMPT: '2' }]) {
    const result = await claimClock({ root, env: { ...childClaimEnv, ...change }, now: tickedAt,
      api: async () => assert.fail('Mismatched successor must fail before API access.'), commit: async () => assert.fail('No write.') });
    assert.equal(result.claimed, 'false');
  }
  for (const change of [{ head_branch: 'other' }, { run_attempt: 2 }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    await assert.rejects(claimClock({ root, env: childClaimEnv, now: tickedAt,
      api: async () => run('100', change), commit: async () => assert.fail('No write.') }), /parent/);
  }
  const file = path.join(root, clockReceiptPath('100')), receipt = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...receipt, child: { ...receipt.child, runId: '999' } }));
  await assert.rejects(claimClock({ root, env: childClaimEnv, now: tickedAt, api: async () => run('100'), commit: async () => {} }), /receipt/);
  await writeFile(file, JSON.stringify(receipt));
  assert.equal((await claimClock({ root, env: childClaimEnv, now: tickedAt, api: async () => run('100'), commit: async () => {} })).claimed, 'true');
  assert.equal((await claimClock({ root, env: childClaimEnv, now: tickedAt, api: async () => assert.fail('Replay does not query parent.'), commit: async () => assert.fail('Replay does not write.') })).claimed, 'false');
  assert.equal((await readClockState(root)).expectedRunId, queued.expectedRunId);
});

test('failed checkpoint persistence prevents the first external request', async t => {
  const root = await fixture(t); await start(root);
  await assert.rejects(successfulTick(root, { commit: async () => { throw Error('Push failed.'); }, api: async () => assert.fail('No dispatch before durable checkpoint.') }), /Push failed/);
  assert.equal((await successfulTick(root, { api: async () => assert.fail('Uncertain checkpoint must not repeat.') })).ticked, 'false');
});

test('a crash after returned dispatches leaves the durable checkpoint and cannot dispatch twice on a fresh run', async t => {
  const root = await fixture(t); await start(root);
  let checkpoint, commits = 0, requests = 0;
  await assert.rejects(successfulTick(root, {
    commit: async () => {
      commits++;
      if (commits === 1) checkpoint = await readClockState(root);
      else throw Error('Final push failed.');
    },
    api: async () => response(200 + requests++),
  }), /Final push failed/);
  assert.equal(requests, 2);
  // A new runner checks out only the checkpoint that reached main, not the
  // local receipt from the failed final push.
  await saveState(root, checkpoint);
  await rm(path.join(root, clockReceiptPath('100')));
  assert.equal((await successfulTick(root, { api: async () => assert.fail('A fresh run must not repeat dispatches.') })).reason, 'uncertain_tick_requires_owner_reset');
  assert.equal((await claimClock({ root, env: childClaimEnv, now: tickedAt,
    api: async () => assert.fail('Uncommitted successor has no authority.'), commit: async () => assert.fail('No write.') })).claimed, 'false');
});

test('uncertain dispatch stalls and requires owner reset; reruns never repeat the request', async t => {
  for (const failureAt of [1, 2]) {
    const root = await fixture(t); await start(root); let requests = 0;
    await assert.rejects(successfulTick(root, { api: async () => { requests++; if (requests === failureAt) return null; return response(200); } }), /owner reset/);
    const state = await readClockState(root); assert.equal(state.phase, 'stalled'); assert.equal(requests, failureAt);
    const receipt = JSON.parse(await readFile(path.join(root, clockReceiptPath('100')), 'utf8'));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.dispatches.length, failureAt - 1);
    assert.equal((await successfulTick(root, { api: async () => assert.fail('No repeat after an uncertain dispatch.') })).ticked, 'false');
    assert.equal((await start(root, { env: { ...ownerEnv, GITHUB_RUN_ID: '900' } })).claimed, 'false');
    await claimClock({ root, env: { ...ownerEnv, GITHUB_RUN_ID: '900', CLOCK_COMMAND: 'reset' }, now: tickedAt, commit: async () => {} });
    assert.equal((await readClockState(root)).armed, false);
    assert.equal((await start(root, { env: { ...ownerEnv, GITHUB_RUN_ID: '901' }, now: tickedAt })).claimed, 'true');
    assert.equal((await readClockState(root)).chainId, 'clock-901-1');
  }
});

test('explicit pause stops both a waiting tick and a queued successor before any dispatch', async t => {
  for (const afterTick of [false, true]) {
    const root = await fixture(t); await start(root); if (afterTick) await successfulTick(root);
    await claimClock({ root, env: { ...ownerEnv, GITHUB_RUN_ID: '900', CLOCK_COMMAND: 'pause' }, now: tickedAt, commit: async () => {} });
    assert.equal((await readClockState(root)).nextTickAt, null);
    assert.equal((await successfulTick(root, { api: async () => assert.fail('Paused clock cannot dispatch.') })).reason, 'clock_paused');
    assert.equal((await claimClock({ root, env: childClaimEnv, now: tickedAt, api: async () => assert.fail('Paused child cannot query parent.'), commit: async () => assert.fail('Paused child cannot write.') })).claimed, 'false');
  }
});

test('decision verification needs exact receipt, first-attempt bot identity and both authoritative runs', async t => {
  const root = await fixture(t); await start(root); await successfulTick(root);
  const api = async endpoint => endpoint.endsWith('/100') ? run('100', { status: 'in_progress', conclusion: null }) : run('200', {
    path: '.github/workflows/tick.yml', status: 'in_progress', actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'github-actions[bot]' } });
  const proof = await verifyClockChild({ root, env: decisionEnv, api });
  assert.equal(proof.verified, true); assert.equal(proof.runId, '200'); assert.equal(proof.generation, 0);
  assert.equal(await verifyClockChild({ root, env: ownerEnv, api: async () => assert.fail('Manual runs gain no clock authority.') }), null);
  for (const change of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_ACTOR: 'xndanius' }, { GITHUB_TRIGGERING_ACTOR: 'xndanius' },
    { SOURCE_CLOCK_RUN_ID: '99' }, { SOURCE_CLOCK_CHAIN_ID: 'fake' }, { SOURCE_CLOCK_GENERATION: '1' }, { GITHUB_RUN_ID: '999' }]) {
    await assert.rejects(verifyClockChild({ root, env: { ...decisionEnv, ...change }, api }));
  }
  await assert.rejects(verifyClockChild({ root, env: decisionEnv, api: async endpoint => endpoint.endsWith('/100') ? run('100', { head_branch: 'other' }) : api(endpoint) }), /parent/);
  await assert.rejects(verifyClockChild({ root, env: decisionEnv, api: async endpoint => endpoint.endsWith('/200') ? run('200', { path: '.github/workflows/tick.yml', actor: { login: 'xndanius' }, triggering_actor: { login: 'github-actions[bot]' } }) : api(endpoint) }), /child/);
});

test('API dispatch accepts exact current response only and cannot target another workflow', async () => {
  assert.equal((await dispatchWorkflow('tick.yml', {}, { api: async () => response(200) })).runId, '200');
  for (const wrong of [null, {}, { ...response(200), html_url: 'https://github.com/other/repo/actions/runs/200' },
    { ...response(200), run_url: 'https://api.github.com/repos/other/repo/actions/runs/200' }]) {
    await assert.rejects(dispatchWorkflow('tick.yml', {}, { api: async () => wrong }), /exact trusted run/);
  }
  await assert.rejects(dispatchWorkflow('other.yml', {}, { api: async () => assert.fail('Unknown workflow cannot dispatch.') }), /Unsupported/);
});

test('paused and superseded chains fence queued decisions while a healthy newer generation stays valid', async t => {
  const root = await fixture(t); await start(root); await successfulTick(root);
  const api = async endpoint => endpoint.endsWith('/100') ? run('100') : run('200', {
    path: '.github/workflows/tick.yml', status: 'in_progress', actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'github-actions[bot]' } });
  // Source generation zero remains valid when the live successor generation one
  // claims. Equal generations would incorrectly reject normal queued decisions.
  await claimClock({ root, env: childClaimEnv, now: tickedAt, api: async () => run('100'), commit: async () => {} });
  assert.equal((await verifyClockChild({ root, env: decisionEnv, api })).verified, true);
  await claimClock({ root, env: { ...ownerEnv, GITHUB_RUN_ID: '900', CLOCK_COMMAND: 'pause' }, now: tickedAt, commit: async () => {} });
  await assert.rejects(verifyClockChild({ root, env: decisionEnv, api: async () => assert.fail('Paused decisions fail before API/model access.') }), /fenced/);
  await claimClock({ root, env: { ...ownerEnv, GITHUB_RUN_ID: '901', CLOCK_COMMAND: 'reset' }, now: tickedAt, commit: async () => {} });
  await start(root, { env: { ...ownerEnv, GITHUB_RUN_ID: '902' }, now: tickedAt });
  await assert.rejects(verifyClockChild({ root, env: decisionEnv, api: async () => assert.fail('Superseded chain cannot begin model work.') }), /fenced/);
});

test('workflow claims before wait, shares the record lock, and contains no model or sleep', async () => {
  const workflow = await readFile(new URL('../.github/workflows/clock.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('  claim:') < workflow.indexOf('  timer:'));
  assert.match(workflow, /group: observatory-clock\n  cancel-in-progress: false\n  queue: max/);
  assert.equal((workflow.match(/group: observatory-record/g) || []).length, 2);
  assert.match(workflow, /environment:\n      name: clock\n      deployment: false/);
  assert.match(workflow, /needs\.claim\.outputs\.claimed == 'true'/);
  assert.doesNotMatch(workflow, /codex-action|OPENAI_API_KEY|secrets\.|run:[^\n]*\bsleep\s/);
});
