// Public reads and an authenticated, conditional publication pointer in R2.
const STATE_KEY = 'observatory/state.json';
const MAX_BYTES = 4 * 1024 * 1024;
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};
const respond = (data, status = 200) => Response.json(data, { status, headers });
const revisionKey = n => `observatory/revisions/${n}.json`;
const eventKey = (id, turn) => `observatory/events/${encodeURIComponent(id)}/${turn}.json`;
const emptyState = () => ({
  schema_version: 1, title: 'The Autonomous Observatory', revision: 0,
  created_at: null, updated_at: null,
  schedule: { factory_minutes: 60, loop_minutes: 5, status: 'preparing', requires: 'Mac awake and Codex running', next_launch_at: null, next_tick_at: null },
  experiments: [], launches: [],
});
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const iso = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x));
const short = (x, max = 200) => typeof x === 'string' && !!x.trim() && x.length <= max;

// Sorted serialization makes semantically identical retries idempotent.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function digest(text) {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...raw].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function authenticated(request, configured) {
  if (typeof configured !== 'string' || configured.length < 32) return false;
  const auth = request.headers.get('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!presented || presented.length > 4096) return false;
  const [a, b] = await Promise.all([digest(presented), digest(configured)]);
  let different = 0;
  for (let n = 0; n < a.length; n++) different |= a.charCodeAt(n) ^ b.charCodeAt(n);
  return different === 0;
}
function validatePublicTree(value) {
  let nodes = 0;
  const visit = (x, depth) => {
    if (++nodes > 150000 || depth > 24) throw new Error('Public state is too complex');
    if (typeof x === 'string' && x.length > 60000) throw new Error('Public text is too long');
    if (Array.isArray(x)) {
      if (x.length > 10000) throw new Error('Public arrays are too long');
      x.forEach(v => visit(v, depth + 1));
    } else if (object(x)) {
      for (const [key, v] of Object.entries(x)) {
        if (/^_?(private|oracle|secrets?|write_token|access_token|authorization|credentials)$/i.test(key)) throw new Error('Public state contains a private field');
        if (key.length > 100) throw new Error('Public field name is too long');
        visit(v, depth + 1);
      }
    } else if (typeof x === 'number' && !Number.isFinite(x)) throw new Error('Invalid public number');
  };
  visit(value, 0);
}
function validateState(state, expectedRevision) {
  if (!object(state) || state.schema_version !== 1 || !short(state.title) || state.revision !== expectedRevision + 1) throw new Error('Invalid state schema or revision');
  if (!iso(state.created_at) || !iso(state.updated_at)) throw new Error('Invalid state dates');
  validatePublicTree(state);
  const s = state.schedule;
  if (!object(s) || !['active', 'preparing', 'paused'].includes(s.status) || !short(s.requires, 500)) throw new Error('Invalid schedule');
  for (const k of ['factory_minutes', 'loop_minutes']) if (!Number.isSafeInteger(s[k]) || s[k] < 1 || s[k] > 10080) throw new Error('Invalid schedule cadence');
  for (const k of ['next_launch_at', 'next_tick_at']) if (s[k] !== null && !iso(s[k])) throw new Error('Invalid scheduled time');
  if (!Array.isArray(state.experiments) || state.experiments.length > 2000 || !Array.isArray(state.launches) || state.launches.length > 10000) throw new Error('Invalid experiment or launch archive');
  const ids = new Set();
  for (const e of state.experiments) {
    if (!object(e) || e.schema_version !== 1 || !short(e.id, 120) || ids.has(e.id) || !short(e.type, 120) || !short(e.title) || !short(e.description, 10000)) throw new Error('Invalid experiment identity');
    ids.add(e.id);
    if (!iso(e.created_at) || !iso(e.updated_at) || !['active', 'insolvent', 'completed'].includes(e.status)) throw new Error('Invalid experiment metadata');
    if (!Array.isArray(e.timeline) || !integer(e.turn) || e.timeline.length > Math.min(e.turn, 120) || (e.turn > 0 ? e.timeline.length < 1 : e.timeline.length !== 0)) throw new Error('Invalid bounded experiment timeline');
    if (!Array.isArray(e.roles) || !Array.isArray(e.metrics) || !object(e.memory) || !object(e.world) || !Array.isArray(e.allowed_actions)) throw new Error('Invalid experiment public state');
    for (let i = 0; i < e.timeline.length; i++) {
      const t = e.timeline[i];
      if (!object(t) || t.turn !== e.turn - e.timeline.length + i + 1 || !iso(t.at) || !short(t.actor, 200) || !object(t.decision) || !short(t.decision.action, 120) || !object(t.decision.params) || !Array.isArray(t.evidence)) throw new Error('Invalid timeline entry');
    }
  }
  const launchIds = new Set();
  for (const l of state.launches) {
    if (!object(l) || !short(l.id, 120) || launchIds.has(l.id) || !short(l.type, 120) || !short(l.title) || !iso(l.at) || !short(l.reason, 10000)) throw new Error('Invalid launch entry');
    launchIds.add(l.id);
    if (!ids.has(l.id)) throw new Error('Launch refers to an unknown experiment');
  }
}
function preserveHistory(current, next) {
  if (current.revision && (current.title !== next.title || current.created_at !== next.created_at)) throw new Error('Published observatory identity is immutable');
  if (next.launches.length < current.launches.length || canonical(next.launches.slice(0, current.launches.length)) !== canonical(current.launches)) throw new Error('Published launch history is immutable');
  const byId = new Map(next.experiments.map(e => [e.id, e]));
  for (const old of current.experiments) {
    const e = byId.get(old.id);
    if (!e || old.type !== e.type || old.created_at !== e.created_at) throw new Error('Published experiment identity is immutable');
    if (e.turn < old.turn) throw new Error('Published timeline cannot move backward');
    const retained = new Map(e.timeline.map(t => [t.turn, t]));
    for (const t of old.timeline) {
      if (retained.has(t.turn) && canonical(retained.get(t.turn)) !== canonical(t)) throw new Error('Published timeline is immutable');
    }
  }
}
function newEvents(current, next, supplied) {
  if (supplied !== undefined && !object(supplied)) throw new Error('Invalid event delta');
  if (supplied !== undefined) validatePublicTree(supplied);
  const old = new Map(current.experiments.map(e => [e.id, e]));
  const known = new Set(next.experiments.map(e => e.id));
  if (supplied) for (const id of Object.keys(supplied)) if (!known.has(id)) throw new Error('Events refer to an unknown experiment');
  const additions = [];
  for (const e of next.experiments) {
    const previous = old.get(e.id)?.turn || 0, count = e.turn - previous;
    // All additions must fit the retained tail so a later writer can repair an
    // interrupted event archive from the committed pointer alone.
    if (count < 0 || count > 120) throw new Error('Publish at most 120 new turns per experiment');
    const tail = e.timeline.filter(t => t.turn > previous);
    const list = supplied?.[e.id] ?? tail;
    if (!Array.isArray(list) || list.length !== count || canonical(list) !== canonical(tail)) throw new Error('Missing or conflicting new events');
    for (const t of list) additions.push({ id: e.id, event: t });
  }
  return additions;
}
async function readState(bucket) {
  const stored = await bucket.get(STATE_KEY);
  return { stored, state: stored ? await stored.json() : emptyState() };
}
async function archive(bucket, state, content) {
  const key = revisionKey(state.revision);
  const saved = await bucket.put(key, content, { onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
  if (saved) return;
  const existing = await bucket.get(key);
  if (!existing || canonical(await existing.json()) !== content) throw new Error('Immutable revision archive conflicts');
}
async function archiveEvents(bucket, state, additions) {
  for (const experiment of state.experiments) {
    const timeline = additions ? additions.filter(a => a.id === experiment.id).map(a => a.event) : experiment.timeline;
    if (!timeline.length) continue;
    // The highest event is written last. Its presence proves that this ordered
    // archive completed, avoiding 120 storage writes on every routine tick.
    const latest = timeline.at(-1), completed = await bucket.get(eventKey(experiment.id, latest.turn));
    if (completed) {
      if (canonical(await completed.json()) !== canonical(latest)) throw new Error('Immutable event archive conflicts');
      continue;
    }
    for (const event of timeline) {
    const key = eventKey(experiment.id, event.turn), content = canonical(event);
    const saved = await bucket.put(key, content, { onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
    if (saved) continue;
    const previous = await bucket.get(key);
    if (!previous || canonical(await previous.json()) !== content) throw new Error('Immutable event archive conflicts');
    }
  }
}
async function eventHistory(url, env, experimentId) {
  const { state } = await readState(env.BUCKET);
  const experiment = state.experiments.find(e => e.id === experimentId);
  if (!experiment) return respond({ error: 'Experiment not found' }, 404);
  const rawBefore = url.searchParams.get('before'), rawLimit = url.searchParams.get('limit');
  if ((rawBefore !== null && !/^[1-9]\d{0,9}$/.test(rawBefore)) || (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit))) return respond({ error: 'Invalid history page' }, 400);
  const before = rawBefore === null ? experiment.turn + 1 : Number(rawBefore), limit = rawLimit === null ? 120 : Number(rawLimit);
  if (before > experiment.turn + 1 || limit > 120) return respond({ error: 'Invalid history page' }, 400);
  const start = Math.max(1, before - limit), tail = new Map(experiment.timeline.map(e => [e.turn, e]));
  const events = await Promise.all(Array.from({ length: before - start }, async (_, n) => {
    const turn = start + n, saved = await env.BUCKET.get(eventKey(experimentId, turn));
    return saved ? saved.json() : tail.get(turn) || null;
  }));
  if (events.some(e => !e)) return respond({ error: 'History archive awaiting repair' }, 503);
  return respond({ experiment_id: experimentId, total_turns: experiment.turn, events, next_before: start > 1 ? start : null });
}
async function limitedJson(request) {
  const size = Number(request.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_BYTES) return { error: respond({ error: 'State exceeds 4 MiB' }, 413) };
  const reader = request.body?.getReader();
  if (!reader) return { error: respond({ error: 'JSON body required' }, 400) };
  let length = 0;
  const pieces = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) { await reader.cancel(); return { error: respond({ error: 'State exceeds 4 MiB' }, 413) }; }
    pieces.push(value);
  }
  const raw = new Uint8Array(length);
  let position = 0;
  for (const part of pieces) { raw.set(part, position); position += part.byteLength; }
  try { return { data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }; }
  catch { return { error: respond({ error: 'Invalid JSON' }, 400) }; }
}
async function publish(request, env) {
  // Authenticate before reading a body or accessing storage.
  if (!await authenticated(request, env.OBSERVATORY_WRITE_TOKEN)) return respond({ error: 'Unauthorized' }, 401);
  if (!env.BUCKET) return respond({ error: 'Archive unavailable' }, 503);
  const parsed = await limitedJson(request);
  if (parsed.error) return parsed.error;
  const { expected_revision: expected, state: next, events } = parsed.data || {};
  if (!integer(expected) || expected >= 1000000000) return respond({ error: 'Invalid expected revision' }, 400);
  try { validateState(next, expected); }
  catch (error) { return respond({ error: error.message }, 400); }
  const content = canonical(next), sha256 = await digest(content);
  const { stored, state: current } = await readState(env.BUCKET);
  if (current.revision !== expected) {
    const committed = current.revision === next.revision ? current : current.revision > next.revision ? await env.BUCKET.get(revisionKey(next.revision)).then(x => x?.json()) : null;
    if (committed && canonical(committed) === content) {
      await archive(env.BUCKET, next, content);
      await archiveEvents(env.BUCKET, next);
      return respond({ action: 'already_published', revision: next.revision, current_revision: current.revision, sha256 });
    }
    return respond({ error: 'Revision conflict', current_revision: current.revision }, 409);
  }
  let additions;
  try { preserveHistory(current, next); additions = newEvents(current, next, events); }
  catch (error) { return respond({ error: error.message }, 409); }
  // Archive the current pointer before advancing it, repairing interrupted prior
  // writes. Only a successful pointer CAS may create the next revision archive.
  if (current.revision > 0) {
    await archive(env.BUCKET, current, canonical(current));
    await archiveEvents(env.BUCKET, current);
  }
  const condition = stored ? new Headers({ 'If-Match': stored.httpEtag }) : new Headers({ 'If-None-Match': '*' });
  const saved = await env.BUCKET.put(STATE_KEY, content, { onlyIf: condition, customMetadata: { sha256 }, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
  if (!saved) return respond({ error: 'Publication changed concurrently; retry' }, 409);
  await archive(env.BUCKET, next, content);
  await archiveEvents(env.BUCKET, next, additions);
  return respond({ action: 'published', revision: next.revision, sha256 });
}

export async function handleApi(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) return null;
  try {
    if (path === '/api/state' && request.method === 'PUT') return await publish(request, env);
    if (!['GET', 'HEAD'].includes(request.method)) return respond({ error: 'Method not allowed' }, 405);
    const historyMatch = /^\/api\/experiments\/([^/]+)\/history$/.exec(path);
    if (!['/api/state', '/api/status', '/api/history'].includes(path) && !historyMatch) return respond({ error: 'Not found' }, 404);
    if (!env.BUCKET) return respond({ error: 'Archive unavailable' }, 503);
    if (historyMatch) return await eventHistory(url, env, decodeURIComponent(historyMatch[1]));
    if (path === '/api/history') {
      const raw = url.searchParams.get('revision');
      if (!raw || !/^[1-9]\d{0,9}$/.test(raw)) return respond({ error: 'Invalid revision' }, 400);
      const saved = await env.BUCKET.get(revisionKey(Number(raw)));
      return saved ? respond(await saved.json()) : respond({ error: 'Revision not found' }, 404);
    }
    const { state } = await readState(env.BUCKET);
    if (path === '/api/state') return respond(state);
    return respond({ title: state.title, revision: state.revision, experiments: state.experiments.length, turns: state.experiments.reduce((sum, e) => sum + e.turn, 0), updated_at: state.updated_at, schedule: state.schedule });
  } catch {
    // Storage and internal exceptions must not expose credentials or raw bodies.
    return respond({ error: 'Archive operation failed; retry later' }, 503);
  }
}
