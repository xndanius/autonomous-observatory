/** Executable tiny apps, a bounded expression language, and reproducible repair receipts. */
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const same = (a, b) => canonical(a) === canonical(b);
const metric = (label, value, unit = '') => ({ label, value, unit });
const RECORD_LIMIT = 12, VERSION_LIMIT = 8;
const COUNTERS = ['decisions', 'inspections', 'patches_tested', 'accepted_patches', 'rejected_patches'];
const fixture = (id, x, y, z, expected) => ({ id, inputs: { x, y, z }, expected });

export const REPAIR_APPS = [
  { id: 'checkout', title: 'Discount checkout', spec: 'Return the total in whole cents for x unit cents, y items and z percent discount. Round down only after the complete discount calculation.',
    inputs: [{ name: 'x', label: 'Unit price (cents)', default: 1299 }, { name: 'y', label: 'Quantity', default: 3 }, { name: 'z', label: 'Discount (%)', default: 10 }],
    source: 'floor(x*y-z)', fixtures: [fixture('no-discount', 250, 4, 0, 1000), fixture('ten-percent', 1299, 3, 10, 3507), fixture('quarter-off', 199, 2, 25, 298), fixture('free-order', 500, 2, 100, 0), fixture('fractional-cent', 101, 1, 15, 85), fixture('empty-basket', 999, 0, 20, 0)] },
  { id: 'temperature', title: 'Celsius to Fahrenheit', spec: 'Convert x degrees Celsius to Fahrenheit. Ignore the unused y and z inputs.',
    inputs: [{ name: 'x', label: 'Celsius', default: 20 }], source: 'x*9/5+30',
    fixtures: [fixture('freezing', 0, 0, 0, 32), fixture('boiling', 100, 0, 0, 212), fixture('room', 20, 0, 0, 68), fixture('negative', -40, 0, 0, -40), fixture('half-degree', 12.5, 0, 0, 54.5)] },
  { id: 'boxes', title: 'Packing desk', spec: 'Return the number of boxes needed for x items when each box holds y items. A partly filled final box is still one box. y must be positive.',
    inputs: [{ name: 'x', label: 'Items', default: 17 }, { name: 'y', label: 'Box capacity', default: 6 }], source: 'floor(x/y)',
    fixtures: [fixture('partial-box', 17, 6, 0, 3), fixture('exact-fit', 12, 6, 0, 2), fixture('one-item', 1, 8, 0, 1), fixture('no-items', 0, 8, 0, 0), fixture('many-boxes', 101, 10, 0, 11)] },
  { id: 'travel', title: 'Journey time', spec: 'Return travel time in minutes for x kilometres at y kilometres per hour. y must be positive. Ignore z.',
    inputs: [{ name: 'x', label: 'Distance (km)', default: 12 }, { name: 'y', label: 'Speed (km/h)', default: 24 }], source: 'x/y',
    fixtures: [fixture('half-hour', 12, 24, 0, 30), fixture('one-hour', 5, 5, 0, 60), fixture('short-trip', 1, 12, 0, 5), fixture('stationary-trip', 0, 10, 0, 0), fixture('fractional-trip', 2.5, 20, 0, 7.5)] },
];
const APP_IDS = REPAIR_APPS.map(app => app.id);

/** This parser is also imported by the public viewer. It never evaluates JavaScript. */
export function parseRepairSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 160) throw new RangeError('App source must be 1–160 characters.');
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/,])/y;
  let cursor = 0;
  while (cursor < source.length) {
    if (!source.slice(cursor).trim()) break;
    re.lastIndex = cursor;
    const match = re.exec(source);
    if (!match) throw new SyntaxError('Only numbers, x/y/z, arithmetic and the documented functions are allowed.');
    tokens.push(match[1]); cursor = re.lastIndex;
    if (tokens.length > 96) throw new RangeError('App source has too many tokens.');
  }
  let position = 0, nodes = 0;
  const node = value => { if (++nodes > 64) throw new RangeError('App source exceeds 64 syntax nodes.'); return value; };
  const expression = (depth, minimum = 0) => {
    if (depth > 12) throw new RangeError('App source exceeds twelve nesting levels.');
    const token = tokens[position++]; let left;
    if (token === '-' || token === '+') left = node({ kind: 'unary', op: token, arg: expression(depth + 1, 3) });
    else if (token === '(') { left = expression(depth + 1); if (tokens[position++] !== ')') throw new SyntaxError('Missing closing parenthesis.'); }
    else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const value = Number(token); if (!Number.isFinite(value) || value > 1000000) throw new RangeError('Constants must be finite and at most one million.');
      left = node({ kind: 'number', value });
    } else if (['x', 'y', 'z'].includes(token)) left = node({ kind: 'input', name: token });
    else if (['floor', 'ceil', 'round', 'abs', 'min', 'max'].includes(token)) {
      if (tokens[position++] !== '(') throw new SyntaxError('Function calls need parentheses.');
      const args = [expression(depth + 1)];
      if (['min', 'max'].includes(token)) { if (tokens[position++] !== ',') throw new SyntaxError('min/max need two arguments.'); args.push(expression(depth + 1)); }
      if (tokens[position++] !== ')') throw new SyntaxError('Incorrect function arguments.');
      left = node({ kind: 'call', name: token, args });
    } else throw new SyntaxError('Expected a number, an input or a documented function.');
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
    while (precedence[tokens[position]] !== undefined && precedence[tokens[position]] >= minimum) {
      const op = tokens[position++]; left = node({ kind: 'binary', op, left, right: expression(depth + 1, precedence[op] + 1) });
    }
    return left;
  };
  const ast = expression(0);
  if (position !== tokens.length) throw new SyntaxError('Unexpected trailing source.');
  return ast;
}
export function evaluateRepairSource(source, inputs = {}) {
  try {
    if (!object(inputs) || Object.keys(inputs).some(key => !['x', 'y', 'z'].includes(key))) throw new TypeError('Inputs are numeric x, y and z fields.');
    const values = Object.fromEntries(['x', 'y', 'z'].map(name => {
      const value = inputs[name] === undefined ? 0 : inputs[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) throw new RangeError('Inputs must be finite numbers between minus and plus one million.');
      return [name, value];
    }));
    const visit = node => {
      let value;
      if (node.kind === 'number') value = node.value;
      else if (node.kind === 'input') value = values[node.name];
      else if (node.kind === 'unary') value = node.op === '-' ? -visit(node.arg) : visit(node.arg);
      else if (node.kind === 'call') value = Math[node.name](...node.args.map(visit));
      else { const a = visit(node.left), b = visit(node.right); value = node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b; }
      if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new RangeError('The calculation is undefined or exceeds the numeric bound.');
      return Object.is(value, -0) ? 0 : value;
    };
    return { ok: true, value: visit(parseRepairSource(source)), error: null };
  } catch (error) { return { ok: false, value: null, error: error.message }; }
}
export function testRepairSource(appId, source) {
  const app = REPAIR_APPS.find(app => app.id === appId);
  if (!app) throw new RangeError('Unknown repair app.');
  return app.fixtures.map(test => {
    const result = evaluateRepairSource(source, test.inputs);
    const passed = result.ok && result.value === test.expected;
    return { ...clone(test), actual: result.value, passed, error: result.error };
  });
}
function artifact(appId, id, source, status) {
  const tests = testRepairSource(appId, source);
  return { id, source, source_language: 'bounded arithmetic expression v1', tests, passed: tests.filter(test => test.passed).length, total: tests.length, status };
}
export const REPAIR_ACTIONS = [
  { action: 'inspect', label: 'Inspect an app', description: 'Run the deployed app against independently specified public regression fixtures. Choose the next repair from actual failing outputs.', params: { app_id: { type: 'string', required: true, enum: APP_IDS } } },
  { action: 'repair', label: 'Submit a source patch', description: 'Replace the actual executable expression. Independent golden fixtures review it; passing patches become current, rejected patches retain the working version and return to the queue. Language: x,y,z; numbers; +,-,*,/; parentheses; floor,ceil,round,abs (one argument), min,max (two). No JavaScript.', params: { app_id: { type: 'string', required: true, enum: APP_IDS }, source: { type: 'string', required: true, maxLength: 160 } } },
];
export function validateRepairParams(action, params) {
  const schema = REPAIR_ACTIONS.find(item => item.action === action)?.params;
  if (!schema || !object(params) || Object.keys(params).some(key => !Object.hasOwn(schema, key))) throw new RangeError('Unsupported repair action or parameter.');
  if (!APP_IDS.includes(params.app_id)) throw new RangeError('app_id must identify one of the four public apps.');
  if (action === 'inspect') return { app_id: params.app_id };
  parseRepairSource(params.source);
  return { app_id: params.app_id, source: params.source.trim() };
}
function memoryFor(records) {
  return { last_results: records.slice(-6).map(record => ({ id: record.id, app_id: record.app_id, verdict: record.verdict, passed: (record.candidate || record.before).passed, total: (record.candidate || record.before).total })),
    watch: 'Read the app specification and failing fixture outputs before selecting a patch. Passing this finite regression suite establishes its measured examples, not correctness for every possible input.' };
}
export function initializeRepair() {
  return { apps: REPAIR_APPS.map(definition => {
    const { source, ...app } = clone(definition), original = artifact(app.id, `opening-${app.id}`, source, 'broken');
    return { ...app, original, current: clone(original), versions: [], status: 'queued', patches_tested: 0, accepted_patches: 0, rejected_patches: 0, archived_versions: 0, last_patch_decision: 0, last_accepted_decision: 0 };
  }), queue: [...APP_IDS], records: [], latest_record: null, ...Object.fromEntries(COUNTERS.map(key => [key, 0])), archived_records: Object.fromEntries(COUNTERS.map(key => [key, 0])),
    evidence_scope: 'These are executable calculator apps. The reviewer runs fixed independent golden examples. Every attempted source is preserved in the immutable decision timeline; recent state keeps eight attempts per app. Passing these fixtures is not a proof for all inputs.', agent_memory: memoryFor([]) };
}
function recordCounts(receipt) { return { decisions: 1, inspections: receipt.action === 'inspect' ? 1 : 0, patches_tested: receipt.action === 'repair' ? 1 : 0, accepted_patches: receipt.verdict === 'accepted' ? 1 : 0, rejected_patches: receipt.verdict === 'rejected' ? 1 : 0 }; }
export function applyRepairDecision(prior, decision) {
  const report = validateRepairWorld(prior);
  if (!report.valid) throw new Error(`Invalid repair cafe world: ${report.errors.join('; ')}`);
  const params = validateRepairParams(decision.action, decision.params), world = clone(prior), number = world.decisions + 1;
  const app = world.apps.find(app => app.id === params.app_id), before = clone(app.current);
  let candidate = null, verdict = 'inspected', reason = 'The deployed source was executed against the fixed regression suite.';
  if (decision.action === 'repair') {
    candidate = artifact(app.id, `patch-${number}`, params.source, 'rejected');
    const passing = candidate.passed === candidate.total, changed = candidate.source !== before.source;
    verdict = passing && changed ? 'accepted' : 'rejected'; candidate.status = verdict;
    reason = !passing ? 'The proposed source failed one or more independent regression fixtures.' : !changed ? 'The submitted source is already deployed; it contains no source change.' : 'All independent regression fixtures passed; the new source is deployed.';
    app.patches_tested += 1; app[verdict === 'accepted' ? 'accepted_patches' : 'rejected_patches'] += 1;
    app.last_patch_decision = number; app.status = verdict === 'accepted' ? 'repaired' : 'queued';
    if (verdict === 'accepted') { app.current = clone(candidate); app.last_accepted_decision = number; }
    app.versions.push(clone(candidate)); if (app.versions.length > VERSION_LIMIT) { app.versions.shift(); app.archived_versions += 1; }
  }
  const receipt = { id: `repair-${number}`, action: decision.action, params, app_id: app.id, before, candidate, verdict, reason, requeued: verdict === 'rejected' };
  for (const [key, count] of Object.entries(recordCounts(receipt))) world[key] += count;
  world.records.push(clone(receipt)); if (world.records.length > RECORD_LIMIT) for (const [key, count] of Object.entries(recordCounts(world.records.shift()))) world.archived_records[key] += count;
  world.queue = world.apps.filter(app => app.status === 'queued').map(app => app.id);
  world.latest_record = clone(receipt); world.agent_memory = memoryFor(world.records);
  const measured = candidate || before;
  return { world, actor: decision.action === 'inspect' ? 'Repair manager and independent fixture reviewer' : 'Repair developer and independent fixture reviewer',
    observation: `${app.title}: deployed source passed ${before.passed}/${before.total} fixed fixtures; ${prior.queue.length} apps were queued.`,
    consequences: [`${app.title}: ${verdict}; executed source passed ${measured.passed}/${measured.total} independent fixtures.`, reason,
      ...(verdict === 'rejected' ? ['The previous deployed source remains playable; the rejected patch returns to the repair queue.'] : [])],
    evidence: [metric('Review outcome', verdict), metric('Fixture passes', measured.passed), metric('Fixture failures', measured.total - measured.passed), metric('Working apps', world.apps.filter(app => app.current.passed === app.current.total).length), metric('Queued apps', world.queue.length)],
    learned: [`${receipt.id}: ${app.id} ${verdict}; ${measured.passed}/${measured.total} fixture passes.`] };
}
export function repairMetrics(world) {
  return [metric('Working apps', world.apps.filter(app => app.current.passed === app.current.total).length), metric('Apps in queue', world.queue.length), metric('Patches tested', world.patches_tested), metric('Accepted patches', world.accepted_patches), metric('Rejected patches', world.rejected_patches), metric('Inspections', world.inspections)];
}
export function repairSnapshot(world) { return { world: clone(world), metrics: repairMetrics(world) }; }
function integer(value, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError('Expected a bounded nonnegative integer.'); }
function validArtifact(appId, value, opening = false) {
  if (!object(value) || !['broken', 'accepted', 'rejected'].includes(value.status)) return false;
  parseRepairSource(value.source);
  if (opening ? value.id !== `opening-${appId}` || value.status !== 'broken' : !/^patch-[1-9]\d*$/.test(value.id) || value.status === 'broken') return false;
  if (opening) {
    const definition = REPAIR_APPS.find(app => app.id === appId);
    if (!definition || !same(value, artifact(appId, `opening-${appId}`, definition.source, 'broken'))) return false;
  }
  if (!same(value, artifact(appId, value.id, value.source, value.status))) return false;
  return value.status !== 'accepted' || value.passed === value.total;
}
function validReceipt(receipt) {
  if (!object(receipt) || !/^repair-[1-9]\d*$/.test(receipt.id) || !same(receipt.params, validateRepairParams(receipt.action, receipt.params)) || receipt.app_id !== receipt.params.app_id) return false;
  const number = Number(receipt.id.slice(7));
  if (!validArtifact(receipt.app_id, receipt.before, receipt.before.id.startsWith('opening-')) || receipt.before.status === 'rejected') return false;
  if (receipt.before.id.startsWith('patch-') && Number(receipt.before.id.slice(6)) >= number) return false;
  if (receipt.action === 'inspect') return receipt.candidate === null && receipt.verdict === 'inspected' && receipt.requeued === false && receipt.reason === 'The deployed source was executed against the fixed regression suite.';
  const candidate = artifact(receipt.app_id, `patch-${number}`, receipt.params.source, 'rejected');
  const passing = candidate.passed === candidate.total, changed = candidate.source !== receipt.before.source;
  const verdict = passing && changed ? 'accepted' : 'rejected'; candidate.status = verdict;
  const reason = !passing ? 'The proposed source failed one or more independent regression fixtures.' : !changed ? 'The submitted source is already deployed; it contains no source change.' : 'All independent regression fixtures passed; the new source is deployed.';
  return same(receipt.candidate, candidate) && receipt.verdict === verdict && receipt.reason === reason && receipt.requeued === (verdict === 'rejected');
}
/** Recompute source execution, reviewer receipts, counters and latest working versions. */
export function validateRepairWorld(world) {
  const errors = [];
  try {
    if (!object(world)) return { valid: false, errors: ['Missing repair world.'] };
    const initial = initializeRepair();
    if (world.evidence_scope !== initial.evidence_scope) errors.push('Repair evidence scope changed.');
    for (const key of COUNTERS) { integer(world[key]); integer(world.archived_records?.[key]); }
    if (!same(Object.keys(world.archived_records).sort(), [...COUNTERS].sort())) errors.push('Unknown archived repair counters.');
    if (world.decisions !== world.inspections + world.patches_tested || world.patches_tested !== world.accepted_patches + world.rejected_patches) errors.push('Repair cumulative counts do not reconcile.');
    if (!Array.isArray(world.records) || world.records.length !== Math.min(RECORD_LIMIT, world.decisions)) errors.push('Repair record window does not reconcile.');
    else {
      for (const [index, receipt] of world.records.entries()) if (receipt.id !== `repair-${world.decisions - world.records.length + index + 1}` || !validReceipt(receipt)) errors.push('Repair source or recomputed reviewer receipt is invalid.');
      for (const key of COUNTERS) if (world[key] !== world.archived_records[key] + world.records.reduce((sum, receipt) => sum + recordCounts(receipt)[key], 0)) errors.push(`Repair ${key} differs from its retained and archived receipts.`);
      if (!same(world.latest_record, world.records.at(-1) || null) || !same(world.agent_memory, memoryFor(world.records))) errors.push('Repair latest receipt or memory differs from measured evidence.');
    }
    if (!Array.isArray(world.apps) || world.apps.length !== REPAIR_APPS.length || !same(world.apps.map(app => app.id), APP_IDS)) errors.push('Repair apps changed.');
    else for (const [index, app] of world.apps.entries()) {
      const original = initial.apps[index];
      for (const key of ['id', 'title', 'spec', 'inputs', 'fixtures', 'original']) if (!same(app[key], original[key])) errors.push('Repair original program or independent golden examples changed.');
      for (const key of ['patches_tested', 'accepted_patches', 'rejected_patches', 'archived_versions', 'last_patch_decision', 'last_accepted_decision']) integer(app[key]);
      if (app.patches_tested !== app.accepted_patches + app.rejected_patches || app.last_patch_decision > world.decisions || app.last_accepted_decision > app.last_patch_decision || (app.accepted_patches === 0) !== (app.last_accepted_decision === 0) || (app.patches_tested === 0) !== (app.last_patch_decision === 0)) errors.push('App patch counts or sequence differ.');
      if (!validArtifact(app.id, app.current, app.last_accepted_decision === 0) || app.current.id !== (app.last_accepted_decision ? `patch-${app.last_accepted_decision}` : `opening-${app.id}`) || (app.last_accepted_decision && app.current.status !== 'accepted')) errors.push('Deployed app source is invalid.');
      if (!Array.isArray(app.versions) || app.versions.length !== Math.min(VERSION_LIMIT, app.patches_tested) || app.versions.length + app.archived_versions !== app.patches_tested) errors.push('App source version window differs.');
      else {
        for (const [i, version] of app.versions.entries()) if (!validArtifact(app.id, version) || Number(version.id.slice(6)) > app.last_patch_decision || (i && Number(app.versions[i - 1].id.slice(6)) >= Number(version.id.slice(6)))) errors.push('App retained version is not a reproducible source artifact.');
        if (app.patches_tested && app.versions.at(-1).id !== `patch-${app.last_patch_decision}`) errors.push('App latest attempted source is missing.');
        const latest = app.versions.at(-1);
        if (app.status !== (latest?.status === 'accepted' ? 'repaired' : 'queued')) errors.push('App queue verdict differs.');
        const lastAccepted = app.versions.findLast(version => version.status === 'accepted');
        if (lastAccepted && (Number(lastAccepted.id.slice(6)) !== app.last_accepted_decision || !same(lastAccepted, app.current))) errors.push('App current source differs from latest accepted version.');
        if (app.versions.filter(version => version.status === 'accepted').length > app.accepted_patches || app.versions.filter(version => version.status === 'rejected').length > app.rejected_patches) errors.push('App recent verdict counts exceed cumulative measured attempts.');
        for (const receipt of world.records.filter(receipt => receipt.app_id === app.id && receipt.action === 'repair')) {
          const saved = app.versions.find(version => version.id === receipt.candidate.id);
          if (saved && !same(saved, receipt.candidate)) errors.push('App artifact differs from its immutable reviewer receipt.');
        }
        const relevant = world.records.filter(receipt => receipt.app_id === app.id);
        for (let i = 1; i < relevant.length; i++) if (!same(relevant[i].before, relevant[i - 1].verdict === 'accepted' ? relevant[i - 1].candidate : relevant[i - 1].before)) errors.push('Repair receipts do not preserve the deployed source across decisions.');
        if (relevant.length && !same(app.current, relevant.at(-1).verdict === 'accepted' ? relevant.at(-1).candidate : relevant.at(-1).before)) errors.push('App current source differs from its latest receipt.');
      }
    }
    if (Array.isArray(world.apps)) {
      if (!same(world.queue, world.apps.filter(app => app.status === 'queued').map(app => app.id))) errors.push('Repair queue does not match app outcomes.');
      for (const key of ['patches_tested', 'accepted_patches', 'rejected_patches']) if (world[key] !== world.apps.reduce((sum, app) => sum + app[key], 0)) errors.push('Repair world totals differ from app totals.');
    }
    if (world.decisions === 0 && !same(world, initial)) errors.push('Repair opening state contains invented activity.');
  } catch (error) { errors.push(`Malformed repair data: ${error.message}`); }
  return { valid: errors.length === 0, errors };
}
