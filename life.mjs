/** Public, deterministic B3/S23 laboratory. No oracle, random source or I/O. */
export const LIFE_SIZE = 16;
const HISTORY_LIMIT = 12;
const GUIDE_LIMIT = 64;
const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mod = n => ((n % LIFE_SIZE) + LIFE_SIZE) % LIFE_SIZE;
const metric = (label, value, unit = '') => ({ label, value, unit });
const kinds = ['fixed', 'oscillator', 'traveller', 'extinction', 'unknown'];

export const LIFE_TEMPLATES = Object.freeze({
  block: { label: 'Block', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  blinker: { label: 'Blinker', cells: [[0, 0], [1, 0], [2, 0]] },
  glider: { label: 'Glider', cells: [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]] },
  beacon: { label: 'Beacon', cells: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2], [3, 2], [2, 3], [3, 3]] },
  toad: { label: 'Toad', cells: [[1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1]] },
  loaf: { label: 'Loaf', cells: [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [3, 2], [2, 3]] },
  'r-pentomino': { label: 'R pentomino', cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]] },
  diehard: { label: 'Diehard', cells: [[6, 0], [0, 1], [1, 1], [1, 2], [5, 2], [6, 2], [7, 2]] },
});

const coordSchema = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', min: 0, max: 15 } };
export const LIFE_ACTIONS = [{ action: 'experiment', label: 'Test a life hypothesis',
  description: 'Choose one template or custom seed, optionally toggle up to eight cells, simulate and independently repeat at a translated origin.',
  params: {
    name: { type: 'string', required: true, maxLength: 80 },
    seed_template: { type: 'string', enum: Object.keys(LIFE_TEMPLATES), required: false },
    seed_cells: { type: 'array', required: false, minItems: 1, maxItems: 64, items: coordSchema },
    origin: { ...coordSchema, required: false },
    toggle_cells: { type: 'array', required: false, maxItems: 8, items: coordSchema },
    steps: { type: 'integer', required: true, min: 4, max: 48 },
    hypothesis: { type: 'object', required: true, properties: {
      kind: { type: 'string', required: true, enum: kinds },
      period: { type: 'integer', required: false, min: 1, max: 16 },
      dx: { type: 'integer', required: false, min: -4, max: 4 },
      dy: { type: 'integer', required: false, min: -4, max: 4 },
    } },
  } }];

function keys(value, allowed, field) {
  if (!record(value)) throw new TypeError(`${field} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new RangeError(`Unknown ${field} parameter: ${key}.`);
}
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}
function coord(value, field) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${field} must be [x,y].`);
  return value.map((v, i) => integer(v, 0, 15, `${field}[${i}]`));
}
function coords(value, min, max, field) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new RangeError(`${field} needs ${min}..${max} coordinates.`);
  const result = value.map((v, i) => coord(v, `${field}[${i}]`));
  if (new Set(result.map(v => v.join(','))).size !== result.length) throw new RangeError(`${field} cannot contain duplicate cells.`);
  return result;
}

/** Exactly one seed source. Custom coordinates and toggles are absolute; origin offsets templates. */
export function validateLifeParams(params) {
  keys(params, ['name', 'seed_template', 'seed_cells', 'origin', 'toggle_cells', 'steps', 'hypothesis'], 'life');
  if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 80) throw new TypeError('name must be a nonempty string of at most 80 characters.');
  if ((params.seed_template !== undefined) === (params.seed_cells !== undefined)) throw new RangeError('Choose exactly one of seed_template or seed_cells.');
  if (params.seed_template !== undefined && !Object.hasOwn(LIFE_TEMPLATES, params.seed_template)) throw new RangeError('Unknown seed_template.');
  if (params.seed_cells !== undefined && params.origin !== undefined) throw new RangeError('origin applies only to templates; custom seed_cells are absolute.');
  const normalized = { name: params.name.trim(), steps: integer(params.steps, 4, 48, 'steps'),
    toggle_cells: coords(params.toggle_cells ?? [], 0, 8, 'toggle_cells') };
  if (params.seed_template !== undefined) {
    normalized.seed_template = params.seed_template;
    normalized.origin = coord(params.origin ?? [6, 6], 'origin');
  } else normalized.seed_cells = coords(params.seed_cells, 1, 64, 'seed_cells');
  keys(params.hypothesis, ['kind', 'period', 'dx', 'dy'], 'hypothesis');
  const h = params.hypothesis;
  if (!kinds.includes(h.kind)) throw new RangeError('Unknown hypothesis kind.');
  const hypothesis = { kind: h.kind };
  if (['fixed', 'oscillator', 'traveller'].includes(h.kind)) {
    hypothesis.period = integer(h.period ?? (h.kind === 'fixed' ? 1 : undefined), 1, 16, 'hypothesis.period');
    if (h.kind === 'fixed' && hypothesis.period !== 1) throw new RangeError('A fixed hypothesis has period 1.');
    if (h.kind === 'oscillator' && hypothesis.period < 2) throw new RangeError('An oscillator hypothesis needs period 2..16.');
  } else if (h.period !== undefined) throw new RangeError('period applies only to fixed, oscillator or traveller hypotheses.');
  if (h.kind === 'traveller') {
    hypothesis.dx = integer(h.dx, -4, 4, 'hypothesis.dx');
    hypothesis.dy = integer(h.dy, -4, 4, 'hypothesis.dy');
    if (hypothesis.dx === 0 && hypothesis.dy === 0) throw new RangeError('A traveller needs a nonzero displacement.');
  } else if (h.dx !== undefined || h.dy !== undefined) throw new RangeError('dx and dy apply only to traveller hypotheses.');
  normalized.hypothesis = hypothesis;
  return normalized;
}

/** Row-major bits: bit i=16*y+x; its hex nibble uses the 8,4,2,1 order. */
export function packLifeFrame(cells) {
  const nibbles = new Uint8Array(64);
  for (const [x, y] of cells) { const i = 16 * y + x; nibbles[i >> 2] |= 8 >> (i & 3); }
  return Array.from(nibbles, n => n.toString(16)).join('');
}
export function unpackLifeFrame(frame) {
  if (typeof frame !== 'string' || !/^[0-9a-f]{64}$/.test(frame)) throw new TypeError('Life frame must contain exactly 64 lowercase hexadecimal characters.');
  const cells = [];
  for (let i = 0; i < 256; i += 1) if (parseInt(frame[i >> 2], 16) & (8 >> (i & 3))) cells.push([i % 16, Math.floor(i / 16)]);
  return cells;
}
export function translateLifeCells(cells, dx, dy) {
  return cells.map(([x, y]) => [mod(x + dx), mod(y + dy)]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** n(x,y)=sum of the eight toroidal neighbours; next alive iff n=3 or (alive and n=2). */
export function stepLife(cells) {
  const live = new Uint8Array(256);
  const counts = new Uint8Array(256);
  for (const [x, y] of cells) {
    live[16 * y + x] = 1;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (dx || dy) counts[16 * mod(y + dy) + mod(x + dx)] += 1;
    }
  }
  const next = [];
  for (let i = 0; i < 256; i += 1) if (counts[i] === 3 || (live[i] && counts[i] === 2)) next.push([i % 16, Math.floor(i / 16)]);
  return next;
}
function simulate(cells, steps) {
  let current = cells;
  const frames = [packLifeFrame(current)];
  for (let i = 0; i < steps; i += 1) { current = stepLife(current); frames.push(packLifeFrame(current)); }
  return frames;
}
function signature(cells) {
  let best = null;
  for (let dy = 0; dy < 16; dy += 1) for (let dx = 0; dx < 16; dx += 1) {
    const shifted = packLifeFrame(translateLifeCells(cells, dx, dy));
    if (best === null || shifted < best) best = shifted;
  }
  return best;
}
const shifts = Array.from({ length: 256 }, (_, i) => [i % 16 - 8, Math.floor(i / 16) - 8])
  .sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]) || a[1] - b[1] || a[0] - b[0]);
function displacement(from, to) {
  for (const [dx, dy] of shifts) if (packLifeFrame(translateLifeCells(from, dx, dy)) === to) return [dx, dy];
  return null;
}
/** A repeated translated state proves recurrence under this autonomous equivariant rule. */
export function classifyLifeFrames(frames) {
  const decoded = frames.map(unpackLifeFrame);
  const extinct = decoded.findIndex(cells => cells.length === 0);
  if (extinct >= 0) return { kind: 'extinction', period: null, dx: 0, dy: 0, start_step: extinct, observed_until: frames.length - 1 };
  const memo = new Map();
  const signatures = frames.map((frame, index) => {
    if (!memo.has(frame)) memo.set(frame, signature(decoded[index]));
    return memo.get(frame);
  });
  for (let period = 1; period <= Math.min(16, frames.length - 1); period += 1) {
    for (let start = 0; start + period < frames.length; start += 1) {
      if (signatures[start] !== signatures[start + period]) continue;
      const [dx, dy] = displacement(decoded[start], frames[start + period]);
      return { kind: dx || dy ? 'traveller' : period === 1 ? 'fixed' : 'oscillator', period, dx, dy,
        start_step: start, observed_until: frames.length - 1 };
    }
  }
  return { kind: 'unknown', period: null, dx: 0, dy: 0, start_step: null, observed_until: frames.length - 1 };
}
function compareClaim(h, actual) {
  if (h.kind === 'unknown') return { status: 'unassessed', reason: 'No behavior claim was submitted.' };
  if (actual.kind === 'unknown') return { status: 'unassessed', reason: 'No recurrence or extinction was observed within the chosen horizon.' };
  const agrees = h.kind === actual.kind && (!Object.hasOwn(h, 'period') || h.period === actual.period)
    && (h.kind !== 'traveller' || (h.dx === actual.dx && h.dy === actual.dy));
  return { status: agrees ? 'confirmed' : 'rejected', reason: agrees ? 'Submitted behavior matches measured recurrence or extinction.'
    : `Claimed ${h.kind}${h.period ? ` period ${h.period}` : ''}; observed ${actual.kind}${actual.period ? ` period ${actual.period}` : ''}${actual.kind === 'traveller' ? ` displacement (${actual.dx},${actual.dy})` : ''}.` };
}

export function initializeLife() {
  return { width: 16, height: 16, topology: 'toroidal', rule: 'B3/S23',
    cells: translateLifeCells(LIFE_TEMPLATES.glider.cells, 6, 6), templates: clone(LIFE_TEMPLATES),
    experiments_tested: 0, confirmed_claims: 0, rejected_claims: 0, unassessed_claims: 0,
    verified_reproductions: 0, novel_patterns: 0, archived_guide_entries: 0,
    archived_guide_evidence: { tested: 0, confirmed_claims: 0, rejected_claims: 0, verified_reproductions: 0 },
    novelty_definition: 'Measured catalogue additions; an entry retired after the 64-entry working window may be added again. Complete experiment history remains in the parent timeline.',
    latest_record: null, records: [], field_guide: [], contradictions: [], agent_memory: { last_results: [], watch: 'No experiments have been run. Choose a template or construct a bounded custom seed and submit a testable hypothesis.' } };
}

/** Preview seed construction only; no simulation, record or research counter changes. */
export function resolveLifeSeed(suppliedParams) {
  const params = validateLifeParams(suppliedParams);
  const cells = params.seed_template ? translateLifeCells(LIFE_TEMPLATES[params.seed_template].cells, ...params.origin) : params.seed_cells;
  const toggled = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of params.toggle_cells) { const key = `${x},${y}`; if (toggled.has(key)) toggled.delete(key); else toggled.add(key); }
  return Array.from(toggled, s => s.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Returns a new world plus the event payload; never changes the supplied world or decision. */
export function applyLifeDecision(prior, decision) {
  if (!record(decision) || decision.action !== 'experiment') throw new RangeError('Unsupported life-research action.');
  const checked = validateLifeWorld(prior);
  if (!checked.valid) throw new Error(`Invalid life world: ${checked.errors.join('; ')}`);
  const params = validateLifeParams(decision.params);
  const seed = resolveLifeSeed(params);
  const frames = simulate(seed, params.steps);
  const actual = classifyLifeFrames(frames);
  const claim = compareClaim(params.hypothesis, actual);
  const shift = [5, 7];
  const repeated = simulate(translateLifeCells(seed, ...shift), params.steps);
  const mismatch = repeated.findIndex((frame, i) => frame !== packLifeFrame(translateLifeCells(unpackLifeFrame(frames[i]), ...shift)));
  const replication = { shift, steps: params.steps, compared_frames: frames.length, passed: mismatch < 0, actual: classifyLifeFrames(repeated),
    first_mismatch: mismatch < 0 ? null : mismatch, seed_frame: repeated[0], final_frame: repeated.at(-1) };
  const world = clone(prior);
  const id = `life-${String(world.experiments_tested + 1).padStart(4, '0')}`;
  const seedSignature = signature(seed);
  const previous = world.field_guide.find(entry => entry.signature === seedSignature);
  const trial = { id, name: params.name, params, initial_seed: seed, frames, actual, hypothesis: params.hypothesis,
    claim, replication, alive_initial: seed.length, alive_final: unpackLifeFrame(frames.at(-1)).length,
    novel_pattern: !previous, novelty_scope: 'current measured catalogue', seed_signature: seedSignature };
  world.experiments_tested += 1;
  world[`${claim.status}_claims`] += 1;
  if (replication.passed) world.verified_reproductions += 1;
  if (!previous) {
    world.novel_patterns += 1;
    world.field_guide.push({ signature: seedSignature, name: params.name, first_record: id, last_record: id,
      actual, tested: 1, confirmed_claims: claim.status === 'confirmed' ? 1 : 0,
      rejected_claims: claim.status === 'rejected' ? 1 : 0, verified_reproductions: replication.passed ? 1 : 0 });
    if (world.field_guide.length > GUIDE_LIMIT) {
      const retired = world.field_guide.shift();
      world.archived_guide_entries += 1;
      for (const key of Object.keys(world.archived_guide_evidence)) world.archived_guide_evidence[key] += retired[key];
    }
  } else {
    previous.last_record = id; previous.actual = actual; previous.tested += 1;
    previous.confirmed_claims += claim.status === 'confirmed' ? 1 : 0;
    previous.rejected_claims += claim.status === 'rejected' ? 1 : 0;
    previous.verified_reproductions += replication.passed ? 1 : 0;
  }
  if (claim.status === 'rejected') world.contradictions = [...world.contradictions, { id, name: params.name, hypothesis: params.hypothesis, actual, reason: claim.reason }].slice(-12);
  world.cells = unpackLifeFrame(frames.at(-1));
  world.latest_record = trial;
  world.records = [...world.records, clone(trial)].slice(-HISTORY_LIMIT);
  world.agent_memory = { last_results: [...world.agent_memory.last_results, { id, name: params.name, actual, claim: claim.status,
    replication: replication.passed, mutated_cells: params.toggle_cells.length }].slice(-6),
    watch: actual.kind === 'unknown' ? `No recurrence detected through generation ${params.steps}; extend the horizon or change the seed without treating this as extinction.`
      : `Measured ${actual.kind}${actual.period ? ` period ${actual.period}` : ''}, transient ${actual.start_step} generations. Contrast it with a mutation or another template.` };
  return { world, actor: 'Artificial-life research council',
    observation: `${prior.experiments_tested} experiments tested; ${prior.field_guide.length} measured patterns retained. Selected ${params.name} with ${seed.length} initial live cells.`,
    consequences: [`Simulated ${params.steps} generations: ${actual.kind}${actual.period ? ` period ${actual.period}` : ''}; ${trial.alive_final} live cells remain.`,
      `Hypothesis ${claim.status}. ${claim.reason}`, `Translated replication ${replication.passed ? 'passed' : 'failed'} across ${replication.compared_frames} independently computed frames.`],
    evidence: [metric('Generations simulated', params.steps), metric('Measured behavior', actual.kind), metric('Observed period', actual.period),
      metric('Displacement x', actual.dx, 'cells / period'), metric('Displacement y', actual.dy, 'cells / period'), metric('Transient generations', actual.start_step),
      metric('Hypothesis outcome', claim.status), metric('Replication compared frames', replication.compared_frames), metric('Replication passed', replication.passed), metric('Live cells', trial.alive_final)],
    learned: [`${id} ${params.name}: ${actual.kind}${actual.period ? `/${actual.period}` : ''}; claim ${claim.status}; translated reproduction ${replication.passed ? 'verified' : 'failed'}.`] };
}

export function lifeMetrics(world) {
  return [metric('Experiments tested', world.experiments_tested), metric('Confirmed claims', world.confirmed_claims),
    metric('Rejected claims', world.rejected_claims), metric('Unassessed claims', world.unassessed_claims),
    metric('Catalogue additions', world.novel_patterns), metric('Verified reproductions', world.verified_reproductions), metric('Alive cells', world.cells.length)];
}
export function lifeSnapshot(world) {
  const { records, templates, ...current } = world;
  return { world: clone(current), cells: clone(world.cells), latest_record: clone(world.latest_record), metrics: lifeMetrics(world) };
}

/** Report malformed/forged generations without throwing. Earlier full records stay in parent history. */
export function validateLifeWorld(world) {
  const errors = [];
  try {
    if (!record(world) || world.width !== 16 || world.height !== 16 || world.topology !== 'toroidal' || world.rule !== 'B3/S23') return { valid: false, errors: ['Invalid life lattice or rule.'] };
    coords(world.cells, 0, 256, 'cells');
    for (const key of ['experiments_tested', 'confirmed_claims', 'rejected_claims', 'unassessed_claims', 'verified_reproductions', 'novel_patterns', 'archived_guide_entries']) integer(world[key], 0, Number.MAX_SAFE_INTEGER, key);
    if (world.confirmed_claims + world.rejected_claims + world.unassessed_claims !== world.experiments_tested) errors.push('Life claim counts do not reconcile.');
    if (world.verified_reproductions > world.experiments_tested || world.novel_patterns > world.experiments_tested) errors.push('Life evidence counts exceed actual experiments.');
    if (!Array.isArray(world.records) || world.records.length !== Math.min(HISTORY_LIMIT, world.experiments_tested)) errors.push('Life record window does not reconcile.');
    if (!Array.isArray(world.field_guide) || world.field_guide.length > GUIDE_LIMIT || world.field_guide.length + world.archived_guide_entries !== world.novel_patterns) errors.push('Life catalogue does not reconcile.');
    if (!record(world.archived_guide_evidence)) errors.push('Missing archived life evidence.');
    else for (const [key, counter] of [['tested', 'experiments_tested'], ['confirmed_claims', 'confirmed_claims'], ['rejected_claims', 'rejected_claims'], ['verified_reproductions', 'verified_reproductions']]) {
      integer(world.archived_guide_evidence[key], 0, Number.MAX_SAFE_INTEGER, `archived_${key}`);
      const total = (world.field_guide ?? []).reduce((sum, entry) => sum + integer(entry[key], 0, Number.MAX_SAFE_INTEGER, `guide_${key}`), world.archived_guide_evidence[key]);
      if (total !== world[counter]) errors.push(`Life catalogue ${key} does not reconcile with counters.`);
    }
    if (!Array.isArray(world.contradictions) || world.contradictions.length > 12 || !record(world.agent_memory) || !Array.isArray(world.agent_memory.last_results) || world.agent_memory.last_results.length > 6) errors.push('Invalid bounded life memory.');
    for (const trial of world.records ?? []) {
      const p = validateLifeParams(trial.params);
      if (!Array.isArray(trial.frames) || trial.frames.length !== p.steps + 1) { errors.push('Life frame count does not match chosen steps.'); continue; }
      const frames = trial.frames.map(unpackLifeFrame);
      if (packLifeFrame(resolveLifeSeed(p)) !== trial.frames[0]) errors.push('Life chosen parameters do not reconstruct the initial seed.');
      if (packLifeFrame(trial.initial_seed) !== trial.frames[0]) errors.push('Life initial seed does not match frame zero.');
      for (let i = 1; i < frames.length; i += 1) if (packLifeFrame(stepLife(frames[i - 1])) !== trial.frames[i]) { errors.push(`Forged B3/S23 generation in ${trial.id}.`); break; }
      if (!kinds.includes(trial.actual?.kind) || !['confirmed', 'rejected', 'unassessed'].includes(trial.claim?.status)) errors.push('Invalid life result.');
      const computedActual = classifyLifeFrames(trial.frames);
      if (JSON.stringify(trial.actual) !== JSON.stringify(computedActual)) errors.push('Forged life classification.');
      if (JSON.stringify(trial.hypothesis) !== JSON.stringify(p.hypothesis) || JSON.stringify(trial.claim) !== JSON.stringify(compareClaim(p.hypothesis, computedActual))) errors.push('Forged life hypothesis outcome.');
      if (trial.seed_signature !== signature(frames[0])) errors.push('Forged life seed signature.');
      if (trial.alive_initial !== frames[0].length || trial.alive_final !== frames.at(-1).length) errors.push('Life alive-cell counts do not reconcile.');
      if (!record(trial.replication) || trial.replication.passed !== true || trial.replication.compared_frames !== frames.length) errors.push('Missing verified translated life reproduction.');
      if (JSON.stringify(trial.replication?.shift) !== '[5,7]' || trial.replication?.steps !== p.steps || trial.replication?.first_mismatch !== null) errors.push('Invalid translated life replication inputs.');
      const repeated = simulate(translateLifeCells(frames[0], 5, 7), p.steps);
      if (JSON.stringify(trial.replication?.actual) !== JSON.stringify(classifyLifeFrames(repeated))) errors.push('Forged independent life classification.');
      if (trial.replication?.passed && (trial.replication.seed_frame !== packLifeFrame(translateLifeCells(frames[0], ...trial.replication.shift)) || trial.replication.final_frame !== packLifeFrame(translateLifeCells(frames.at(-1), ...trial.replication.shift)))) errors.push('Life reproduction endpoints do not match.');
    }
    if (world.experiments_tested === 0 && world.latest_record !== null) errors.push('Untested life world has a trial record.');
    if (world.experiments_tested > 0 && (JSON.stringify(world.latest_record) !== JSON.stringify(world.records.at(-1)) || packLifeFrame(world.cells) !== world.latest_record.frames.at(-1))) errors.push('Latest life record or cells do not reconcile.');
  } catch (error) { errors.push(`Malformed life world: ${error.message}`); }
  return { valid: errors.length === 0, errors };
}
