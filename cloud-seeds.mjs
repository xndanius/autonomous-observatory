/** Pure hourly instance factory. No credentials, model calls, filesystem or I/O. */
import { createExperiment, toPublicExperiment, TYPE_CATALOG } from './engine.mjs';

export const CLOUD_SEEDED_TYPES = Object.freeze([
  'alien-language', 'invention-league', 'bicycle-company', 'flood-city', 'life-research',
]);

const GOALS = Object.freeze({
  'alien-language': 'Within a 12-decision campaign, infer the seeded vocabulary, word order and past marker from chosen observations; submit a complete grammar and measure it against all nine withheld sentences without claiming untested accuracy.',
  'invention-league': 'Within a 12-decision campaign, find a routing heuristic with fewer total training steps than the seeded column-order baseline and no increase in withheld steps; preserve actual shortest-path replays as evidence.',
  'bicycle-company': 'Keep the seeded workshop solvent throughout a 12-decision campaign while completing repairs, responding to supplier prices and maintaining exact cash, inventory and equity reconciliation.',
  'flood-city': 'Over a 12-decision campaign, use the seeded opening water and wear to coordinate drainage, household relief and the treasury against announced rain; measure unserved household-events, equity and spending with conserved water.',
  'life-research': 'Within a 12-decision campaign, test the seeded starting cells and deliberate variants over bounded observation windows; state falsifiable behavior hypotheses, reproduce each run by translation and record measured results without claiming an unobserved period.',
});

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A deterministic content fingerprint, not a cryptographic integrity claim. */
function fingerprint(value) {
  const source = canonical(value);
  return [2166136261, 3339675911, 2716044179, 1442695041].map(initial => {
    let hash = initial;
    for (const character of source) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

/**
 * scheduledAt is the actual preparation time. sequence is the persisted count of
 * cloud launches, starting at zero; repeating the same inputs is retry-safe.
 * Existing instances are read only. Their deterministic openings are reconstructed
 * solely to avoid launching the same visible starting world under another title.
 * All selected types already exist in TYPE_CATALOG; an instance is not a new type.
 */
export function createSeededCloudLaunch({ scheduledAt, sequence = 0, existingExperiments = [] } = {}) {
  if (typeof scheduledAt !== 'string' || !Number.isFinite(Date.parse(scheduledAt))) throw new TypeError('scheduledAt must be an ISO date string.');
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('sequence must be a nonnegative safe integer.');
  if (!Array.isArray(existingExperiments)) throw new TypeError('existingExperiments must be an array.');
  const at = new Date(scheduledAt).toISOString();
  const hour = new Date(Math.floor(Date.parse(at) / 3600000) * 3600000).toISOString();
  const type = CLOUD_SEEDED_TYPES[sequence % CLOUD_SEEDED_TYPES.length];
  const catalog = TYPE_CATALOG[type];
  const goal = GOALS[type];
  const priorOpenings = new Set();
  const priorIds = new Set();
  for (const prior of existingExperiments) {
    if (!record(prior) || typeof prior.id !== 'string') throw new TypeError('Existing experiments must include an id.');
    priorIds.add(prior.id);
    if (prior.type === type) {
      const opening = createExperiment({ id: prior.id, type, createdAt: prior.created_at ?? at, ...(prior.seed !== undefined ? { seed: prior.seed } : {}) });
      priorOpenings.add(canonical(toPublicExperiment(opening).world));
    }
  }
  for (let variant = 0; variant < 128; variant += 1) {
    const seed = { version: 1, value: `cloud-hour:${hour}:instance:${sequence}:variant:${variant}` };
    const seedDigest = fingerprint({ type, seed });
    const id = `${type}-cloud-${sequence}-${seedDigest.slice(0, 16)}`;
    const title = `${catalog.title} · Seeded instance ${sequence + 1}`;
    const campaign_turn_limit = 12;
    const description = `${catalog.description} This is a new deterministic seeded instance of the existing ${type} environment, with its own starting world and a 12-decision campaign. Campaign completion records the end of observation, without claiming the goal was achieved. Goal: ${goal}`;
    const experiment = createExperiment({ id, type, createdAt: at, title, description, goal, seed, campaign_turn_limit });
    const initial_observation = toPublicExperiment(experiment);
    if (priorIds.has(id) || priorOpenings.has(canonical(initial_observation.world))) continue;
    return { id, type, title, description, reason: `Hourly launch of an existing implemented type (${type}) with distinct deterministic starting conditions and a fresh history. Goal: ${goal}`,
      goal, seed, campaign_turn_limit, at, state_hash: `fnv128:${fingerprint(initial_observation.world)}`, initial_observation, experiment };
  }
  throw new Error('Could not construct a distinct seeded starting world after 128 bounded attempts.');
}
