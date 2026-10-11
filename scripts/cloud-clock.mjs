import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The repository and route allowlist are deliberate trust boundaries.
export const CLOCK_REPOSITORY = 'xndanius/autonomous-observatory';
export const CLOCK_OWNER = 'xndanius';
export const CLOCK_WAIT_MINUTES = 15;
export const CLOCK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLOCK_STATE_PATH = 'data/cloud-clock/state.json';
const numeric = value => /^[1-9]\d{0,15}$/.test(String(value || '')) && Number.isSafeInteger(Number(value));
const attempt = value => /^[1-9]\d{0,3}$/.test(String(value || ''));
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const clockRunUrl = runId => `https://github.com/${CLOCK_REPOSITORY}/actions/runs/${runId}`;
export const clockTickId = (runId, runAttempt = 1) => `clock-${runId}-${runAttempt}`;
export const clockReceiptPath = (runId, runAttempt = 1) => `data/cloud-clock/ticks/${clockTickId(runId, runAttempt)}.json`;

export function initialClockState() {
  return { schema: 1, armed: false, phase: 'paused', chainId: null, generation: 0,
    expectedRunId: null, expectedRunAttempt: 0, parentRunId: null, parentRunAttempt: 0,
    claimedAt: null, lastTickAt: null, nextTickAt: null, clockRunUrl: null,
    lastTickRunUrl: null, lastDecisionRunUrl: null, waitMinutes: CLOCK_WAIT_MINUTES };
}

export function validateClockState(state) {
  if (!state || state.schema !== 1 || typeof state.armed !== 'boolean'
    || !['paused', 'waiting', 'ticking', 'queued', 'stalled'].includes(state.phase)
    || !Number.isSafeInteger(state.generation) || state.generation < 0
    || state.waitMinutes !== CLOCK_WAIT_MINUTES
    || ![state.claimedAt, state.lastTickAt, state.nextTickAt].every(value => value === null || instant(value))) {
    throw new Error('Invalid committed cloud clock state.');
  }
  if (state.expectedRunId === null) {
    if (state.armed || state.phase !== 'paused' || state.expectedRunAttempt !== 0 || state.clockRunUrl !== null) {
      throw new Error('Invalid empty cloud clock lease.');
    }
  } else if (!numeric(state.expectedRunId) || !attempt(state.expectedRunAttempt)
    || state.clockRunUrl !== clockRunUrl(state.expectedRunId)
    || typeof state.chainId !== 'string' || !/^clock-[1-9]\d{0,15}-[1-9]\d{0,3}$/.test(state.chainId)) {
    throw new Error('Invalid exact cloud clock lease.');
  }
  if (state.parentRunId === null ? state.parentRunAttempt !== 0 : !numeric(state.parentRunId) || !attempt(state.parentRunAttempt)) {
    throw new Error('Invalid cloud clock parent.');
  }
  if (state.phase === 'paused' && state.armed) throw new Error('Paused cloud clock cannot remain armed.');
  for (const value of [state.lastTickRunUrl, state.lastDecisionRunUrl]) {
    if (value !== null && (typeof value !== 'string' || !/^https:\/\/github\.com\/xndanius\/autonomous-observatory\/actions\/runs\/[1-9]\d{0,15}$/.test(value))) {
      throw new Error('Cloud clock status contains an untrusted run link.');
    }
  }
  if (['waiting', 'ticking', 'queued'].includes(state.phase) && (!state.armed || !instant(state.claimedAt))) {
    throw new Error('Active cloud clock lacks an armed claim.');
  }
  return state;
}

async function boundedJSON(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error('Cloud clock record is not a bounded regular file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function readClockState(root = CLOCK_ROOT) {
  return validateClockState(await boundedJSON(path.join(root, CLOCK_STATE_PATH)));
}
async function writeJSON(root, relative, value, immutable = false) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: immutable ? 'wx' : 'w' });
}

export function trustedClockRun(run, runId, runAttempt) {
  return !!run && run.id === Number(runId) && run.run_attempt === Number(runAttempt)
    && run.repository?.full_name === CLOCK_REPOSITORY && run.head_repository?.full_name === CLOCK_REPOSITORY
    && run.head_branch === 'main' && run.path === '.github/workflows/clock.yml' && run.event === 'workflow_dispatch';
}
function trustedEnvironment(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== CLOCK_REPOSITORY
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !numeric(env.GITHUB_RUN_ID) || !attempt(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error('Cloud clock requires its trusted main-branch Actions workflow.');
  }
}
function ownerCommand(env) {
  if (env.GITHUB_ACTOR !== CLOCK_OWNER || env.GITHUB_TRIGGERING_ACTOR !== CLOCK_OWNER || env.GITHUB_RUN_ATTEMPT !== '1') {
    throw new Error('Only the owner can start, pause or reset the cloud clock on its first attempt.');
  }
  if ([env.CLOCK_CHAIN_ID, env.CLOCK_PARENT_RUN_ID, env.CLOCK_PARENT_RUN_ATTEMPT, env.CLOCK_GENERATION].some(Boolean)) {
    throw new Error('Owner clock commands require empty chain inputs.');
  }
}

// Structured request bodies go through stdin. API failures never expose bodies,
// headers, stderr or credentials in the public workflow log.
export function clockAPI(endpoint, { method = 'GET', body, env = process.env } = {}) {
  const allowed = /^repos\/xndanius\/autonomous-observatory\/actions\/(?:runs\/[1-9]\d{0,15}|workflows\/(?:clock|tick)\.yml\/dispatches)$/;
  if (!allowed.test(endpoint) || !['GET', 'POST'].includes(method)
    || (method === 'POST' && !endpoint.endsWith('/dispatches'))
    || (method === 'GET' && endpoint.endsWith('/dispatches'))) throw new Error('Unsupported cloud clock API route.');
  return new Promise((resolve, reject) => {
    const args = ['api', '--method', method, '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint];
    if (body !== undefined) args.push('--input', '-');
    const child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) child.kill('SIGTERM'); else output += chunk.toString(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Cloud clock GitHub API is unavailable.')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > 2 * 1024 * 1024) return reject(new Error('Cloud clock GitHub API is unavailable.'));
      try { resolve(output.trim() ? JSON.parse(output) : null); }
      catch { reject(new Error('Cloud clock GitHub API response is invalid.')); }
    });
    child.stdin.end(body === undefined ? '' : JSON.stringify(body));
  });
}

export async function dispatchWorkflow(workflow, inputs, { api = clockAPI, env = process.env } = {}) {
  if (!['clock.yml', 'tick.yml'].includes(workflow)) throw new Error('Unsupported cloud clock workflow.');
  const response = await api(`repos/${CLOCK_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST', body: { ref: 'main', inputs }, env,
  });
  if (!numeric(response?.workflow_run_id) || response.html_url !== clockRunUrl(response.workflow_run_id)
    || response.run_url !== `https://api.github.com/repos/${CLOCK_REPOSITORY}/actions/runs/${response.workflow_run_id}`) {
    throw new Error('Cloud clock dispatch did not return an exact trusted run.');
  }
  return { runId: String(response.workflow_run_id), runAttempt: 1, githubRunUrl: response.html_url };
}

export function commitClock({ root = CLOCK_ROOT, paths, message } = {}) {
  if (!paths?.length || paths.some(value => value !== CLOCK_STATE_PATH && !/^data\/cloud-clock\/ticks\/clock-[1-9]\d{0,15}-[1-9]\d{0,3}\.json$/.test(value))) {
    throw new Error('Cloud clock cannot commit outside its state and receipts.');
  }
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Could not persist cloud clock state.');
    return result.stdout || '';
  };
  git(['config', 'user.name', 'Observatory clock']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(['add', '--', ...paths]);
  if (!git(['diff', '--cached', '--name-only', '--', ...paths]).trim()) return;
  git(['commit', '--only', '-m', message, '--', ...paths]);
  for (let retry = 0; retry < 3; retry++) {
    const result = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return;
    git(['pull', '--rebase', 'origin', 'main']);
  }
  throw new Error('Could not persist cloud clock state.');
}
async function persistState({ root, state, commit, message, receipt }) {
  validateClockState(state);
  const paths = [CLOCK_STATE_PATH];
  if (receipt) {
    const relative = clockReceiptPath(receipt.githubRunId, receipt.githubRunAttempt);
    await writeJSON(root, relative, receipt, true); paths.push(relative);
  }
  await writeJSON(root, CLOCK_STATE_PATH, state);
  await commit({ root, paths, message });
}
async function output(env, values) {
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value ?? ''}\n`).join(''));
  console.log(JSON.stringify(values));
  return values;
}
export function cloudClockStatus(state) {
  return { armed: state.armed, phase: state.phase, chainId: state.chainId, generation: state.generation,
    lastTickAt: state.lastTickAt, nextTickAt: state.nextTickAt, clockRunUrl: state.clockRunUrl,
    lastTickRunUrl: state.lastTickRunUrl, lastDecisionRunUrl: state.lastDecisionRunUrl, waitMinutes: CLOCK_WAIT_MINUTES };
}

export function validClockReceipt(receipt) {
  return !!receipt && receipt.schema === 1 && receipt.kind === 'cloud-clock-tick'
    && ['success', 'failed'].includes(receipt.status)
    && numeric(receipt.githubRunId) && attempt(receipt.githubRunAttempt)
    && receipt.id === clockTickId(receipt.githubRunId, receipt.githubRunAttempt)
    && receipt.githubRunUrl === clockRunUrl(receipt.githubRunId)
    && typeof receipt.chainId === 'string' && /^clock-[1-9]\d{0,15}-[1-9]\d{0,3}$/.test(receipt.chainId)
    && Number.isSafeInteger(receipt.generation) && receipt.generation >= 0
    && receipt.environment === 'clock' && receipt.waitMinutes === CLOCK_WAIT_MINUTES
    && instant(receipt.claimedAt) && instant(receipt.tickedAt)
    && Date.parse(receipt.tickedAt) - Date.parse(receipt.claimedAt) >= CLOCK_WAIT_MINUTES * 60000
    && Array.isArray(receipt.dispatches);
}
function exactDispatch(row, workflow) {
  return !!row && row.workflow === workflow && numeric(row.runId) && row.runAttempt === 1
    && row.githubRunUrl === clockRunUrl(row.runId) && instant(row.requestedAt);
}

export async function claimClock({ root = CLOCK_ROOT, env = process.env, now = new Date(), api = clockAPI, commit = commitClock } = {}) {
  trustedEnvironment(env);
  const state = await readClockState(root), command = env.CLOCK_COMMAND || 'start', at = new Date(now).toISOString();
  if (['pause', 'reset'].includes(command)) {
    ownerCommand(env);
    const controlled = command === 'reset' ? { ...initialClockState(), lastTickAt: state.lastTickAt,
      lastTickRunUrl: state.lastTickRunUrl, lastDecisionRunUrl: state.lastDecisionRunUrl,
      previousChainId: state.chainId, resetAt: at, resetByRunId: env.GITHUB_RUN_ID }
      : { ...state, armed: false, phase: 'paused', nextTickAt: null, pausedAt: at, pausedByRunId: env.GITHUB_RUN_ID };
    await persistState({ root, state: controlled, commit, message: `clock: ${command} by owner run ${env.GITHUB_RUN_ID}` });
    return output(env, { claimed: 'false', phase: controlled.phase, reason: `clock_${command}` });
  }
  if (command === 'start') {
    ownerCommand(env);
    if (state.armed || state.phase !== 'paused') return output(env, { claimed: 'false', phase: state.phase, reason: 'clock_already_started_or_requires_reset' });
  } else if (command === 'continue') {
    if (!state.armed) return output(env, { claimed: 'false', phase: state.phase, reason: 'clock_paused' });
    if (state.phase !== 'queued' || state.expectedRunId !== env.GITHUB_RUN_ID || state.expectedRunAttempt !== Number(env.GITHUB_RUN_ATTEMPT)
      || state.chainId !== env.CLOCK_CHAIN_ID || state.parentRunId !== env.CLOCK_PARENT_RUN_ID
      || state.parentRunAttempt !== Number(env.CLOCK_PARENT_RUN_ATTEMPT) || String(state.generation) !== env.CLOCK_GENERATION) {
      return output(env, { claimed: 'false', phase: state.phase, reason: 'clock_claim_mismatch' });
    }
    const receipt = await boundedJSON(path.join(root, clockReceiptPath(state.parentRunId, state.parentRunAttempt)));
    if (!validClockReceipt(receipt) || receipt.status !== 'success' || receipt.chainId !== state.chainId
      || receipt.githubRunId !== state.parentRunId || receipt.githubRunAttempt !== state.parentRunAttempt
      || receipt.generation + 1 !== state.generation || !exactDispatch(receipt.child, 'clock.yml')
      || receipt.child.runId !== env.GITHUB_RUN_ID || receipt.child.generation !== state.generation) {
      throw new Error('Cloud clock child is not bound to its exact immutable parent receipt.');
    }
    const parent = await api(`repos/${CLOCK_REPOSITORY}/actions/runs/${state.parentRunId}`, { env });
    if (!trustedClockRun(parent, state.parentRunId, state.parentRunAttempt) || parent.status !== 'completed' || parent.conclusion !== 'success') {
      throw new Error('Cloud clock parent is untrusted or did not complete successfully.');
    }
  } else throw new Error('Unknown cloud clock command.');
  const claim = { ...state, armed: true, phase: 'waiting',
    chainId: command === 'start' ? clockTickId(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT) : state.chainId,
    generation: command === 'start' ? 0 : state.generation,
    expectedRunId: env.GITHUB_RUN_ID, expectedRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    parentRunId: command === 'start' ? null : state.parentRunId,
    parentRunAttempt: command === 'start' ? 0 : state.parentRunAttempt,
    claimedAt: at, nextTickAt: new Date(new Date(now).getTime() + CLOCK_WAIT_MINUTES * 60000).toISOString(),
    clockRunUrl: clockRunUrl(env.GITHUB_RUN_ID) };
  await persistState({ root, state: claim, commit, message: `clock: ${env.GITHUB_RUN_ID} claim generation ${claim.generation} before wait` });
  return output(env, { claimed: 'true', phase: claim.phase, reason: command === 'start' ? 'owner_started_clock' : 'expected_clock_child',
    next_tick_at: claim.nextTickAt, clock_run_url: claim.clockRunUrl });
}

export async function tickClock({ root = CLOCK_ROOT, env = process.env, now = new Date(), api = clockAPI, commit = commitClock } = {}) {
  trustedEnvironment(env);
  const state = await readClockState(root), at = new Date(now).toISOString();
  if (!state.armed) return output(env, { ticked: 'false', reason: 'clock_paused' });
  let prior;
  try { prior = await boundedJSON(path.join(root, clockReceiptPath(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior) {
    if (!validClockReceipt(prior)) throw new Error('Existing cloud clock receipt is invalid.');
    return output(env, { ticked: 'false', reason: 'clock_tick_already_recorded', child_run_id: prior.child?.runId || '', decision_run_id: prior.dispatches[0]?.runId || '' });
  }
  if (state.phase !== 'waiting' || state.expectedRunId !== env.GITHUB_RUN_ID || state.expectedRunAttempt !== Number(env.GITHUB_RUN_ATTEMPT)) {
    return output(env, { ticked: 'false', reason: state.phase === 'ticking' || state.phase === 'stalled' ? 'uncertain_tick_requires_owner_reset' : 'clock_lease_mismatch' });
  }
  if (new Date(now).getTime() < Date.parse(state.claimedAt) + CLOCK_WAIT_MINUTES * 60000) throw new Error('Cloud clock environment wait has not elapsed.');
  // A durable checkpoint makes a crash or rerun fail closed before another
  // external request. Exactly-once effects cannot be guessed after HTTP failure.
  const checkpoint = { ...state, phase: 'ticking', nextTickAt: null, dispatchStartedAt: at };
  await persistState({ root, state: checkpoint, commit, message: `clock: ${env.GITHUB_RUN_ID} checkpoint before exact dispatches` });
  const receipt = { schema: 1, id: clockTickId(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT), kind: 'cloud-clock-tick', status: 'success',
    chainId: state.chainId, generation: state.generation, githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: Number(env.GITHUB_RUN_ATTEMPT), githubRunUrl: clockRunUrl(env.GITHUB_RUN_ID),
    environment: 'clock', waitMinutes: CLOCK_WAIT_MINUTES, claimedAt: state.claimedAt, tickedAt: at,
    dispatches: [], child: null, failure: null };
  try {
    const decision = await dispatchWorkflow('tick.yml', { source_clock_run_id: env.GITHUB_RUN_ID,
      source_clock_run_attempt: env.GITHUB_RUN_ATTEMPT, source_clock_chain_id: state.chainId,
      source_clock_generation: String(state.generation) }, { api, env });
    receipt.dispatches.push({ ...decision, workflow: 'tick.yml', dispatchId: `${receipt.id}-tick`, requestedAt: at });
    const child = await dispatchWorkflow('clock.yml', { command: 'continue', chain_id: state.chainId,
      parent_run_id: env.GITHUB_RUN_ID, parent_run_attempt: env.GITHUB_RUN_ATTEMPT,
      generation: String(state.generation + 1) }, { api, env });
    receipt.child = { ...child, workflow: 'clock.yml', generation: state.generation + 1, requestedAt: at };
  } catch {
    receipt.status = 'failed'; receipt.failure = receipt.dispatches.length ? 'successor_dispatch_unverified' : 'decision_dispatch_unverified';
    const stalled = { ...checkpoint, phase: 'stalled', lastTickAt: at, lastTickRunUrl: receipt.githubRunUrl,
      lastDecisionRunUrl: receipt.dispatches[0]?.githubRunUrl || state.lastDecisionRunUrl, failure: receipt.failure };
    await persistState({ root, state: stalled, receipt, commit, message: `clock: ${receipt.id} stalled; owner reset required` });
    throw new Error('Cloud clock stopped after an uncertain dispatch; owner reset is required.');
  }
  const next = { ...state, phase: 'queued', generation: state.generation + 1,
    expectedRunId: receipt.child.runId, expectedRunAttempt: 1,
    parentRunId: env.GITHUB_RUN_ID, parentRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    lastTickAt: at, nextTickAt: new Date(new Date(now).getTime() + CLOCK_WAIT_MINUTES * 60000).toISOString(),
    clockRunUrl: receipt.child.githubRunUrl, lastTickRunUrl: receipt.githubRunUrl,
    lastDecisionRunUrl: receipt.dispatches[0].githubRunUrl };
  await persistState({ root, state: next, receipt, commit, message: `clock: ${receipt.id} exact decision ${receipt.dispatches[0].runId}, next ${receipt.child.runId}` });
  return output(env, { ticked: 'true', child_run_id: receipt.child.runId, decision_run_id: receipt.dispatches[0].runId,
    last_tick_at: at, next_tick_at: next.nextTickAt, clock_run_url: receipt.child.githubRunUrl, decision_run_url: receipt.dispatches[0].githubRunUrl });
}

// The trusted child gate uses this before any model or publisher access. Inputs
// merely locate the receipt; bot identity, exact first attempt and GitHub run
// metadata supply independent verification. A marker-free manual run returns null.
export async function verifyClockChild({ root = CLOCK_ROOT, env = process.env, api = clockAPI } = {}) {
  const parentId = env.SOURCE_CLOCK_RUN_ID, parentAttempt = env.SOURCE_CLOCK_RUN_ATTEMPT || env.SOURCE_CLOCK_ATTEMPT,
    chainId = env.SOURCE_CLOCK_CHAIN_ID, generation = env.SOURCE_CLOCK_GENERATION;
  if (![parentId, parentAttempt, chainId, generation].some(value => value !== undefined && value !== '')) return null;
  trustedEnvironment(env);
  if (!numeric(parentId) || !attempt(parentAttempt) || !chainId || !/^\d+$/.test(generation || '')
    || env.GITHUB_RUN_ATTEMPT !== '1' || env.GITHUB_ACTOR !== 'github-actions[bot]' || env.GITHUB_TRIGGERING_ACTOR !== 'github-actions[bot]') {
    throw new Error('Untrusted cloud clock decision context.');
  }
  const receipt = await boundedJSON(path.join(root, clockReceiptPath(parentId, parentAttempt)));
  if (!validClockReceipt(receipt) || receipt.githubRunId !== parentId || receipt.githubRunAttempt !== Number(parentAttempt)
    || receipt.chainId !== chainId || String(receipt.generation) !== generation || receipt.dispatches.length !== 1
    || !exactDispatch(receipt.dispatches[0], 'tick.yml') || receipt.dispatches[0].runId !== env.GITHUB_RUN_ID
    || Date.parse(receipt.dispatches[0].requestedAt) < Date.parse(receipt.tickedAt)
    || receipt.dispatches[0].dispatchId !== `${receipt.id}-tick`) throw new Error('Cloud clock receipt does not authorize this exact decision run.');
  const current = await readClockState(root);
  // The next clock generation may already have claimed while this decision
  // waits for the writer. The chain must remain armed; its generation can move.
  if (!current.armed || current.chainId !== chainId) throw new Error('Cloud clock decision was fenced by a pause or chain reset.');
  const [parent, child] = await Promise.all([
    api(`repos/${CLOCK_REPOSITORY}/actions/runs/${parentId}`, { env }),
    api(`repos/${CLOCK_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, { env }),
  ]);
  if (!trustedClockRun(parent, parentId, parentAttempt) || !['queued', 'requested', 'pending', 'waiting', 'in_progress', 'completed'].includes(parent.status)) {
    throw new Error('GitHub did not verify the cloud clock parent.');
  }
  if (!child || child.id !== Number(env.GITHUB_RUN_ID) || child.run_attempt !== 1
    || child.repository?.full_name !== CLOCK_REPOSITORY || child.head_repository?.full_name !== CLOCK_REPOSITORY
    || child.head_branch !== 'main' || child.path !== '.github/workflows/tick.yml' || child.event !== 'workflow_dispatch'
    || child.actor?.login !== 'github-actions[bot]' || child.triggering_actor?.login !== 'github-actions[bot]'
    || !['queued', 'requested', 'pending', 'waiting', 'in_progress', 'completed'].includes(child.status)) {
    throw new Error('GitHub did not verify the exact cloud clock child.');
  }
  return { source: 'github-environment-clock', verified: true, chainId, generation: Number(generation),
    tickId: receipt.id, clockRunId: parentId, clockRunAttempt: Number(parentAttempt),
    clockRunUrl: receipt.githubRunUrl, runId: env.GITHUB_RUN_ID, githubRunUrl: clockRunUrl(env.GITHUB_RUN_ID),
    claimedAt: receipt.claimedAt, tickedAt: receipt.tickedAt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const operation = action === 'claim' ? claimClock : action === 'tick' ? tickClock : null;
  if (!operation) { console.error('Unknown cloud clock action.'); process.exitCode = 1; }
  else operation().catch(() => { console.error('Cloud clock stopped before an uncertain or unauthorized action. Inspect its state and use an owner reset if stalled.'); process.exitCode = 1; });
}
