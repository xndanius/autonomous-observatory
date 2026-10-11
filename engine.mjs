/**
 * Autonomous Observatory's deterministic environments.
 *
 * This module does not call a language model, write files, or make network requests.
 * A caller (Codex, or a visitor's local sandbox) supplies a decision; the environment
 * applies its consequences. Persist the returned JSON, never overwrite prior events.
 * Keep full local state for research. Use toPublicExperiment before publication.
 */

import { initializeLife, applyLifeDecision, lifeMetrics, lifeSnapshot, validateLifeWorld, LIFE_ACTIONS } from './life.mjs';

const PARTS = ['tube', 'chain', 'brake'];
const SERVICES = {
  puncture: { part: 'tube', base_price_cents: 4000 },
  chain: { part: 'chain', base_price_cents: 7500 },
  brakes: { part: 'brake', base_price_cents: 5500 },
};
const BASE_PART_COSTS = { tube: 1000, chain: 2800, brake: 1800 };
const DAILY_OVERHEAD_CENTS = 1200;
const LABOR_CENTS = 800;
const LANGUAGE_SUBJECTS = ['I', 'you', 'we'];
const LANGUAGE_VERBS = ['see', 'carry', 'find'];
const LANGUAGE_OBJECTS = ['star', 'stone', 'water'];
const LANGUAGE_WORDS = [...LANGUAGE_SUBJECTS, ...LANGUAGE_VERBS, ...LANGUAGE_OBJECTS];
const LANGUAGE_RULES = ['word-order', 'past-marker', ...LANGUAGE_WORDS.map(word => `lexicon:${word}`)];
const CITY_IDS = ['hill', 'canal', 'marsh'];
const CITY_RAIN = [4, 1, 3, 6, 2, 2];
const CITY_SEED = [
  { id: 'hill', name: 'Hill Ward', x: 24, y: 24, population: 12, vulnerable: 4, base_drain: 2, wear: 1, water: 0, safe_water: 2, storage_cap: 4 },
  { id: 'canal', name: 'Canal Ward', x: 52, y: 50, population: 10, vulnerable: 2, base_drain: 3, wear: 2, water: 1, safe_water: 2, storage_cap: 5 },
  { id: 'marsh', name: 'Marsh Ward', x: 77, y: 76, population: 8, vulnerable: 4, base_drain: 2, wear: 2, water: 2, safe_water: 1, storage_cap: 6 },
];

const action = (name, label, description, params = {}) => ({ action: name, label, description, params });
const enumeration = (values, required = true) => ({ type: 'string', enum: values, required });
const number = (min, max, required = true) => ({ type: 'number', min, max, required });

/**
 * Add a distinct environment by adding a catalog entry, initializer, transition,
 * snapshot and invariant check below. A new type must have observable state,
 * bounded actions, deterministic consequences and tests; a new title alone is
 * not a new environment. Never put API credentials or claimed model calls here.
 */
export const TYPE_CATALOG = Object.freeze({
  'bicycle-company': {
    title: 'The Bicycle Company',
    description: 'A small workshop manages orders, stock, prices and cash while its supplier changes prices.',
    roles: ['Operations manager', 'Purchasing agent', 'Accountant'],
    memory_window: 64,
    rules: [
      'Starts with €1,200 cash, six tubes, three chains and four brake sets.',
      'Each turn costs €12 overhead. Each completed repair costs €8 labor and one stocked part.',
      'Customer quotes are fixed when an order arrives. Up to three repairs fit in one turn.',
      'Unfinished orders expire after five turns. New demand responds to the posted price.',
      'At the end of every fourth turn the supplier switches between normal and double prices.',
      'Cash plus inventory book value must equal opening equity plus revenue minus expenses.',
    ],
    allowed_actions: [
      action('purchase', 'Buy parts', 'Buy one kind of part at the current supplier price.', {
        part: enumeration(PARTS), quantity: { ...number(1, 30), type: 'integer' },
      }),
      action('service', 'Complete repairs', 'Complete one order, or a batch of up to three waiting orders.', {
        order_id: { type: 'string', required: false },
        order_ids: { type: 'array', items: 'string', maxItems: 3, required: false },
      }),
      action('price', 'Change a price', 'Change the price quoted to future customers, in euros.', {
        service: enumeration(Object.keys(SERVICES)), price: number(10, 250),
      }),
      action('rest', 'Wait and observe', 'Pay overhead and observe arrivals, expirations and supplier news.'),
    ],
  },
  'alien-language': {
    title: 'Alien Language Institute',
    description: 'Researchers choose examples, propose grammar and vocabulary, and test their claims against withheld evidence.',
    roles: ['Researcher', 'Linguist', 'Skeptical reviewer'],
    memory_window: 64,
    rules: [
      'The hidden language has a stable vocabulary, one word order and one past-tense marker.',
      'A probe reveals the translation of one chosen sentence.',
      'A proposed rule is an unverified claim until a validation turn tests it.',
      'Confidence is updated from actual passed and failed checks; it is not a model self-rating.',
      'Held-out sentences stay outside the public state; validation publishes counts and a limited counterexample.',
    ],
    allowed_actions: [
      action('probe', 'Request an example', 'Choose a sentence to translate through the environment oracle.', {
        subject: enumeration(LANGUAGE_SUBJECTS), verb: enumeration(LANGUAGE_VERBS),
        object: enumeration(LANGUAGE_OBJECTS), tense: enumeration(['present', 'past']),
      }),
      action('hypothesize', 'Propose a rule', 'Submit a word order (SOV/SVO/VSO), past marker, or vocabulary entry.', {
        rule: enumeration(LANGUAGE_RULES), answer: { type: 'string', required: true, maxLength: 80 },
      }),
      action('validate', 'Test a hypothesis', 'Test one proposed rule, or the current complete translation system.', {
        rule: enumeration(LANGUAGE_RULES, false),
      }),
    ],
  },
  'invention-league': {
    title: 'Warehouse Invention League',
    description: 'Routing heuristics compete on identical warehouse tasks. A challenger becomes champion only after measured improvement.',
    roles: ['Inventor', 'Benchmark runner', 'Independent referee'],
    memory_window: 64,
    rules: [
      'A robot must visit every pick location and return to the depot; obstacles are impassable.',
      'All path legs use exact shortest paths on the same four-neighbor grid.',
      'Candidate heuristics choose the visit order; lower total walking distance is better.',
      'Four fixed training fixtures and three fixed withheld fixtures evaluate every challenger.',
      'Promotion requires fewer training steps and no regression on the withheld fixtures.',
      'Replays show actual training paths. Held-out locations remain private.',
    ],
    allowed_actions: [
      action('candidate', 'Test a challenger', 'Evaluate a bounded routing heuristic against the current champion.', {
        name: { type: 'string', required: true, maxLength: 80 },
        heuristic: enumeration(['nearest', 'axis', 'sweep', 'lookahead', 'weighted']),
        params: { type: 'object', required: false, properties: {
          distance_weight: number(0.1, 4, false), vertical_weight: number(0, 4, false),
          lookahead_weight: number(0, 2, false),
        } },
      }),
      action('replay', 'Inspect a replay', 'Select a fixed training fixture and replay the champion route.', {
        fixture_id: { type: 'string', required: false },
      }),
      action('rest', 'Review the champion', 'Retain the champion and review its measured results.'),
    ],
  },
  'flood-city': {
    title: 'Flood Commons',
    description: 'A planner, residents’ advocate and budget auditor govern a flood town. Drainage, household relief and unequal exposure produce measured civic tradeoffs.',
    roles: ['Town planner', 'Residents’ advocate', 'Budget auditor'],
    memory_window: 12,
    rules: [
      'This is a simplified deterministic simulation: one rain unit adds one water unit per district; money is civic credits and harm is repeatable unserved household-events, not unique people.',
      'The planner requests clear (3 credits, wear becomes 0) or expand (6 credits, +2 drain capacity, at most 3 upgrades). Residents request relief (2 credits, protects at most 4 actually exposed households this turn).',
      'The auditor releases 0, 4 or 8 credits up to the treasury, processes requests in the chosen priority, and declines requests that do not fit in full. Works happen before rain; funded relief costs money even in a dry district.',
      'Water flows Hill → Canal → Marsh → river. Drain capacity is max(0, base + 2×upgrades − wear − debris); remaining water above the safe threshold exposes min(population, 2×flood units + vulnerable households). Storage overflow passes downstream.',
      'Rain repeats [4,1,3,6,2,2]; every eighth forcing turn adds 4 rain units, and every fifth blocks 3 drain units in a rotating district. Next forcing is public. Optional extra rain (0–6) and extra debris are explicit simulation inputs.',
      'After water and relief, all wear rises by 1 up to 6 and income adds 4 credits, with a treasury cap of 24. Every receipt conserves water and reconciles the treasury. Cumulative household histories start at zero; the city keeps running without a turn cap.',
    ],
    allowed_actions: [action('govern', 'Govern one town turn', 'Coordinate drainage, household relief and the spending envelope against the announced rain.', {
      planner_action: enumeration(['hold', 'clear', 'expand']), planner_district: enumeration(['none', ...CITY_IDS]),
      residents_action: enumeration(['hold', 'relief']), residents_district: enumeration(['none', ...CITY_IDS]),
      spend_limit: { type: 'integer', enum: [0, 4, 8], min: 0, max: 8, required: true },
      priority: enumeration(['infrastructure', 'relief']),
      extra_rain: { ...number(0, 6, false), type: 'integer' }, debris_district: enumeration(['none', ...CITY_IDS], false),
    })],
  },
  'life-research': {
    title: 'The Living Field Station',
    description: 'Researchers propose cellular-life experiments, test periods and motion, and reproduce results in a shifted independent run. A field guide grows from measured evidence.',
    roles: ['Explorer', 'Experimentalist', 'Replication skeptic'],
    memory_window: 12,
    rules: [
      'A 16 × 16 toroidal grid updates all cells simultaneously. Each cell has eight wrapping neighbors; a dead cell is born with three neighbors, and a living cell survives with two or three.',
      'Each experiment declares a template or custom seed, optional cell toggles, a 4–48 generation observation window and a falsifiable hypothesis. Initial and computed generation frames are saved.',
      'Periods and translations are measured from observed frames. An unobserved return remains inconclusive; a finite observation window never proves behavior for all future time.',
      'A separate run starts from a translated seed and checks every observed generation for translation equivariance. Reproduction verifies this deterministic experiment, not an external biological finding.',
      'Every tested seed enters a measured field guide; unknown behavior remains provisional. Submitted hypotheses are confirmed, rejected or unassessed separately. Retired guide entries and all experiments remain in the immutable decision history.',
    ],
    allowed_actions: LIFE_ACTIONS,
  },
});

const clone = value => JSON.parse(JSON.stringify(value));
const euros = cents => cents / 100;
const money = cents => `€${euros(cents).toFixed(2)}`;
const sum = values => values.reduce((a, b) => a + b, 0);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, field, max = 300) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${field} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
};
const timestamp = (value, field) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO date string.`);
  return new Date(value).toISOString();
};
const assertEnum = (value, values, field) => {
  if (!values.includes(value)) throw new RangeError(`${field} must be one of: ${values.join(', ')}.`);
};
const assertNumber = (value, min, max, field, integer = false) => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${field} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
};
const exactKeys = (params, allowed) => {
  if (!isRecord(params)) throw new TypeError('Decision params must be an object.');
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new RangeError(`Unknown parameter: ${key}.`);
};

function hash(value) {
  let h = 2166136261;
  for (const character of String(value)) {
    h ^= character.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function metric(label, value, unit = '') { return { label, value, unit }; }
function inventoryValue(world) { return sum(PARTS.map(part => world.inventory[part].book_value_cents)); }
function ledger(world, turn, kind, deltas, detail) {
  const entry = {
    id: `ledger-${(world.accounting.archived_ledger?.entries ?? 0) + world.accounting.ledger.length + 1}`, turn, kind,
    cash_delta_cents: deltas.cash ?? 0, inventory_delta_cents: deltas.inventory ?? 0,
    revenue_delta_cents: deltas.revenue ?? 0, expense_delta_cents: deltas.expense ?? 0, detail,
  };
  world.cash_cents += entry.cash_delta_cents;
  world.accounting.revenue_cents += entry.revenue_delta_cents;
  world.accounting.expense_cents += entry.expense_delta_cents;
  world.accounting.ledger.push(entry);
  return entry;
}

function companyOrder(id, turn, service, price) {
  return {
    id: `order-${String(id).padStart(4, '0')}`, service, quoted_price_cents: price,
    created_turn: turn, deadline_turn: turn + 5, status: 'waiting',
    parts: { [SERVICES[service].part]: 1 },
  };
}

function initializeCompany() {
  return {
    cash_cents: 120000,
    inventory: {
      tube: { quantity: 6, book_value_cents: 6000 },
      chain: { quantity: 3, book_value_cents: 8400 },
      brake: { quantity: 4, book_value_cents: 7200 },
    },
    prices_cents: Object.fromEntries(Object.entries(SERVICES).map(([key, service]) => [key, service.base_price_cents])),
    supplier: { prices_cents: clone(BASE_PART_COSTS), multiplier: 1, last_shock_turn: 0, next_review_turn: 4 },
    orders: Object.keys(SERVICES).map((service, i) => companyOrder(i + 1, 0, service, SERVICES[service].base_price_cents)),
    next_order_number: 4, completed_orders: 0, expired_orders: 0, rejected_inquiries: 0,
    archived_orders: { completed: 0, expired: 0 },
    accounting: { opening_cash_cents: 120000, opening_inventory_cents: 21600, opening_equity_cents: 141600,
      revenue_cents: 0, expense_cents: 0, ledger: [], archived_ledger: { entries: 0, last_turn: 0,
        cash_delta_cents: 0, inventory_delta_cents: 0, revenue_delta_cents: 0, expense_delta_cents: 0 } },
  };
}

function compactCompany(world) {
  // Cumulative ledger totals remain exact; full turn evidence stays in the immutable
  // timeline. The working world retains recent records rather than every receipt.
  world.archived_orders ??= { completed: 0, expired: 0 };
  const terminal = world.orders.filter(order => order.status !== 'waiting');
  const remove = terminal.slice(0, Math.max(0, terminal.length - 48));
  const ids = new Set(remove.map(order => order.id));
  for (const order of remove) world.archived_orders[order.status] += 1;
  world.orders = world.orders.filter(order => !ids.has(order.id));
  world.accounting.archived_ledger ??= { entries: 0, last_turn: 0,
    cash_delta_cents: 0, inventory_delta_cents: 0, revenue_delta_cents: 0, expense_delta_cents: 0 };
  const old = world.accounting.ledger.splice(0, Math.max(0, world.accounting.ledger.length - 120));
  const archived = world.accounting.archived_ledger;
  for (const entry of old) {
    archived.entries += 1;
    archived.last_turn = entry.turn;
    for (const field of ['cash_delta_cents', 'inventory_delta_cents', 'revenue_delta_cents', 'expense_delta_cents']) archived[field] += entry[field];
  }
}

function observeCompany(world) {
  const waiting = world.orders.filter(order => order.status === 'waiting');
  return `${money(world.cash_cents)} cash; ${waiting.length} waiting orders; stocks ${PARTS.map(part => `${part} ${world.inventory[part].quantity}`).join(', ')}; supplier ${world.supplier.multiplier}× normal prices.`;
}

function transitionCompany(experiment, decision, turn) {
  const world = experiment.world;
  const { action: chosen, params } = decision;
  const result = { observation: observeCompany(world), consequences: [], evidence: [], learned: [], actor: 'Operations manager' };
  if (chosen === 'purchase') {
    exactKeys(params, ['part', 'quantity']);
    assertEnum(params.part, PARTS, 'part');
    assertNumber(params.quantity, 1, 30, 'quantity', true);
    const cost = world.supplier.prices_cents[params.part] * params.quantity;
    if (world.cash_cents < cost + DAILY_OVERHEAD_CENTS) throw new RangeError('Insufficient cash for the purchase and this turn’s overhead.');
    world.inventory[params.part].quantity += params.quantity;
    world.inventory[params.part].book_value_cents += cost;
    ledger(world, turn, 'purchase', { cash: -cost, inventory: cost }, `Bought ${params.quantity} ${params.part} at ${money(world.supplier.prices_cents[params.part])} each.`);
    result.consequences.push(`Purchased ${params.quantity} ${params.part} for ${money(cost)}.`);
    result.evidence.push(metric('Purchase cost', euros(cost), 'EUR'));
    result.actor = 'Purchasing agent';
  } else if (chosen === 'service') {
    exactKeys(params, ['order_id', 'order_ids']);
    if ((params.order_id !== undefined) === (params.order_ids !== undefined)) throw new RangeError('Supply exactly one of order_id or order_ids.');
    const ids = params.order_ids ?? [params.order_id];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw new RangeError('Select one to three distinct order IDs.');
    }
    const orders = ids.map(id => {
      const order = world.orders.find(item => item.id === id && item.status === 'waiting');
      if (!order) throw new RangeError(`${id} is not a waiting order.`);
      return order;
    });
    const needed = Object.fromEntries(PARTS.map(part => [part, orders.filter(order => SERVICES[order.service].part === part).length]));
    for (const part of PARTS) if (needed[part] > world.inventory[part].quantity) throw new RangeError(`Insufficient ${part} stock for this batch.`);
    const revenue = sum(orders.map(order => order.quoted_price_cents));
    if (world.cash_cents + revenue < orders.length * LABOR_CENTS + DAILY_OVERHEAD_CENTS) throw new RangeError('Repair receipts would not cover labor and overhead.');
    let consumed = 0;
    for (const order of orders) {
      const stock = world.inventory[SERVICES[order.service].part];
      const basis = Math.round(stock.book_value_cents / stock.quantity);
      stock.quantity -= 1;
      stock.book_value_cents -= basis;
      consumed += basis;
      order.status = 'completed';
      order.completed_turn = turn;
      order.part_cost_cents = basis;
    }
    const labor = orders.length * LABOR_CENTS;
    world.completed_orders += orders.length;
    ledger(world, turn, 'service', { cash: revenue - labor, inventory: -consumed, revenue, expense: consumed + labor },
      `Completed ${ids.join(', ')}; receipts ${money(revenue)}, parts ${money(consumed)}, labor ${money(labor)}.`);
    result.consequences.push(`Completed ${orders.length} repair${orders.length === 1 ? '' : 's'}; collected ${money(revenue)}; consumed ${money(consumed)} of stock and paid ${money(labor)} labor.`);
    result.evidence.push(metric('Repair receipts', euros(revenue), 'EUR'), metric('Parts consumed', euros(consumed), 'EUR'), metric('Labor paid', euros(labor), 'EUR'));
    result.learned.push(`This batch earned ${money(revenue - consumed - labor)} before daily overhead.`);
  } else if (chosen === 'price') {
    exactKeys(params, ['service', 'price']);
    assertEnum(params.service, Object.keys(SERVICES), 'service');
    assertNumber(params.price, 10, 250, 'price');
    if (Math.abs(params.price * 100 - Math.round(params.price * 100)) > 0.000001) throw new RangeError('Price supports at most two decimal places.');
    const before = world.prices_cents[params.service];
    world.prices_cents[params.service] = Math.round(params.price * 100);
    result.consequences.push(`New ${params.service} quotes changed from ${money(before)} to ${money(world.prices_cents[params.service])}; existing quotes stay fixed.`);
    result.evidence.push(metric('New quoted price', params.price, 'EUR'));
  } else if (chosen === 'rest') {
    exactKeys(params, []);
    result.consequences.push('No repair or purchase was made.');
    result.actor = 'Accountant';
  } else throw new RangeError(`Unsupported bicycle-company action: ${chosen}.`);

  ledger(world, turn, 'overhead', { cash: -DAILY_OVERHEAD_CENTS, expense: DAILY_OVERHEAD_CENTS }, 'Daily workshop overhead.');
  result.consequences.push(`Paid ${money(DAILY_OVERHEAD_CENTS)} overhead.`);
  const expired = world.orders.filter(order => order.status === 'waiting' && turn >= order.deadline_turn);
  for (const order of expired) { order.status = 'expired'; order.expired_turn = turn; }
  world.expired_orders += expired.length;
  if (expired.length) {
    result.consequences.push(`${expired.length} overdue order${expired.length === 1 ? '' : 's'} expired without receipts.`);
    result.learned.push(`Customers abandoned ${expired.map(order => order.id).join(', ')} after five waiting turns.`);
  }
  const arrived = [];
  for (let slot = 0; slot < 2; slot += 1) {
    const serviceNames = Object.keys(SERVICES);
    const service = serviceNames[hash(`${experiment.id}:${turn}:${slot}:service`) % serviceNames.length];
    const price = world.prices_cents[service];
    const acceptancePercent = Math.max(8, Math.min(95, Math.round(130 - 80 * price / SERVICES[service].base_price_cents)));
    const draw = hash(`${experiment.id}:${turn}:${slot}:demand`) % 100;
    if (draw < acceptancePercent) {
      const order = companyOrder(world.next_order_number++, turn, service, price);
      world.orders.push(order);
      arrived.push(order);
    } else world.rejected_inquiries += 1;
  }
  result.consequences.push(`${arrived.length} new order${arrived.length === 1 ? '' : 's'} arrived.`);
  result.evidence.push(metric('New orders', arrived.length), metric('Expired orders this turn', expired.length), metric('Overhead', euros(DAILY_OVERHEAD_CENTS), 'EUR'));
  if (turn % 4 === 0) {
    world.supplier.multiplier = world.supplier.multiplier === 1 ? 2 : 1;
    world.supplier.prices_cents = Object.fromEntries(PARTS.map(part => [part, BASE_PART_COSTS[part] * world.supplier.multiplier]));
    world.supplier.last_shock_turn = turn;
    world.supplier.next_review_turn = turn + 4;
    const message = `Supplier changed to ${world.supplier.multiplier}× normal prices for the next turn.`;
    result.consequences.push(message);
    result.learned.push(message);
  }
  const actualEquity = world.cash_cents + inventoryValue(world);
  const expectedEquity = world.accounting.opening_equity_cents + world.accounting.revenue_cents - world.accounting.expense_cents;
  result.evidence.push(metric('Accounting difference', euros(actualEquity - expectedEquity), 'EUR'));
  if (world.cash_cents <= 0) {
    experiment.status = 'insolvent';
    result.consequences.push('Cash is exhausted; the workshop is insolvent and this experiment is closed.');
  }
  compactCompany(world);
  return result;
}

function companySnapshot(world) {
  return {
    cash: euros(world.cash_cents), inventory: Object.fromEntries(PARTS.map(part => [part, world.inventory[part].quantity])),
    inventory_book_value: euros(inventoryValue(world)), waiting_orders: world.orders.filter(order => order.status === 'waiting').length,
    completed_orders: world.completed_orders, expired_orders: world.expired_orders,
    profit: euros(world.accounting.revenue_cents - world.accounting.expense_cents), supplier_multiplier: world.supplier.multiplier,
    prices: Object.fromEntries(Object.entries(world.prices_cents).map(([service, price]) => [service, euros(price)])),
  };
}

function languageOracle(id) {
  const seed = hash(`${id}:grammar`);
  const words = ['mi', 'tu', 'na', 'vek', 'lom', 'sir', 'esh', 'dor', 'ilu'];
  const rotation = seed % words.length;
  return {
    lexicon: Object.fromEntries(LANGUAGE_WORDS.map((word, i) => [word, words[(i + rotation) % words.length]])),
    word_order: ['SOV', 'SVO', 'VSO'][Math.floor(seed / 9) % 3],
    past_marker: ['ka', 'zo', 'ri'][Math.floor(seed / 27) % 3],
  };
}

function languageFixture(subject, verb, object, tense) { return { subject, verb, object, tense }; }
function withheldLanguageFixtures(id) {
  const offset = hash(`${id}:withheld`) % 3;
  return Array.from({ length: 9 }, (_, i) => languageFixture(
    LANGUAGE_SUBJECTS[(i + offset) % 3], LANGUAGE_VERBS[Math.floor(i / 3)],
    LANGUAGE_OBJECTS[(i * 2 + Math.floor(i / 3)) % 3], i % 2 ? 'past' : 'present',
  ));
}

function sentenceEnglish(fixture) {
  const tense = fixture.tense === 'past' ? ' [past]' : ' [present]';
  return `${fixture.subject} ${fixture.verb} ${fixture.object}${tense}`;
}

function translate(fixture, grammar) {
  const letters = { S: fixture.subject, V: fixture.verb, O: fixture.object };
  const tokens = grammar.word_order.split('').map(letter => grammar.lexicon[letters[letter]] ?? '?');
  if (fixture.tense === 'past') tokens.push(grammar.past_marker ?? '?');
  return tokens.join(' ');
}

function initializeLanguage(experiment) {
  const oracle = languageOracle(experiment.id);
  const initial = [languageFixture('I', 'see', 'star', 'present'), languageFixture('you', 'carry', 'stone', 'past')];
  experiment._private = { language_oracle: oracle, withheld_sentences: withheldLanguageFixtures(experiment.id) };
  return {
    examples: initial.map((fixture, i) => ({ id: `example-${i + 1}`, turn: 0, kind: 'seed', ...fixture,
      english: sentenceEnglish(fixture), alien: translate(fixture, oracle) })),
    examples_observed: initial.length, archived_examples: 0,
    hypotheses: [], dictionary: [], validations: [], validation_runs: 0, archived_validations: 0,
    withheld_sentence_count: 9,
    latest_validation: null, translation_accuracy: null,
  };
}

function normalizeRuleAnswer(rule, answer) {
  const trimmed = boundedString(answer, 'answer', 80);
  if (rule === 'word-order') {
    const upper = trimmed.toUpperCase();
    const normalized = upper.replace(/SUBJECT/g, 'S').replace(/VERB/g, 'V').replace(/OBJECT/g, 'O').replace(/[\s,\-→]+/g, '');
    assertEnum(normalized, ['SOV', 'SVO', 'VSO', 'VOS', 'OSV', 'OVS'], 'word-order answer');
    return normalized;
  }
  if (!/^[a-z]+$/i.test(trimmed)) throw new RangeError('Vocabulary and past-marker answers must be a single alphabetic token.');
  return trimmed.toLowerCase();
}

function proposedGrammar(world) {
  const answers = Object.fromEntries(world.hypotheses.map(hypothesis => [hypothesis.rule, hypothesis.answer]));
  return {
    word_order: answers['word-order'] ?? 'SVO', past_marker: answers['past-marker'] ?? '?',
    lexicon: Object.fromEntries(LANGUAGE_WORDS.map(word => [word, answers[`lexicon:${word}`] ?? '?'])),
  };
}

function transitionLanguage(experiment, decision, turn) {
  const world = experiment.world;
  // Public browser forks can reconstruct a deterministic oracle without publishing
  // its full answer sheet as data. This puzzle is educational, not cryptographic.
  const oracle = experiment._private?.language_oracle ?? languageOracle(experiment.id);
  const withheld = experiment._private?.withheld_sentences ?? withheldLanguageFixtures(experiment.id);
  const { action: chosen, params } = decision;
  const result = { observation: `${world.examples_observed ?? world.examples.length} observed examples, ${world.hypotheses.length} proposed rules, ${world.validation_runs ?? world.validations.length} completed tests.`,
    consequences: [], evidence: [], learned: [], actor: 'Researcher' };
  if (chosen === 'probe') {
    exactKeys(params, ['subject', 'verb', 'object', 'tense']);
    assertEnum(params.subject, LANGUAGE_SUBJECTS, 'subject');
    assertEnum(params.verb, LANGUAGE_VERBS, 'verb');
    assertEnum(params.object, LANGUAGE_OBJECTS, 'object');
    assertEnum(params.tense, ['present', 'past'], 'tense');
    const example = { id: `example-${(world.examples_observed ?? world.examples.length) + 1}`, turn, kind: 'probe', ...params,
      english: sentenceEnglish(params), alien: translate(params, oracle) };
    world.examples.push(example);
    world.examples_observed = (world.examples_observed ?? world.examples.length - 1) + 1;
    const removed = world.examples.splice(0, Math.max(0, world.examples.length - 64));
    world.archived_examples = (world.archived_examples ?? 0) + removed.length;
    result.consequences.push(`Oracle example: “${example.english}” → “${example.alien}”.`);
    result.evidence.push({ label: example.english, value: example.alien, unit: 'translation', detail: 'One observed oracle response; no claim about untested sentences.' });
    result.learned.push(`${example.english} → ${example.alien}`);
  } else if (chosen === 'hypothesize') {
    exactKeys(params, ['rule', 'answer']);
    assertEnum(params.rule, LANGUAGE_RULES, 'rule');
    const answer = normalizeRuleAnswer(params.rule, params.answer);
    const previous = world.hypotheses.find(hypothesis => hypothesis.rule === params.rule);
    const hypothesis = { rule: params.rule, answer, proposed_turn: turn, confidence: 0.25, tested: 0, passed: 0,
      last_test_turn: null, revision: (previous?.revision ?? 0) + 1 };
    if (previous) world.hypotheses[world.hypotheses.indexOf(previous)] = hypothesis;
    else world.hypotheses.push(hypothesis);
    if (params.rule.startsWith('lexicon:')) {
      const english = params.rule.slice(8);
      const entry = { english, alien: answer, confidence: hypothesis.confidence, tested: 0 };
      const previousWord = world.dictionary.find(word => word.english === english);
      if (previousWord) world.dictionary[world.dictionary.indexOf(previousWord)] = entry;
      else world.dictionary.push(entry);
    }
    result.consequences.push(`Proposed ${params.rule} = “${answer}”; confidence starts at 25% until tested.`);
    result.evidence.push(metric('Initial confidence', 25, '%'));
    result.learned.push(`Unverified proposal: ${params.rule} = ${answer}.`);
    result.actor = 'Linguist';
  } else if (chosen === 'validate') {
    exactKeys(params, ['rule']);
    if (params.rule !== undefined) assertEnum(params.rule, LANGUAGE_RULES, 'rule');
    const hypotheses = params.rule ? world.hypotheses.filter(hypothesis => hypothesis.rule === params.rule) : world.hypotheses;
    if (!hypotheses.length) throw new RangeError('Propose a hypothesis before validating it.');
    let tested = 0;
    let passed = 0;
    for (const hypothesis of hypotheses) {
      let fixtures = withheld;
      if (hypothesis.rule.startsWith('lexicon:')) {
        const word = hypothesis.rule.slice(8);
        fixtures = withheld.filter(fixture => [fixture.subject, fixture.verb, fixture.object].includes(word));
      } else if (hypothesis.rule === 'past-marker') fixtures = withheld.filter(fixture => fixture.tense === 'past');
      const expected = hypothesis.rule === 'word-order' ? oracle.word_order : hypothesis.rule === 'past-marker'
        ? oracle.past_marker : oracle.lexicon[hypothesis.rule.slice(8)];
      const correct = hypothesis.answer === expected ? fixtures.length : 0;
      // Retesting this same fixed batch is useful reproducibility evidence, but
      // it is not new independent evidence and must not inflate confidence.
      hypothesis.tested = fixtures.length;
      hypothesis.passed = correct;
      hypothesis.confidence = (hypothesis.passed + 1) / (hypothesis.tested + 2);
      hypothesis.last_test_turn = turn;
      tested += fixtures.length;
      passed += correct;
      const dictionaryEntry = world.dictionary.find(word => `lexicon:${word.english}` === hypothesis.rule);
      if (dictionaryEntry) { dictionaryEntry.confidence = hypothesis.confidence; dictionaryEntry.tested = hypothesis.tested; }
    }
    const proposal = proposedGrammar(world);
    const matches = withheld.map(fixture => ({ fixture, predicted: translate(fixture, proposal), expected: translate(fixture, oracle) }));
    const translatedCorrectly = matches.filter(match => match.predicted === match.expected).length;
    const failed = matches.find(match => match.predicted !== match.expected);
    const test = {
      id: `validation-${(world.validation_runs ?? world.validations.length) + 1}`, turn, rule: params.rule ?? 'complete-system',
      checks_passed: passed, checks_total: tested, sentences_correct: translatedCorrectly, sentences_total: withheld.length,
      accuracy: translatedCorrectly / withheld.length,
      counterexample: failed ? { english: sentenceEnglish(failed.fixture), proposed_translation: failed.predicted,
        expected_translation: failed.expected } : null,
    };
    world.validations.push(test);
    world.validation_runs = (world.validation_runs ?? world.validations.length - 1) + 1;
    const removed = world.validations.splice(0, Math.max(0, world.validations.length - 32));
    world.archived_validations = (world.archived_validations ?? 0) + removed.length;
    world.latest_validation = clone(test);
    world.translation_accuracy = test.accuracy;
    result.consequences.push(`${passed}/${tested} rule checks passed. The current translation system matched ${translatedCorrectly}/${withheld.length} withheld sentences.`);
    if (failed) result.consequences.push(`Counterexample: “${sentenceEnglish(failed.fixture)}” was predicted as “${failed.predicted}”; the oracle returned “${failed.expected}”.`);
    result.evidence.push(metric('Rule checks passed', passed), metric('Rule checks tested', tested), metric('Held-out translation accuracy', Math.round(test.accuracy * 1000) / 10, '%'));
    result.learned.push(`${params.rule ?? 'Current system'}: ${passed}/${tested} checks passed; ${translatedCorrectly}/${withheld.length} full translations correct.`);
    result.actor = 'Skeptical reviewer';
  } else throw new RangeError(`Unsupported alien-language action: ${chosen}.`);
  return result;
}

function languageSnapshot(world) {
  return { observed_examples: world.examples_observed ?? world.examples.length, hypotheses: clone(world.hypotheses), dictionary: clone(world.dictionary),
    validation_runs: world.validation_runs ?? world.validations.length, translation_accuracy: world.translation_accuracy,
    latest_example: clone(world.examples.at(-1)), latest_validation: clone(world.latest_validation) };
}

const cellKey = cell => `${cell.x},${cell.y}`;
function warehouse() {
  // Vertical shelving leaves cross aisles at y=0,4,8.
  const walls = [];
  for (const x of [3, 6, 9]) for (const y of [1, 2, 3, 5, 6, 7]) walls.push({ x, y });
  return { width: 12, height: 9, walls, depot: { x: 0, y: 4 },
    objective: 'Visit all pick cells and return to the depot with the fewest grid steps.' };
}

function routingFixtures() {
  const fixture = (id, cells) => ({ id, picks: cells.map(([x, y]) => ({ x, y })) });
  return {
    training: [
      fixture('training-1', [[1, 1], [10, 7], [4, 6], [8, 1], [2, 7], [11, 2]]),
      fixture('training-2', [[10, 1], [1, 7], [7, 2], [4, 7], [11, 6], [2, 2], [8, 7]]),
      fixture('training-3', [[2, 6], [10, 2], [5, 1], [1, 3], [7, 6], [11, 7]]),
      fixture('training-4', [[11, 1], [1, 6], [8, 6], [4, 2], [2, 1], [10, 6], [5, 7]]),
    ],
    holdout: [
      fixture('withheld-1', [[1, 2], [11, 6], [5, 6], [8, 2], [2, 7], [10, 1]]),
      fixture('withheld-2', [[11, 7], [1, 1], [4, 6], [8, 1], [2, 6], [10, 3], [5, 2]]),
      fixture('withheld-3', [[2, 3], [10, 7], [5, 1], [1, 7], [8, 3], [4, 7], [11, 1]]),
    ],
  };
}

function shortestPath(grid, start, finish) {
  const walls = new Set(grid.walls.map(cellKey));
  const inBounds = cell => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.x < grid.width && cell.y >= 0 && cell.y < grid.height && !walls.has(cellKey(cell));
  if (!inBounds(start) || !inBounds(finish)) throw new RangeError('A route endpoint is outside the walkable warehouse.');
  const queue = [start];
  const parents = new Map([[cellKey(start), null]]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (cellKey(current) === cellKey(finish)) {
      const path = [];
      let key = cellKey(current);
      while (key !== null) {
        const [x, y] = key.split(',').map(Number);
        path.push({ x, y });
        key = parents.get(key);
      }
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      if (inBounds(next) && !parents.has(cellKey(next))) { parents.set(cellKey(next), cellKey(current)); queue.push(next); }
    }
  }
  throw new RangeError('A pick location cannot be reached.');
}

function visitOrder(grid, picks, candidate) {
  if (candidate.heuristic === 'axis') return [...picks].sort((a, b) => a.x - b.x || a.y - b.y);
  if (candidate.heuristic === 'sweep') return [...picks].sort((a, b) => a.y - b.y || (a.y % 2 ? b.x - a.x : a.x - b.x));
  const remaining = [...picks];
  const ordered = [];
  let current = grid.depot;
  const distance = (from, to) => shortestPath(grid, from, to).length - 1;
  while (remaining.length) {
    const scored = remaining.map(pick => {
      const steps = distance(current, pick);
      const following = remaining.filter(other => other !== pick);
      const nextDistance = following.length ? Math.min(...following.map(other => distance(pick, other))) : distance(pick, grid.depot);
      let score = steps;
      if (candidate.heuristic === 'lookahead') score += (candidate.params.lookahead_weight ?? 0.7) * nextDistance;
      if (candidate.heuristic === 'weighted') score = steps * (candidate.params.distance_weight ?? 1)
        + Math.abs(pick.y - current.y) * (candidate.params.vertical_weight ?? 0.4)
        + nextDistance * (candidate.params.lookahead_weight ?? 0.2);
      return { pick, score };
    }).sort((a, b) => a.score - b.score || a.pick.x - b.pick.x || a.pick.y - b.pick.y);
    current = scored[0].pick;
    ordered.push(current);
    remaining.splice(remaining.indexOf(current), 1);
  }
  return ordered;
}

function routeFixture(grid, fixture, candidate) {
  const order = visitOrder(grid, fixture.picks, candidate);
  const path = [clone(grid.depot)];
  const legs = [];
  let current = grid.depot;
  for (const destination of [...order, grid.depot]) {
    const leg = shortestPath(grid, current, destination);
    legs.push({ from: clone(current), to: clone(destination), steps: leg.length - 1 });
    path.push(...leg.slice(1));
    current = destination;
  }
  return { fixture_id: fixture.id, heuristic: candidate.heuristic, candidate_name: candidate.name,
    picks: clone(fixture.picks), visit_order: clone(order), path, legs, steps: path.length - 1 };
}

function evaluateCandidate(grid, fixtures, candidate) {
  const routes = fixtures.map(fixture => routeFixture(grid, fixture, candidate));
  return { steps: sum(routes.map(route => route.steps)), routes };
}

function initializeLeague(experiment) {
  const grid = warehouse();
  const fixtures = routingFixtures();
  experiment._private = { routing_holdout: fixtures.holdout };
  const champion = { name: 'Column order baseline', heuristic: 'axis', params: {}, adopted_turn: 0 };
  const training = evaluateCandidate(grid, fixtures.training, champion);
  const heldout = evaluateCandidate(grid, fixtures.holdout, champion);
  Object.assign(champion, { training_steps: training.steps, unseen_steps: heldout.steps,
    total_steps: training.steps + heldout.steps, routes: training.routes });
  return { challenge: grid, fixtures: fixtures.training, withheld_fixture_count: fixtures.holdout.length,
    champion, candidates: [], candidates_tested: 0, archived_candidates: { count: 0, promotions: 0 },
    promotions: 0, replay: clone(training.routes[0]),
    leaderboard: [{ name: champion.name, heuristic: champion.heuristic, turn: 0,
      training_steps: training.steps, unseen_steps: heldout.steps, total_steps: training.steps + heldout.steps, promoted: true }] };
}

function transitionLeague(experiment, decision, turn) {
  const world = experiment.world;
  const { action: chosen, params } = decision;
  const result = { observation: `Champion “${world.champion.name}”: ${world.champion.training_steps} training steps and ${world.champion.unseen_steps} withheld steps; ${world.candidates_tested ?? world.candidates.length} challengers tested.`,
    consequences: [], evidence: [], learned: [], actor: 'Inventor' };
  if (chosen === 'candidate') {
    exactKeys(params, ['name', 'heuristic', 'params']);
    const name = boundedString(params.name, 'candidate name', 80);
    assertEnum(params.heuristic, ['nearest', 'axis', 'sweep', 'lookahead', 'weighted'], 'heuristic');
    const weights = params.params ?? {};
    exactKeys(weights, ['distance_weight', 'vertical_weight', 'lookahead_weight']);
    for (const [key, value] of Object.entries(weights)) {
      const limits = { distance_weight: [0.1, 4], vertical_weight: [0, 4], lookahead_weight: [0, 2] }[key];
      assertNumber(value, limits[0], limits[1], key);
    }
    const candidate = { id: `candidate-${(world.candidates_tested ?? world.candidates.length) + 1}`, name, heuristic: params.heuristic,
      params: clone(weights), turn };
    const training = evaluateCandidate(world.challenge, world.fixtures, candidate);
    const withheld = experiment._private?.routing_holdout ?? routingFixtures().holdout;
    const heldout = evaluateCandidate(world.challenge, withheld, candidate);
    const before = world.champion;
    const promoted = training.steps < before.training_steps && heldout.steps <= before.unseen_steps;
    Object.assign(candidate, { training_steps: training.steps, unseen_steps: heldout.steps,
      total_steps: training.steps + heldout.steps, promoted,
      improvement_training_steps: before.training_steps - training.steps,
      improvement_unseen_steps: before.unseen_steps - heldout.steps, routes: training.routes });
    world.candidates.push(candidate);
    world.candidates_tested = (world.candidates_tested ?? world.candidates.length - 1) + 1;
    world.leaderboard.push({ name, heuristic: candidate.heuristic, turn,
      training_steps: training.steps, unseen_steps: heldout.steps, total_steps: candidate.total_steps, promoted });
    world.leaderboard.sort((a, b) => a.total_steps - b.total_steps || a.training_steps - b.training_steps || a.turn - b.turn);
    world.leaderboard = world.leaderboard.slice(0, 20);
    if (promoted) {
      world.champion = { name, heuristic: candidate.heuristic, params: clone(weights), adopted_turn: turn,
        training_steps: training.steps, unseen_steps: heldout.steps, total_steps: candidate.total_steps, routes: training.routes };
      world.promotions += 1;
    }
    world.replay = clone(training.routes[0]);
    world.archived_candidates ??= { count: 0, promotions: 0 };
    const archived = world.candidates.splice(0, Math.max(0, world.candidates.length - 32));
    world.archived_candidates.count += archived.length;
    world.archived_candidates.promotions += archived.filter(item => item.promoted).length;
    result.consequences.push(`“${name}” walked ${training.steps} training steps and ${heldout.steps} withheld steps.`);
    result.consequences.push(promoted ? `Promoted over “${before.name}”: training improved by ${before.training_steps - training.steps} steps and withheld results did not regress.`
      : `Retained “${before.name}”: promotion requires a training improvement and no withheld regression.`);
    result.evidence.push(metric('Challenger training distance', training.steps, 'steps'), metric('Challenger withheld distance', heldout.steps, 'steps'),
      metric('Training improvement', before.training_steps - training.steps, 'steps'), metric('Withheld improvement', before.unseen_steps - heldout.steps, 'steps'),
      { label: 'Promoted', value: promoted, unit: 'verdict', detail: 'Same fixtures and shortest-path movement rules for both candidates.' });
    result.learned.push(`${name}: training ${training.steps}, withheld ${heldout.steps}; ${promoted ? 'promoted' : 'rejected'}.`);
  } else if (chosen === 'replay') {
    exactKeys(params, ['fixture_id']);
    const fixture = params.fixture_id === undefined ? world.fixtures[0] : world.fixtures.find(item => item.id === params.fixture_id);
    if (!fixture) throw new RangeError('Only published training fixtures can be replayed.');
    world.replay = routeFixture(world.challenge, fixture, world.champion);
    result.consequences.push(`Replayed “${world.champion.name}” on ${fixture.id}: ${world.replay.steps} steps, ${fixture.picks.length} picks and return to depot.`);
    result.evidence.push(metric('Replay distance', world.replay.steps, 'steps'), metric('Picks visited', fixture.picks.length));
    result.actor = 'Benchmark runner';
  } else if (chosen === 'rest') {
    exactKeys(params, []);
    result.consequences.push(`Retained champion “${world.champion.name}”; no new challenger was evaluated.`);
    result.actor = 'Independent referee';
  } else throw new RangeError(`Unsupported invention-league action: ${chosen}.`);
  return result;
}

function leagueSnapshot(world) {
  return { champion: world.champion.name, heuristic: world.champion.heuristic,
    training_steps: world.champion.training_steps, unseen_steps: world.champion.unseen_steps,
    candidates_tested: world.candidates_tested ?? world.candidates.length, promotions: world.promotions, replay: clone(world.replay) };
}

function cityForcing(turn, extraRain = 0, debrisDistrict = 'none') {
  const base_rain = CITY_RAIN[(turn - 1) % CITY_RAIN.length];
  const cloudburst_extra = turn % 8 === 0 ? 4 : 0;
  const debris_district = turn % 5 === 0 ? CITY_IDS[(turn / 5 - 1) % CITY_IDS.length] : 'none';
  const debris_penalties = Object.fromEntries(CITY_IDS.map(id => [id, (id === debris_district ? 3 : 0) + (id === debrisDistrict ? 3 : 0)]));
  const crises = [];
  if (cloudburst_extra) crises.push('Scheduled cloudburst: +4 rain.');
  if (debris_district !== 'none') crises.push(`Scheduled debris: ${debris_district} drain −3.`);
  if (extraRain) crises.push(`Explicit simulation input: +${extraRain} rain.`);
  if (debrisDistrict !== 'none') crises.push(`Explicit simulation input: ${debrisDistrict} drain −3.`);
  return { turn, base_rain, cloudburst_extra, rain: base_rain + cloudburst_extra + extraRain,
    debris_district, overrides: { extra_rain: extraRain, debris_district: debrisDistrict }, debris_penalties, crises };
}

function initializeCity() {
  return { districts: CITY_SEED.map(district => ({ ...district, upgrades: 0, cumulative_unserved: 0 })),
    budget: 12, opening_budget: 12, cumulative_spent: 0, cumulative_income: 0, cumulative_clipped_income: 0,
    forcing_turn: 0, next_forcing: cityForcing(1), latest_receipt: null, receipts: [], total_unserved: 0, equity_gap: 0,
    agent_memory: { planner: null, residents: null, auditor: null } };
}

function cityParams(params) {
  exactKeys(params, ['planner_action', 'planner_district', 'residents_action', 'residents_district', 'spend_limit', 'priority', 'extra_rain', 'debris_district']);
  assertEnum(params.planner_action, ['hold', 'clear', 'expand'], 'planner_action');
  assertEnum(params.residents_action, ['hold', 'relief'], 'residents_action');
  assertEnum(params.planner_district, ['none', ...CITY_IDS], 'planner_district');
  assertEnum(params.residents_district, ['none', ...CITY_IDS], 'residents_district');
  if ((params.planner_action === 'hold') !== (params.planner_district === 'none')) throw new RangeError('planner_district must be none exactly when planner_action is hold.');
  if ((params.residents_action === 'hold') !== (params.residents_district === 'none')) throw new RangeError('residents_district must be none exactly when residents_action is hold.');
  assertEnum(params.spend_limit, [0, 4, 8], 'spend_limit');
  assertEnum(params.priority, ['infrastructure', 'relief'], 'priority');
  const extra_rain = params.extra_rain === undefined ? 0 : params.extra_rain;
  const debris_district = params.debris_district === undefined ? 'none' : params.debris_district;
  assertNumber(extra_rain, 0, 6, 'extra_rain', true);
  assertEnum(debris_district, ['none', ...CITY_IDS], 'debris_district');
  return { ...clone(params), extra_rain, debris_district };
}

function cityEquity(districts) {
  const rates = districts.map(district => 100 * district.cumulative_unserved / district.population);
  return Math.max(...rates) - Math.min(...rates);
}

/** Pure forecast: explicit options replace the corresponding action overrides. */
export function forecastCityTurn(world, params, options = {}) {
  const chosen = cityParams(params);
  exactKeys(options, ['extraRain', 'debrisDistrict']);
  const extraRain = options.extraRain === undefined ? chosen.extra_rain : options.extraRain;
  const debrisDistrict = options.debrisDistrict === undefined ? chosen.debris_district : options.debrisDistrict;
  assertNumber(extraRain, 0, 6, 'extraRain', true);
  assertEnum(debrisDistrict, ['none', ...CITY_IDS], 'debrisDistrict');
  const errors = [];
  validateCity({ world }, errors);
  if (errors.length) throw new Error(`Invalid city world: ${errors.join('; ')}`);
  const next = clone(world);
  const forcing = cityForcing(next.forcing_turn + 1, extraRain, debrisDistrict);
  const before = next.budget;
  const limit = Math.min(before, chosen.spend_limit);
  let envelope = limit;
  let reliefDistrict = 'none';
  const requests = [
    { kind: 'infrastructure', action: chosen.planner_action, district: chosen.planner_district, cost: chosen.planner_action === 'hold' ? 0 : chosen.planner_action === 'clear' ? 3 : 6 },
    { kind: 'relief', action: chosen.residents_action, district: chosen.residents_district, cost: chosen.residents_action === 'hold' ? 0 : 2 },
  ];
  if (chosen.priority === 'relief') requests.reverse();
  for (const request of requests) {
    if (request.action === 'hold') { request.status = 'held'; request.reason = 'No request.'; continue; }
    const district = next.districts.find(item => item.id === request.district);
    if (request.action === 'expand' && district.upgrades === 3) { request.status = 'declined'; request.reason = 'Upgrade cap reached.'; continue; }
    if (request.cost > envelope) { request.status = 'declined'; request.reason = 'Insufficient remaining spending envelope.'; continue; }
    envelope -= request.cost;
    request.status = 'funded'; request.reason = 'Funded in full.';
    if (request.action === 'clear') district.wear = 0;
    if (request.action === 'expand') district.upgrades += 1;
    if (request.action === 'relief') reliefDistrict = request.district;
  }
  const spent = limit - envelope;
  const waterBefore = sum(next.districts.map(district => district.water));
  let upstream = 0;
  const districts = next.districts.map(district => {
    const water_before = district.water;
    const inflow = upstream;
    const available = water_before + forcing.rain + inflow;
    const drain_capacity = Math.max(0, district.base_drain + 2 * district.upgrades - district.wear - forcing.debris_penalties[district.id]);
    const drained = Math.min(available, drain_capacity);
    const remaining = available - drained;
    const flood_units = Math.max(0, remaining - district.safe_water);
    const exposed = flood_units === 0 ? 0 : Math.min(district.population, 2 * flood_units + district.vulnerable);
    const protectedHouseholds = district.id === reliefDistrict ? Math.min(4, exposed) : 0;
    const unserved = exposed - protectedHouseholds;
    district.water = Math.min(district.storage_cap, remaining);
    upstream = Math.max(0, remaining - district.storage_cap);
    district.cumulative_unserved += unserved;
    district.wear = Math.min(6, district.wear + 1);
    return { id: district.id, name: district.name, water_before, inflow, available, drain_capacity, drained, remaining,
      flood_units, water_after: district.water, overflow: upstream, exposed, protected: protectedHouseholds, unserved,
      cumulative_unserved: district.cumulative_unserved, wear_after: district.wear, upgrades: district.upgrades };
  });
  const income = 4;
  const clipped_income = Math.max(0, before - spent + income - 24);
  next.budget = before - spent + income - clipped_income;
  next.cumulative_spent += spent;
  next.cumulative_income += income;
  next.cumulative_clipped_income += clipped_income;
  next.forcing_turn = forcing.turn;
  next.total_unserved = sum(next.districts.map(district => district.cumulative_unserved));
  next.equity_gap = cityEquity(next.districts);
  next.next_forcing = cityForcing(forcing.turn + 1);
  const afterWater = sum(next.districts.map(district => district.water));
  const drainedWater = sum(districts.map(district => district.drained));
  const receipt = { turn: forcing.turn, forcing, decision: { ...chosen, extra_rain: extraRain, debris_district: debrisDistrict }, requests, districts,
    budget: { before, limit, spent, income, clipped_income, after: next.budget },
    water_balance: { before: waterBefore, rain_added: 3 * forcing.rain, drained: drainedWater, after: afterWater, river_outflow: upstream,
      difference: waterBefore + 3 * forcing.rain - drainedWater - afterWater - upstream },
    total_exposed: sum(districts.map(district => district.exposed)), total_protected: sum(districts.map(district => district.protected)),
    total_unserved: sum(districts.map(district => district.unserved)), equity_gap: next.equity_gap };
  next.latest_receipt = receipt;
  next.receipts = [...next.receipts, clone(receipt)].slice(-12);
  next.agent_memory = {
    planner: { turn: forcing.turn, decision: { action: chosen.planner_action, district: chosen.planner_district },
      observed: `${drainedWater} water units drained; ${requests.find(request => request.kind === 'infrastructure').status} infrastructure.`,
      watch: `Wear next turn: ${next.districts.map(district => `${district.id} ${district.wear}`).join(', ')}.` },
    residents: { turn: forcing.turn, decision: { action: chosen.residents_action, district: chosen.residents_district },
      observed: `${receipt.total_protected} households protected; ${receipt.total_unserved} household-events unserved.`,
      watch: `Cumulative equity gap ${next.equity_gap.toFixed(2)} events per 100 households.` },
    auditor: { turn: forcing.turn, decision: { spend_limit: chosen.spend_limit, priority: chosen.priority },
      observed: `${spent} credits spent; treasury ${next.budget}; ${requests.filter(request => request.status === 'declined').length} requests declined.`,
      watch: `Next announced rain ${next.next_forcing.rain}; treasury cap 24.` },
  };
  return next;
}

function cityMetrics(world) {
  const latest = world.latest_receipt;
  return [metric('Treasury', world.budget, 'credits'), metric('Unserved this turn', latest?.total_unserved ?? 0, 'household-events'),
    metric('Cumulative unserved', world.total_unserved, 'household-events'), metric('Equity gap', world.equity_gap, 'events / 100 households'),
    metric('Installed upgrades', sum(world.districts.map(district => district.upgrades))), metric('Cumulative spending', world.cumulative_spent, 'credits'),
    metric('Water retained', sum(world.districts.map(district => district.water)), 'water units'), metric('River outflow', latest?.water_balance.river_outflow ?? 0, 'water units'),
    metric('Forcing turns elapsed', world.forcing_turn), metric('Next rain', world.next_forcing.rain, 'rain units')];
}

function citySnapshot(world) {
  const { receipts, ...current } = world;
  return { world: clone(current), districts: clone(world.districts), budget: world.budget, total_unserved: world.total_unserved,
    equity_gap: world.equity_gap, forcing_turn: world.forcing_turn, next_forcing: clone(world.next_forcing),
    latest_receipt: clone(world.latest_receipt), metrics: cityMetrics(world) };
}

function transitionCity(experiment, decision) {
  if (decision.action !== 'govern') throw new RangeError(`Unsupported flood-city action: ${decision.action}.`);
  const prior = experiment.world;
  const chosen = cityParams(decision.params);
  const world = forecastCityTurn(prior, chosen);
  experiment.world = world;
  const receipt = world.latest_receipt;
  return { actor: 'Town council',
    observation: `Treasury ${prior.budget} credits; forcing turn ${receipt.turn} announces ${receipt.forcing.rain} rain units. ${receipt.forcing.crises.join(' ')} District water/wear: ${prior.districts.map(district => `${district.id} ${district.water}/${district.wear}`).join(', ')}.`,
    consequences: [`Spent ${receipt.budget.spent} credits; ${receipt.total_protected} households protected; ${receipt.total_unserved} household-events unserved.`,
      `Treasury ${world.budget}; cumulative unserved ${world.total_unserved}; equity gap ${world.equity_gap.toFixed(2)} per 100 households.`,
      ...receipt.requests.map(request => `${request.kind} ${request.action} ${request.district}: ${request.status} (${request.reason})`)],
    evidence: [metric('Rain applied', receipt.forcing.rain, 'rain units'), metric('Explicit extra rain', receipt.forcing.overrides.extra_rain, 'rain units'),
      metric('Explicit debris district', receipt.forcing.overrides.debris_district), metric('Credits spent', receipt.budget.spent, 'credits'),
      metric('Households exposed', receipt.total_exposed), metric('Households protected', receipt.total_protected), metric('Unserved household-events', receipt.total_unserved),
      metric('Equity gap', world.equity_gap, 'events / 100 households'), metric('Water balance difference', receipt.water_balance.difference, 'water units'),
      metric('Treasury difference', receipt.budget.before - receipt.budget.spent + receipt.budget.income - receipt.budget.clipped_income - receipt.budget.after, 'credits')],
    learned: [`Receipt ${receipt.turn}: ${receipt.total_unserved} unserved events after ${receipt.budget.spent} credits of funded requests.`,
      `Next forcing: ${world.next_forcing.rain} rain; scheduled debris ${world.next_forcing.debris_district}.`] };
}

function updateMetrics(experiment) {
  const world = experiment.world;
  if (experiment.type === 'life-research') experiment.metrics = lifeMetrics(world);
  if (experiment.type === 'flood-city') experiment.metrics = cityMetrics(world);
  if (experiment.type === 'bicycle-company') experiment.metrics = [
    metric('Cash', euros(world.cash_cents), 'EUR'), metric('Inventory book value', euros(inventoryValue(world)), 'EUR'),
    metric('Completed repairs', world.completed_orders), metric('Waiting orders', world.orders.filter(order => order.status === 'waiting').length),
    metric('Expired orders', world.expired_orders), metric('Net profit', euros(world.accounting.revenue_cents - world.accounting.expense_cents), 'EUR'),
    metric('Supplier price multiplier', world.supplier.multiplier, '×'),
  ];
  if (experiment.type === 'alien-language') experiment.metrics = [
    metric('Observed examples', world.examples_observed ?? world.examples.length), metric('Proposed rules', world.hypotheses.length),
    metric('Tested rules', world.hypotheses.filter(hypothesis => hypothesis.tested > 0).length),
    metric('Validation runs', world.validation_runs ?? world.validations.length),
    metric('Held-out accuracy', world.translation_accuracy === null ? null : Math.round(world.translation_accuracy * 1000) / 10, '%'),
  ];
  if (experiment.type === 'invention-league') experiment.metrics = [
    metric('Champion training distance', world.champion.training_steps, 'steps'),
    metric('Champion withheld distance', world.champion.unseen_steps, 'steps'),
    metric('Challengers tested', world.candidates_tested ?? world.candidates.length), metric('Promotions', world.promotions),
    metric('Current replay distance', world.replay.steps, 'steps'),
  ];
}

function transitionLife(experiment, decision) {
  const { world, ...result } = applyLifeDecision(experiment.world, decision);
  experiment.world = world;
  return result;
}
const snapshots = { 'bicycle-company': companySnapshot, 'alien-language': languageSnapshot, 'invention-league': leagueSnapshot, 'flood-city': citySnapshot, 'life-research': lifeSnapshot };
const transitions = { 'bicycle-company': transitionCompany, 'alien-language': transitionLanguage, 'invention-league': transitionLeague, 'flood-city': transitionCity, 'life-research': transitionLife };

export function createExperiment({ id, type, createdAt = new Date().toISOString(), title, description } = {}) {
  boundedString(id, 'id', 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new RangeError('id must contain letters, digits, dots, underscores or hyphens.');
  if (!Object.hasOwn(TYPE_CATALOG, type)) throw new RangeError(`Unknown experiment type: ${type}.`);
  const catalog = TYPE_CATALOG[type];
  const at = timestamp(createdAt, 'createdAt');
  const experiment = { schema_version: 1, id, type,
    title: title === undefined ? catalog.title : boundedString(title, 'title', 150),
    description: description === undefined ? catalog.description : boundedString(description, 'description', 2000),
    created_at: at, updated_at: at, turn: 0, status: 'active', roles: clone(catalog.roles),
    metrics: [], timeline: [], memory: { observations: [], facts: clone(catalog.rules), last_decision: null },
    world: null, allowed_actions: clone(catalog.allowed_actions) };
  if (type === 'bicycle-company') experiment.world = initializeCompany();
  if (type === 'alien-language') experiment.world = initializeLanguage(experiment);
  if (type === 'invention-league') experiment.world = initializeLeague(experiment);
  if (type === 'flood-city') experiment.world = initializeCity();
  if (type === 'life-research') experiment.world = initializeLife();
  updateMetrics(experiment);
  const validation = validateExperiment(experiment);
  if (!validation.valid) throw new Error(`Invalid initializer: ${validation.errors.join('; ')}`);
  return experiment;
}

/** A transition is atomic: any invalid action throws without changing its input. */
export function applyDecision(input, suppliedDecision, { now = new Date().toISOString() } = {}) {
  const validation = validateExperiment(input);
  if (!validation.valid) throw new Error(`Invalid experiment: ${validation.errors.join('; ')}`);
  if (!isRecord(suppliedDecision)) throw new TypeError('Decision must be an object.');
  const selectedAction = boundedString(suppliedDecision.action, 'action', 40);
  const params = suppliedDecision.params === undefined ? {} : suppliedDecision.params;
  if (!isRecord(params)) throw new TypeError('Decision params must be an object.');
  const decision = { action: selectedAction, params: clone(params) };
  const decisionId = suppliedDecision.decision_id === undefined ? undefined : boundedString(suppliedDecision.decision_id, 'decision_id', 150);
  if (decisionId) {
    const previous = input.timeline.find(event => event.decision_id === decisionId);
    if (previous) {
      if (canonical(previous.decision) !== canonical(decision)) throw new RangeError('decision_id already identifies a different action.');
      return clone(input);
    }
  }
  if (input.status !== 'active') throw new RangeError(`Experiment is ${input.status}; create a new experiment or a local fork.`);
  if (!input.allowed_actions.some(allowed => allowed.action === selectedAction)) throw new RangeError(`Unsupported action: ${selectedAction}.`);
  const at = timestamp(now, 'now');
  if (Date.parse(at) < Date.parse(input.updated_at)) throw new RangeError('Decision time cannot precede the last persisted turn.');
  const reason = suppliedDecision.reason === undefined ? 'No rationale was supplied by the decision author.' : boundedString(suppliedDecision.reason, 'reason', 4000);
  const alternatives = suppliedDecision.alternatives ?? [];
  if (!Array.isArray(alternatives) || alternatives.length > 12 || alternatives.some(value => !isRecord(value) && typeof value !== 'string')) throw new TypeError('alternatives must contain at most twelve strings or objects.');
  const actor = suppliedDecision.actor === undefined ? undefined : boundedString(suppliedDecision.actor, 'actor', 150);
  const author = suppliedDecision.action_author === undefined ? undefined : boundedString(suppliedDecision.action_author, 'action_author', 150);
  const experiment = clone(input);
  const turn = experiment.turn + 1;
  const result = transitions[experiment.type](experiment, decision, turn);
  experiment.turn = turn;
  experiment.updated_at = at;
  const memory = { learned: result.learned, retained: experiment.memory.facts.slice(0, 8) };
  const event = { turn, at, actor: actor ?? result.actor,
    observation: result.observation, decision, reason, alternatives: clone(alternatives),
    consequence: result.consequences.join(' '), evidence: result.evidence, memory: clone(memory),
    snapshot: snapshots[experiment.type](experiment.world) };
  if (author !== undefined) event.action_author = author;
  if (decisionId !== undefined) event.decision_id = decisionId;
  experiment.timeline.push(event);
  experiment.memory.observations.push({ turn, note: result.learned.length ? result.learned.join(' ') : result.consequences.join(' ') });
  experiment.memory.observations = experiment.memory.observations.slice(-TYPE_CATALOG[experiment.type].memory_window);
  experiment.memory.last_decision = { turn, ...decision, reason };
  updateMetrics(experiment);
  const after = validateExperiment(experiment);
  if (!after.valid) throw new Error(`Environment invariant failed: ${after.errors.join('; ')}`);
  return experiment;
}

function validateCity(experiment, errors) {
  const world = experiment.world;
  const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!isRecord(world) || !Array.isArray(world.districts) || world.districts.length !== 3 || !Array.isArray(world.receipts) || !isRecord(world.agent_memory)) { errors.push('Missing city state.'); return; }
  for (const field of ['budget', 'opening_budget', 'cumulative_spent', 'cumulative_income', 'cumulative_clipped_income', 'forcing_turn', 'total_unserved']) {
    if (!integer(world[field])) errors.push(`Invalid city ${field}.`);
  }
  if (world.opening_budget !== 12 || world.budget > 24) errors.push('Invalid city treasury bounds.');
  if (world.budget !== 12 + world.cumulative_income - world.cumulative_spent - world.cumulative_clipped_income) errors.push('City cumulative treasury does not reconcile.');
  if (world.cumulative_income !== 4 * world.forcing_turn) errors.push('City income does not match forcing turns.');
  for (const [i, district] of world.districts.entries()) {
    const seed = CITY_SEED[i];
    if (!isRecord(district) || ['id', 'name', 'x', 'y', 'population', 'vulnerable', 'base_drain', 'safe_water', 'storage_cap'].some(field => district[field] !== seed[field])) { errors.push(`Invalid city district ${i}.`); continue; }
    if (!integer(district.water, 0, district.storage_cap) || !integer(district.wear, 0, 6) || !integer(district.upgrades, 0, 3) || !integer(district.cumulative_unserved)) errors.push(`Invalid ${district.id} district counters.`);
  }
  if (world.total_unserved !== sum(world.districts.map(district => district.cumulative_unserved))) errors.push('City household history does not reconcile.');
  if (world.equity_gap !== cityEquity(world.districts)) errors.push('City equity gap does not match household history.');
  if (canonical(world.next_forcing) !== canonical(cityForcing(world.forcing_turn + 1))) errors.push('City next forcing is incorrect.');
  if (world.receipts.length !== Math.min(12, world.forcing_turn)) errors.push('City receipt window does not match forcing turns.');
  for (const [index, receipt] of world.receipts.entries()) {
    if (!isRecord(receipt) || receipt.turn !== world.forcing_turn - world.receipts.length + index + 1 || !Array.isArray(receipt.districts) || receipt.districts.length !== 3 || !Array.isArray(receipt.requests)) { errors.push('Invalid city receipt sequence.'); continue; }
    const overrides = receipt.forcing?.overrides;
    if (!overrides || !integer(overrides.extra_rain, 0, 6) || !['none', ...CITY_IDS].includes(overrides.debris_district) || canonical(receipt.forcing) !== canonical(cityForcing(receipt.turn, overrides.extra_rain, overrides.debris_district))) errors.push('Invalid city forcing receipt.');
    const balance = receipt.water_balance;
    const treasury = receipt.budget;
    if (!isRecord(balance) || Object.values(balance).some(value => !integer(value)) || balance.difference !== 0 || balance.before + balance.rain_added !== balance.drained + balance.after + balance.river_outflow) errors.push('City receipt water does not conserve.');
    if (!isRecord(treasury) || Object.values(treasury).some(value => !integer(value)) || treasury.before - treasury.spent + treasury.income - treasury.clipped_income !== treasury.after || treasury.income !== 4 || treasury.after > 24 || treasury.spent > treasury.limit || treasury.limit > treasury.before || treasury.clipped_income !== Math.max(0, treasury.before - treasury.spent + 4 - 24)) errors.push('City receipt treasury does not reconcile.');
    if (treasury?.spent !== sum(receipt.requests.filter(request => request.status === 'funded').map(request => request.cost))) errors.push('City funded request costs do not reconcile.');
    let upstream = 0;
    for (const [i, district] of receipt.districts.entries()) {
      const seed = CITY_SEED[i];
      if (district.id !== seed.id || district.inflow !== upstream || district.available !== district.water_before + receipt.forcing.rain + district.inflow || district.drained !== Math.min(district.available, district.drain_capacity) || district.remaining !== district.available - district.drained || district.water_after !== Math.min(seed.storage_cap, district.remaining) || district.overflow !== Math.max(0, district.remaining - seed.storage_cap) || district.flood_units !== Math.max(0, district.remaining - seed.safe_water)) errors.push('City district hydrology receipt is incorrect.');
      const exposure = district.flood_units === 0 ? 0 : Math.min(seed.population, 2 * district.flood_units + seed.vulnerable);
      if (district.exposed !== exposure || !integer(district.protected, 0, Math.min(4, exposure)) || district.unserved !== exposure - district.protected || !integer(district.cumulative_unserved, district.unserved)) errors.push('City household receipt is incorrect.');
      upstream = district.overflow;
    }
    if (balance?.before !== sum(receipt.districts.map(district => district.water_before)) || balance?.rain_added !== 3 * receipt.forcing.rain || balance?.after !== sum(receipt.districts.map(district => district.water_after)) || balance?.drained !== sum(receipt.districts.map(district => district.drained)) || balance?.river_outflow !== upstream) errors.push('City water totals do not match districts.');
    if (receipt.total_exposed !== sum(receipt.districts.map(district => district.exposed)) || receipt.total_protected !== sum(receipt.districts.map(district => district.protected)) || receipt.total_unserved !== sum(receipt.districts.map(district => district.unserved))) errors.push('City household totals do not match districts.');
  }
  if (world.forcing_turn === 0) {
    if (world.latest_receipt !== null || world.total_unserved !== 0 || world.cumulative_spent !== 0) errors.push('City seed has invented activity.');
  } else {
    if (canonical(world.latest_receipt) !== canonical(world.receipts.at(-1))) errors.push('City latest receipt does not match memory.');
    const latest = world.latest_receipt;
    if (latest?.budget.after !== world.budget || latest?.equity_gap !== world.equity_gap || latest?.districts.some((district, i) => district.water_after !== world.districts[i].water || district.wear_after !== world.districts[i].wear || district.upgrades !== world.districts[i].upgrades || district.cumulative_unserved !== world.districts[i].cumulative_unserved)) errors.push('City current state does not match latest receipt.');
  }
}

function validateCompany(experiment, errors) {
  const world = experiment.world;
  for (const part of PARTS) {
    const stock = world.inventory?.[part];
    if (!stock || !Number.isInteger(stock.quantity) || stock.quantity < 0 || !Number.isInteger(stock.book_value_cents) || stock.book_value_cents < 0) errors.push(`Invalid ${part} stock.`);
    if (stock?.quantity === 0 && stock.book_value_cents !== 0) errors.push(`Empty ${part} stock has nonzero book value.`);
  }
  const accounting = world.accounting;
  if (!accounting || !Array.isArray(accounting.ledger)) { errors.push('Missing accounting ledger.'); return; }
  for (const field of ['opening_cash_cents', 'opening_inventory_cents', 'opening_equity_cents', 'revenue_cents', 'expense_cents']) {
    if (!Number.isInteger(accounting[field])) errors.push(`Invalid accounting ${field}.`);
  }
  if (!Number.isInteger(world.cash_cents)) errors.push('Cash must be integer cents.');
  if (PARTS.every(part => isRecord(world.inventory?.[part]))) {
    if (world.cash_cents + inventoryValue(world) !== accounting.opening_equity_cents + accounting.revenue_cents - accounting.expense_cents) errors.push('Accounting equity invariant failed.');
    if (inventoryValue(world) !== accounting.opening_inventory_cents + (accounting.archived_ledger?.inventory_delta_cents ?? 0) + sum(accounting.ledger.map(entry => entry.inventory_delta_cents))) errors.push('Inventory ledger does not reconcile.');
  }
  if (world.cash_cents !== accounting.opening_cash_cents + (accounting.archived_ledger?.cash_delta_cents ?? 0) + sum(accounting.ledger.map(entry => entry.cash_delta_cents))) errors.push('Cash ledger does not reconcile.');
  if (accounting.revenue_cents !== (accounting.archived_ledger?.revenue_delta_cents ?? 0) + sum(accounting.ledger.map(entry => entry.revenue_delta_cents))) errors.push('Revenue ledger does not reconcile.');
  if (accounting.expense_cents !== (accounting.archived_ledger?.expense_delta_cents ?? 0) + sum(accounting.ledger.map(entry => entry.expense_delta_cents))) errors.push('Expense ledger does not reconcile.');
  if (!Array.isArray(world.orders)) { errors.push('Missing orders.'); return; }
  if (new Set(world.orders.map(order => order.id)).size !== world.orders.length) errors.push('Duplicate order IDs.');
  if (world.completed_orders !== (world.archived_orders?.completed ?? 0) + world.orders.filter(order => order.status === 'completed').length) errors.push('Completed-order count does not reconcile.');
  if (world.expired_orders !== (world.archived_orders?.expired ?? 0) + world.orders.filter(order => order.status === 'expired').length) errors.push('Expired-order count does not reconcile.');
  if (world.orders.some(order => !['waiting', 'completed', 'expired'].includes(order.status) || !Number.isInteger(order.quoted_price_cents) || order.quoted_price_cents < 0 || !Object.hasOwn(SERVICES, order.service))) errors.push('Invalid order record.');
  if (world.supplier?.multiplier !== 1 && world.supplier?.multiplier !== 2) errors.push('Invalid supplier multiplier.');
  if (!isRecord(world.prices_cents) || Object.keys(SERVICES).some(service => !Number.isInteger(world.prices_cents[service]) || world.prices_cents[service] < 1000 || world.prices_cents[service] > 25000)) errors.push('Invalid service prices.');
}

function validateLanguage(experiment, errors) {
  const world = experiment.world;
  for (const field of ['examples', 'hypotheses', 'dictionary', 'validations']) if (!Array.isArray(world[field])) errors.push(`Missing language ${field}.`);
  if (errors.length) return;
  if (new Set(world.hypotheses.map(hypothesis => hypothesis.rule)).size !== world.hypotheses.length) errors.push('Duplicate current hypotheses.');
  if (world.examples_observed !== undefined && world.examples_observed !== (world.archived_examples ?? 0) + world.examples.length) errors.push('Example count does not reconcile.');
  if (world.validation_runs !== undefined && world.validation_runs !== (world.archived_validations ?? 0) + world.validations.length) errors.push('Validation count does not reconcile.');
  if (world.hypotheses.some(hypothesis => !LANGUAGE_RULES.includes(hypothesis.rule) || !Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1 || !Number.isInteger(hypothesis.tested) || hypothesis.tested < hypothesis.passed || hypothesis.passed < 0)) errors.push('Invalid hypothesis evidence.');
  if (world.translation_accuracy !== null && (!Number.isFinite(world.translation_accuracy) || world.translation_accuracy < 0 || world.translation_accuracy > 1)) errors.push('Invalid translation accuracy.');
  const oracle = experiment._private?.language_oracle ?? languageOracle(experiment.id);
  if (world.examples.some(example => !LANGUAGE_SUBJECTS.includes(example.subject) || !LANGUAGE_VERBS.includes(example.verb) || !LANGUAGE_OBJECTS.includes(example.object) || !['present', 'past'].includes(example.tense) || example.alien !== translate(example, oracle))) errors.push('Observed example contradicts the language oracle.');
}

function validRoute(grid, route) {
  if (!route || !Array.isArray(route.path) || !Array.isArray(route.picks) || route.steps !== route.path.length - 1 || !route.path.length) return false;
  const walls = new Set(grid.walls.map(cellKey));
  if (cellKey(route.path[0]) !== cellKey(grid.depot) || cellKey(route.path.at(-1)) !== cellKey(grid.depot)) return false;
  for (let i = 0; i < route.path.length; i += 1) {
    const cell = route.path[i];
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.x >= grid.width || cell.y < 0 || cell.y >= grid.height || walls.has(cellKey(cell))) return false;
    if (i && Math.abs(cell.x - route.path[i - 1].x) + Math.abs(cell.y - route.path[i - 1].y) !== 1) return false;
  }
  const visited = new Set(route.path.map(cellKey));
  return route.picks.every(pick => visited.has(cellKey(pick)));
}

function validateLeague(experiment, errors) {
  const world = experiment.world;
  if (!isRecord(world.challenge) || !Array.isArray(world.fixtures) || !isRecord(world.champion) || !Array.isArray(world.candidates) || !Array.isArray(world.leaderboard)) { errors.push('Missing routing state.'); return; }
  if (!validRoute(world.challenge, world.replay)) errors.push('Invalid replay path.');
  if (!Array.isArray(world.champion.routes) || world.champion.routes.some(route => !validRoute(world.challenge, route))) errors.push('Invalid champion route.');
  if (world.champion.training_steps !== sum(world.champion.routes.map(route => route.steps))) errors.push('Champion training score does not match route paths.');
  if (world.champion.total_steps !== world.champion.training_steps + world.champion.unseen_steps) errors.push('Champion score does not reconcile.');
  if (world.promotions !== (world.archived_candidates?.promotions ?? 0) + world.candidates.filter(candidate => candidate.promoted).length) errors.push('Promotion count does not reconcile.');
  if (world.candidates_tested !== undefined && world.candidates_tested !== (world.archived_candidates?.count ?? 0) + world.candidates.length) errors.push('Candidate count does not reconcile.');
  for (const candidate of world.candidates) {
    if (!Array.isArray(candidate.routes) || candidate.routes.some(route => !validRoute(world.challenge, route))) errors.push(`Invalid candidate path: ${candidate.id}.`);
    if (candidate.training_steps !== sum(candidate.routes.map(route => route.steps))) errors.push(`Candidate score does not match path: ${candidate.id}.`);
    if (candidate.promoted && (candidate.improvement_training_steps <= 0 || candidate.improvement_unseen_steps < 0)) errors.push(`Promotion did not improve: ${candidate.id}.`);
  }
}

/** Returns a report; malformed data is reported instead of throwing. */
export function validateExperiment(experiment) {
  const errors = [];
  try {
    if (!isRecord(experiment)) return { valid: false, errors: ['Experiment must be an object.'] };
    if (experiment.schema_version !== 1) errors.push('Unsupported schema version.');
    if (typeof experiment.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(experiment.id)) errors.push('Invalid experiment ID.');
    if (!Object.hasOwn(TYPE_CATALOG, experiment.type)) errors.push('Unknown experiment type.');
    if (!['active', 'completed', 'insolvent'].includes(experiment.status)) errors.push('Invalid status.');
    if (!Number.isInteger(experiment.turn) || experiment.turn < 0) errors.push('Invalid turn number.');
    if (!Number.isFinite(Date.parse(experiment.created_at)) || !Number.isFinite(Date.parse(experiment.updated_at)) || Date.parse(experiment.updated_at) < Date.parse(experiment.created_at)) errors.push('Invalid experiment timestamps.');
    if (!Array.isArray(experiment.timeline) || experiment.timeline.length !== experiment.turn) errors.push('Timeline length does not match turn.');
    if (!Array.isArray(experiment.metrics) || !Array.isArray(experiment.roles) || !Array.isArray(experiment.allowed_actions) || !isRecord(experiment.memory) || !isRecord(experiment.world)) errors.push('Missing experiment fields.');
    if (errors.length) return { valid: false, errors };
    let previousTime = Date.parse(experiment.created_at);
    const decisionIds = new Set();
    for (const [i, event] of experiment.timeline.entries()) {
      if (!isRecord(event) || event.turn !== i + 1 || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < previousTime) { errors.push(`Invalid timeline sequence at index ${i}.`); continue; }
      previousTime = Date.parse(event.at);
      if (!isRecord(event.decision) || typeof event.decision.action !== 'string' || !isRecord(event.decision.params) || typeof event.reason !== 'string' || typeof event.observation !== 'string' || typeof event.consequence !== 'string' || !Array.isArray(event.evidence) || !Array.isArray(event.alternatives) || !isRecord(event.snapshot) || !isRecord(event.memory)) errors.push(`Missing timeline event fields at turn ${event.turn}.`);
      if (event.decision_id) { if (decisionIds.has(event.decision_id)) errors.push('Duplicate decision ID.'); decisionIds.add(event.decision_id); }
    }
    if (experiment.timeline.length && experiment.timeline.at(-1).at !== experiment.updated_at) errors.push('Updated timestamp does not match the latest event.');
    if (!Array.isArray(experiment.memory.observations) || !Array.isArray(experiment.memory.facts) || experiment.memory.observations.length !== Math.min(experiment.turn, TYPE_CATALOG[experiment.type].memory_window)) errors.push('Memory does not match the timeline window.');
    if (experiment.type === 'bicycle-company') validateCompany(experiment, errors);
    if (experiment.type === 'alien-language') validateLanguage(experiment, errors);
    if (experiment.type === 'invention-league') validateLeague(experiment, errors);
    if (experiment.type === 'flood-city') validateCity(experiment, errors);
    if (experiment.type === 'life-research') {
      const report = validateLifeWorld(experiment.world);
      if (!report.valid) errors.push(...report.errors);
    }
  } catch (error) { errors.push(`Malformed environment data: ${error.message}`); }
  return { valid: errors.length === 0, errors };
}

/** Strip answer sheets and future private fields recursively, without changing input. */
export function toPublicExperiment(experiment) {
  const redact = value => {
    if (Array.isArray(value)) return value.map(redact);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_private')).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  return redact(clone(experiment));
}

export function summarizeExperiment(experiment) {
  const report = validateExperiment(experiment);
  if (!report.valid) throw new Error(`Cannot summarize invalid experiment: ${report.errors.join('; ')}`);
  return { id: experiment.id, type: experiment.type, title: experiment.title, description: experiment.description,
    turn: experiment.turn, status: experiment.status, created_at: experiment.created_at, updated_at: experiment.updated_at,
    metrics: clone(experiment.metrics), latest_decision: experiment.timeline.length ? clone(experiment.timeline.at(-1)) : null,
    snapshot: snapshots[experiment.type](experiment.world) };
}
