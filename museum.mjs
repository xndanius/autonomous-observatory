/** A fictional museum with reproducible consistency checks. No external sources or I/O. */
const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : record(value) ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const same = (a, b) => canonical(a) === canonical(b);
const metric = (label, value, unit = '') => ({ label, value, unit });
const LIMIT = 12;
const ARTIFACT_LIMIT = 48;
const EVIDENCE_LIMIT = 24;
const SCOPE = 'internal consistency within fictional premises';
const COUNTERS = ['decisions', 'proposals_tested', 'accepted_proposals', 'rejected_proposals', 'excavations', 'revisions'];

export const MUSEUM_CIVILIZATION = Object.freeze({ name: 'Tideglass', facts: [
  { id: 'resources', label: 'Salt-marsh resources', text: 'Tideglass communities have clay, reed and shell. Copper arrives by exchange from year 140. No iron ore or glassmaking exists in this fictional civilization.', scope: 'fictional premise' },
  { id: 'chronology', label: 'Technology has a date', text: 'The settlement chronology spans years 0–239. Hand shaping and reed weaving exist from year 0, kiln firing from year 80, copper casting from year 140, and irrigation works from year 160.', scope: 'fictional premise' },
  { id: 'writing', label: 'Tally script', text: 'Writing begins in year 110 as groups of one to nine tally strokes on clay, shell or copper. Earlier decoration is possible, but it is not writing.', scope: 'fictional premise' },
] });
export const MUSEUM_MATERIALS = [
  { id: 'clay', label: 'Clay', color: '#ba7653' }, { id: 'reed', label: 'Reed', color: '#b1aa64' },
  { id: 'shell', label: 'Shell', color: '#e4dbbd' }, { id: 'copper', label: 'Copper', color: '#a26845' },
  { id: 'iron', label: 'Iron (unavailable)', color: '#66757e' },
];
const FORMS = ['vessel', 'tablet', 'tool', 'ornament'];
const PURPOSES = ['storage', 'recording', 'irrigation', 'ceremony'];
export const MUSEUM_TECHNOLOGIES = [
  { id: 'hand-shaping', label: 'Hand shaping', from_year: 0, materials: ['clay', 'shell'], forms: FORMS },
  { id: 'weaving', label: 'Reed weaving', from_year: 0, materials: ['reed'], forms: ['vessel', 'tool', 'ornament'] },
  { id: 'kiln-firing', label: 'Kiln firing', from_year: 80, materials: ['clay'], forms: FORMS },
  { id: 'copper-casting', label: 'Copper casting', from_year: 140, materials: ['copper'], forms: ['tool', 'ornament'] },
  { id: 'iron-forging', label: 'Iron forging (unsupported)', from_year: 260, materials: ['iron'], forms: ['tool'] },
];
export const MUSEUM_CHRONOLOGY = [
  { id: 'marsh', label: 'Marsh settlement', start_year: 0, end_year: 79 },
  { id: 'kilns', label: 'Kilns and tally script', start_year: 80, end_year: 139 },
  { id: 'canals', label: 'Copper exchange and canals', start_year: 140, end_year: 239 },
];
export const MUSEUM_SITES = ['marsh', 'canal', 'exchange'].map((id, i) => ({ id,
  label: ['Marsh settlement', 'Canal workshop', 'Exchange quay'][i], layers: [
    { id: 'lower', label: 'Lower deposit', start_year: 0, end_year: 79, materials: ['clay', 'reed', 'shell'] },
    { id: 'middle', label: 'Middle deposit', start_year: 80, end_year: 139, materials: ['clay', 'reed', 'shell'] },
    { id: 'upper', label: 'Upper deposit', start_year: 140, end_year: 239, materials: ['clay', 'reed', 'shell', 'copper'] },
  ] }));
const enumSchema = values => ({ type: 'string', required: true, enum: values });
const proposalSchema = {
  name: { type: 'string', required: true, maxLength: 80 }, year: { type: 'integer', required: true, min: 0, max: 300 },
  material: enumSchema(MUSEUM_MATERIALS.map(v => v.id)), technology: enumSchema(MUSEUM_TECHNOLOGIES.map(v => v.id)),
  form: enumSchema(FORMS), purpose: enumSchema(PURPOSES), site: enumSchema(MUSEUM_SITES.map(v => v.id)),
  layer: enumSchema(['lower', 'middle', 'upper']), motif_count: { type: 'integer', required: true, min: 0, max: 12 },
  inscription_marks: { type: 'integer', required: true, min: 0, max: 9 }, evidence_id: { type: 'string', required: true, maxLength: 80 },
};
export const MUSEUM_ACTIONS = [
  { action: 'propose', label: 'Submit an artifact', description: 'Design a bounded object and test its material, technology, chronology and context against retained evidence. A failed consistency check is a recorded rejection.', params: proposalSchema },
  { action: 'excavate', label: 'Excavate a deposit', description: 'Compute one dated specimen and a narrow evidence context from a selected fictional deposit. The specimen is evidence, not an accepted authored proposal.', params: { site: proposalSchema.site, layer: proposalSchema.layer } },
  { action: 'revise', label: 'Revise an interpretation', description: 'Test a replacement interpretation of a proposal retained in the last twelve records. The earlier verdict stays in history.', params: { proposal_id: { type: 'string', required: true, maxLength: 80 }, ...proposalSchema } },
];
function keys(value, allowed, field) {
  if (!record(value)) throw new TypeError(`${field} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new RangeError(`Unknown ${field} parameter: ${key}.`);
}
function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}
function string(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new TypeError(`${field} must be a nonempty string of at most 80 characters.`);
  return value.trim();
}
export function validateMuseumParams(action, params) {
  const schema = MUSEUM_ACTIONS.find(v => v.action === action)?.params;
  if (!schema) throw new RangeError('Unsupported civilization-museum action.');
  keys(params, Object.keys(schema), 'museum');
  const normalized = {};
  for (const [field, rule] of Object.entries(schema)) {
    if (rule.type === 'integer') normalized[field] = integer(params[field], rule.min, rule.max, field);
    else { normalized[field] = string(params[field], field); if (rule.enum && !rule.enum.includes(normalized[field])) throw new RangeError(`Unknown ${field}.`); }
  }
  return normalized;
}
function layerFor(site, layer) { return MUSEUM_SITES.find(s => s.id === site)?.layers.find(l => l.id === layer); }
function survey(site, layer) {
  const stratum = layerFor(site, layer);
  return { id: `survey-${site}-${layer}`, kind: 'survey', site, layer,
    start_year: stratum.start_year, end_year: stratum.end_year, materials: clone(stratum.materials), scope: 'constructed fictional deposit' };
}
const openingEvidence = () => [survey('marsh', 'lower'), survey('canal', 'middle'), survey('exchange', 'upper')];
const BASE_PATHS = {
  vessel: 'M52 24 L108 24 L101 42 Q128 66 115 112 Q80 132 45 112 Q32 66 59 42 Z',
  tablet: 'M37 23 L121 26 L126 113 L34 118 Z',
  tool: 'M72 24 L90 24 L89 69 L121 84 L112 99 L87 89 L88 121 L72 121 Z',
  ornament: 'M80 22 L127 70 L80 120 L33 70 Z',
};
/** All geometry is generated here from finite forms and bounded counts, never user markup. */
export function museumDisplay(params) {
  return { view_box: [0, 0, 160, 140], base: { type: 'path', d: BASE_PATHS[params.form] },
    fill: MUSEUM_MATERIALS.find(v => v.id === params.material).color, stroke: '#383631',
    motifs: Array.from({ length: params.motif_count }, (_, i) => ({ type: 'circle', cx: 56 + (i % 4) * 16, cy: 56 + Math.floor(i / 4) * 12, r: 3 })),
    marks: Array.from({ length: params.inscription_marks }, (_, i) => ({ type: 'line', x1: 49 + i * 7, y1: 92, x2: 49 + i * 7, y2: 103 })) };
}
function excavatedEvidence(site, layer, number) {
  const stratum = layerFor(site, layer);
  const year = stratum.start_year + ((number * 17 + site.length * 3) % (stratum.end_year - stratum.start_year + 1));
  const material = stratum.materials[(number + site.length) % stratum.materials.length];
  const technology = material === 'copper' ? 'copper-casting' : material === 'reed' ? 'weaving' : material === 'clay' && year >= 80 ? 'kiln-firing' : 'hand-shaping';
  const form = material === 'copper' ? 'ornament' : material === 'shell' ? 'tablet' : 'vessel';
  const inscription_marks = year >= 110 && material !== 'reed' ? 1 + number % 9 : 0;
  const params = { name: `Deposit specimen ${number}`, year, material, technology, form,
    purpose: inscription_marks ? 'recording' : 'storage', site, layer, motif_count: number % 13, inscription_marks, evidence_id: `dig-${number}` };
  return { id: `dig-${number}`, kind: 'excavation', excavation_number: number, site, layer,
    start_year: Math.max(stratum.start_year, year - 5), end_year: Math.min(stratum.end_year, year + 5), materials: [material],
    scope: 'computed fictional specimen', specimen: { ...params, id: `specimen-${number}`, status: 'excavated', display: museumDisplay(params) } };
}
export function checkMuseumProposal(params, evidence) {
  const technology = MUSEUM_TECHNOLOGIES.find(t => t.id === params.technology);
  const stratum = layerFor(params.site, params.layer);
  const check = (id, label, passed, yes, no) => ({ id, label, passed, reason: passed ? yes : no });
  const checks = [
    check('civilization-date', 'Settlement chronology', params.year <= 239, 'Date falls within fictional years 0–239.', 'Date falls outside fictional years 0–239.'),
    check('resource', 'Available material', params.material !== 'iron' && (params.material !== 'copper' || params.year >= 140), 'Material is available at the proposed date.', 'Iron is unavailable; exchanged copper begins in year 140.'),
    check('technology-date', 'Technology chronology', params.technology !== 'iron-forging' && params.year >= technology.from_year, 'Technology exists by the proposed date.', `${technology.label} is unavailable at year ${params.year}.`),
    check('construction', 'Material and form', technology.materials.includes(params.material) && technology.forms.includes(params.form), 'Material and form fit the selected construction process.', 'Selected process cannot construct this material and form.'),
    check('script', 'Tally writing', params.inscription_marks === 0 || (params.year >= 110 && ['clay', 'shell', 'copper'].includes(params.material)), 'Tally strokes respect the fictional script date and surfaces.', 'Writing requires year 110 or later and a clay, shell or copper surface.'),
    check('purpose', 'Claimed purpose', (params.purpose !== 'recording' || params.inscription_marks > 0) && (params.purpose !== 'irrigation' || (params.year >= 160 && ['tool', 'vessel'].includes(params.form))), 'Purpose meets the explicit recording or irrigation constraints.', 'Recording needs tally strokes; irrigation needs year 160 or later and a tool or vessel.'),
    check('stratum', 'Deposit chronology', params.year >= stratum.start_year && params.year <= stratum.end_year, 'Date fits the selected deposit.', `Selected deposit spans years ${stratum.start_year}–${stratum.end_year}.`),
    check('evidence-context', 'Evidence provenance', evidence.site === params.site && evidence.layer === params.layer, 'Cited retained evidence comes from this deposit.', 'Cited evidence belongs to another site or deposit.'),
    check('evidence-date', 'Measured date window', params.year >= evidence.start_year && params.year <= evidence.end_year, 'Date fits the cited evidence window.', `Cited evidence spans years ${evidence.start_year}–${evidence.end_year}.`),
    check('evidence-material', 'Observed material', evidence.materials.includes(params.material), 'Material occurs in the cited constructed evidence.', 'Material is absent from the cited constructed evidence.'),
  ];
  return { status: checks.every(c => c.passed) ? 'accepted' : 'rejected', checks, scope: SCOPE };
}
export function initializeMuseum() {
  return { civilization: clone(MUSEUM_CIVILIZATION), chronology: clone(MUSEUM_CHRONOLOGY), materials: clone(MUSEUM_MATERIALS),
    technologies: clone(MUSEUM_TECHNOLOGIES), sites: clone(MUSEUM_SITES), evidence: openingEvidence(), artifacts: [], records: [], contradictions: [], latest_record: null,
    ...Object.fromEntries(COUNTERS.map(k => [k, 0])), archived_records: Object.fromEntries(COUNTERS.map(k => [k, 0])), archived_artifacts: 0, archived_evidence: 0,
    evidence_scope: 'These are fictional premises and computed deposits. Accepted means consistent with these inputs; it does not establish real history, authenticity, artistic merit or cultural significance.',
    agent_memory: { last_results: [], watch: 'Use a starting survey to propose an object, or excavate a deposit for a narrower material and date experiment.' } };
}
function counts(trial) {
  return { decisions: 1, proposals_tested: trial.action === 'excavate' ? 0 : 1, accepted_proposals: trial.verdict.status === 'accepted' ? 1 : 0,
    rejected_proposals: trial.verdict.status === 'rejected' ? 1 : 0, excavations: trial.action === 'excavate' ? 1 : 0, revisions: trial.action === 'revise' ? 1 : 0 };
}
function memoryFor(records) {
  return { last_results: records.slice(-6).map(r => ({ id: r.id, action: r.action, name: r.artifact?.name, verdict: r.verdict.status,
    failed_checks: r.verdict.checks.filter(c => !c.passed).map(c => c.id) })),
    watch: records.at(-1)?.verdict.status === 'rejected' ? 'Revise a retained rejection using its failed checks, or excavate a more suitable deposit. A rejection is useful evidence, not a task failure.'
      : 'Contrast an accepted interpretation with a different date, material or excavation. Consistency does not prove a historical or artistic claim.' };
}
/** Invalid schemas throw atomically. Historically inconsistent proposals produce legitimate rejected records. */
export function applyMuseumDecision(prior, decision) {
  const report = validateMuseumWorld(prior);
  if (!report.valid) throw new Error(`Invalid museum world: ${report.errors.join('; ')}`);
  const params = validateMuseumParams(decision.action, decision.params);
  const world = clone(prior);
  const id = `museum-${world.decisions + 1}`;
  let artifact, evidence_context, verdict, revision_of;
  if (decision.action === 'excavate') {
    evidence_context = excavatedEvidence(params.site, params.layer, world.excavations + 1);
    artifact = clone(evidence_context.specimen);
    verdict = { status: 'excavated', checks: [{ id: 'computed-deposit', label: 'Computed deposit', passed: true, reason: `Computed specimen is dated ${artifact.year}; its ${artifact.material} occurs in the selected fictional layer.` }], scope: SCOPE };
    world.evidence.push(clone(evidence_context));
    if (world.evidence.length > EVIDENCE_LIMIT) { world.evidence.shift(); world.archived_evidence += 1; }
  } else {
    evidence_context = world.evidence.find(e => e.id === params.evidence_id);
    if (!evidence_context) throw new RangeError('evidence_id must cite retained museum evidence.');
    if (decision.action === 'revise') {
      const previous = world.records.find(r => r.id === params.proposal_id && r.action !== 'excavate');
      if (!previous) throw new RangeError('proposal_id must identify a proposal in the retained twelve-record window.');
      revision_of = previous.id;
    }
    verdict = checkMuseumProposal(params, evidence_context);
    const { proposal_id, ...design } = params;
    artifact = { ...design, id, status: verdict.status, display: museumDisplay(design), evidence_context: clone(evidence_context) };
    if (revision_of) artifact.revision_of = revision_of;
    if (verdict.status === 'accepted') {
      world.artifacts.push(clone(artifact));
      if (world.artifacts.length > ARTIFACT_LIMIT) { world.artifacts.shift(); world.archived_artifacts += 1; }
    }
  }
  const trial = { id, action: decision.action, params, artifact, evidence_context: clone(evidence_context), verdict };
  if (revision_of) trial.revision_of = revision_of;
  for (const [key, count] of Object.entries(counts(trial))) world[key] += count;
  world.records.push(clone(trial));
  if (world.records.length > LIMIT) for (const [key, count] of Object.entries(counts(world.records.shift()))) world.archived_records[key] += count;
  if (verdict.status === 'rejected') world.contradictions = [...world.contradictions, clone(trial)].slice(-LIMIT);
  world.latest_record = clone(trial);
  world.agent_memory = memoryFor(world.records);
  const failures = verdict.checks.filter(c => !c.passed);
  return { world, actor: decision.action === 'excavate' ? 'Museum excavation team' : 'Artifact designer and consistency curator',
    observation: `${prior.proposals_tested} proposals tested; ${prior.accepted_proposals} accepted, ${prior.rejected_proposals} rejected; ${prior.excavations} deposits sampled.`,
    consequences: [`${artifact.name}: ${verdict.status}; ${verdict.checks.filter(c => c.passed).length}/${verdict.checks.length} explicit checks passed.`,
      ...failures.map(c => c.reason), 'Verdicts concern this invented chronology and evidence, not external historical authenticity.'],
    evidence: [metric('Curator outcome', verdict.status), metric('Checks passed', verdict.checks.filter(c => c.passed).length), metric('Checks failed', failures.length),
      metric('Artifact year', artifact.year, 'fictional year'), metric('Material', artifact.material), metric('Evidence cited', evidence_context.id)],
    learned: [`${id}: ${artifact.name} ${verdict.status}${failures.length ? `; revise ${failures.map(c => c.id).join(', ')}` : ''}.`] };
}
export function museumMetrics(world) {
  return [metric('Proposals tested', world.proposals_tested), metric('Accepted proposals', world.accepted_proposals), metric('Rejected proposals', world.rejected_proposals),
    metric('Excavations', world.excavations), metric('Revisions tested', world.revisions), metric('Retained accepted artifacts', world.artifacts.length), metric('Retained evidence', world.evidence.length)];
}
export function museumSnapshot(world) {
  const { records, ...current } = world;
  return { world: clone(current), latest_record: clone(world.latest_record), artifacts: clone(world.artifacts), metrics: museumMetrics(world) };
}
function validEvidence(e) {
  if (!record(e)) return false;
  if (e.kind === 'survey') return layerFor(e.site, e.layer) && same(e, survey(e.site, e.layer));
  return e.kind === 'excavation' && Number.isSafeInteger(e.excavation_number) && e.excavation_number > 0 && layerFor(e.site, e.layer)
    && same(e, excavatedEvidence(e.site, e.layer, e.excavation_number));
}
function validTrial(trial) {
  const params = validateMuseumParams(trial.action, trial.params);
  if (!same(params, trial.params) || !/^museum-[1-9]\d*$/.test(trial.id) || !validEvidence(trial.evidence_context)) return false;
  if (trial.action === 'excavate') {
    const e = trial.evidence_context;
    return e.kind === 'excavation' && e.site === params.site && e.layer === params.layer && same(trial.artifact, e.specimen)
      && same(trial.verdict, { status: 'excavated', checks: [{ id: 'computed-deposit', label: 'Computed deposit', passed: true, reason: `Computed specimen is dated ${e.specimen.year}; its ${e.specimen.material} occurs in the selected fictional layer.` }], scope: SCOPE });
  }
  const expected = checkMuseumProposal(params, trial.evidence_context);
  const { proposal_id, ...design } = params;
  const artifact = { ...design, id: trial.id, status: expected.status, display: museumDisplay(design), evidence_context: clone(trial.evidence_context) };
  if (trial.action === 'revise') {
    if (trial.revision_of !== proposal_id || !/^museum-[1-9]\d*$/.test(proposal_id) || Number(proposal_id.slice(7)) >= Number(trial.id.slice(7)) || Number(proposal_id.slice(7)) < Number(trial.id.slice(7)) - LIMIT) return false;
    artifact.revision_of = proposal_id;
  } else if (trial.revision_of !== undefined) return false;
  return trial.evidence_context.id === params.evidence_id && same(trial.verdict, expected) && same(trial.artifact, artifact);
}
/** Semantic comparisons survive sorted R2 object keys; arrays remain ordered evidence. */
export function validateMuseumWorld(world) {
  const errors = [];
  try {
    if (!record(world)) return { valid: false, errors: ['Missing museum world.'] };
    const initial = initializeMuseum();
    for (const key of ['civilization', 'chronology', 'materials', 'technologies', 'sites', 'evidence_scope']) if (!same(world[key], initial[key])) errors.push(`Museum fictional ${key} premises changed.`);
    for (const key of [...COUNTERS, 'archived_artifacts', 'archived_evidence']) integer(world[key], 0, Number.MAX_SAFE_INTEGER, key);
    keys(world.archived_records, COUNTERS, 'archived_records');
    for (const key of COUNTERS) integer(world.archived_records[key], 0, Number.MAX_SAFE_INTEGER, `archived_records.${key}`);
    if (world.decisions !== world.proposals_tested + world.excavations || world.proposals_tested !== world.accepted_proposals + world.rejected_proposals || world.revisions > world.proposals_tested) errors.push('Museum cumulative decision counts do not reconcile.');
    if (!Array.isArray(world.records) || world.records.length !== Math.min(LIMIT, world.decisions)) errors.push('Museum record window does not reconcile.');
    else {
      let excavationNumber = world.archived_records.excavations;
      for (const [i, trial] of world.records.entries()) {
        if (trial.id !== `museum-${world.decisions - world.records.length + i + 1}` || !validTrial(trial)) errors.push('Museum record or recomputed curator checks are invalid.');
        if (trial.action === 'excavate' && trial.evidence_context.excavation_number !== ++excavationNumber) errors.push('Museum excavation sequence is invalid.');
      }
      for (const key of COUNTERS) if (world[key] !== world.archived_records[key] + world.records.reduce((n, trial) => n + counts(trial)[key], 0)) errors.push(`Museum ${key} does not match retained and archived evidence.`);
      if (world.decisions ? !same(world.latest_record, world.records.at(-1)) : world.latest_record !== null) errors.push('Museum latest record does not match its history.');
      if (world.decisions && !same(world.agent_memory, memoryFor(world.records))) errors.push('Museum compact memory does not match measured results.');
    }
    if (!Array.isArray(world.evidence) || world.evidence.length !== Math.min(EVIDENCE_LIMIT, 3 + world.excavations) || world.evidence.length + world.archived_evidence !== 3 + world.excavations || world.evidence.some(e => !validEvidence(e)) || new Set(world.evidence.map(e => e.id)).size !== world.evidence.length) errors.push('Museum excavation evidence does not reconcile.');
    else {
      const expected = [...openingEvidence().map(e => e.id), ...Array.from({ length: Math.min(world.excavations, EVIDENCE_LIMIT) }, (_, i) => `dig-${world.excavations - Math.min(world.excavations, EVIDENCE_LIMIT) + i + 1}`)].slice(-EVIDENCE_LIMIT);
      if (!same(world.evidence.map(e => e.id), expected)) errors.push('Museum evidence sequence is invalid.');
    }
    if (!Array.isArray(world.artifacts) || world.artifacts.length !== Math.min(ARTIFACT_LIMIT, world.accepted_proposals) || world.artifacts.length + world.archived_artifacts !== world.accepted_proposals) errors.push('Museum accepted collection counts do not reconcile.');
    else for (const [i, a] of world.artifacts.entries()) {
      const { id, status, display, revision_of, evidence_context, ...params } = a;
      validateMuseumParams('propose', params);
      if (!/^museum-[1-9]\d*$/.test(id) || Number(id.slice(7)) > world.decisions || (i && Number(world.artifacts[i - 1].id.slice(7)) >= Number(id.slice(7))) || status !== 'accepted' || !same(display, museumDisplay(params))) errors.push('Museum accepted artifact display or identity is invalid.');
      if (!validEvidence(evidence_context) || evidence_context.id !== params.evidence_id || checkMuseumProposal(params, evidence_context).status !== 'accepted') errors.push('Museum collection contains an unsupported artifact.');
      const retained = world.records.find(r => r.id === id);
      if (retained && !same(retained.artifact, a)) errors.push('Museum accepted artifact differs from its retained trial.');
    }
    if (!Array.isArray(world.contradictions) || world.contradictions.length !== Math.min(LIMIT, world.rejected_proposals) || world.contradictions.some(r => r.verdict.status !== 'rejected' || !validTrial(r))) errors.push('Museum rejected evidence is invalid.');
    if (world.decisions === 0 && (!same(world, initial))) errors.push('Museum opening state contains invented activity.');
  } catch (error) { errors.push(`Malformed museum data: ${error.message}`); }
  return { valid: errors.length === 0, errors };
}
