export const DAILY_CAP_USD = 2;
export const RUN_RESERVATION_USD = 0.10;
const dayOf = at => new Date(at).toISOString().slice(0,10);
const validMoney = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function estimateRecordedRunCost(ledger, at) {
  const cutoff = Date.parse(at);
  if (!Number.isFinite(cutoff)) throw new Error('Invalid estimate time');
  const samples = (ledger?.runs || []).filter(r => r.status === 'observed'
    && r.usage?.model === 'gpt-6-luna' && validMoney(r.cost_usd)
    && validInstant(r.settled_at) && Date.parse(r.settled_at) <= cutoff)
    .sort((a,b) => Date.parse(a.settled_at) - Date.parse(b.settled_at)).slice(-20);
  const maximum = samples.length ? Math.max(...samples.map(r => r.cost_usd)) : null;
  // Remove floating-point noise at exact cent boundaries before rounding upward.
  const rounded = maximum === null ? RUN_RESERVATION_USD
    : Math.ceil(Number((maximum * 2 * 100).toPrecision(15))) / 100;
  const estimated_cost_usd = Math.max(0.02, rounded);
  if (!validMoney(estimated_cost_usd)) throw new Error('Recorded cost estimate is not finite');
  return {estimated_cost_usd, basis:{
    method:samples.length ? 'twice_maximum_recorded_run' : 'no_history_reservation_fallback',
    model:'gpt-6-luna',as_of:new Date(at).toISOString(),sample_ids:samples.map(r => r.id),
    sample_count:samples.length,sample_limit:20,observed_max_usd:maximum,multiplier:2,
    rounding:'up_to_whole_cents',minimum_usd:0.02,fallback_usd:RUN_RESERVATION_USD,
  }};
}

export function reconcileUnknownCosts(ledger, at) {
  const cutoff = Date.parse(at);
  if (!Number.isFinite(cutoff)) throw new Error('Invalid reconciliation time');
  const next = structuredClone(ledger || {schema_version:1,runs:[]});
  for (const entry of next.runs) {
    if (entry.status !== 'unknown' || !validInstant(entry.settled_at)
      || Date.parse(entry.settled_at) > cutoff) continue;
    const estimate = estimateRecordedRunCost(ledger, entry.settled_at);
    const original_unknown = {status:entry.status,charged_usd:entry.charged_usd,settled_at:entry.settled_at};
    for (const field of ['cost_usd','usage']) if (Object.hasOwn(entry,field)) original_unknown[field] = structuredClone(entry[field]);
    const adjustment = {kind:'unknown_cost_estimate',reconciled_at:new Date(at).toISOString(),
      previous_status:entry.status,previous_charged_usd:entry.charged_usd,
      estimated_cost_usd:estimate.estimated_cost_usd,estimate_basis:estimate.basis};
    Object.assign(entry,{status:'estimated',charged_usd:estimate.estimated_cost_usd,cost_usd:null,
      estimated_cost_usd:estimate.estimated_cost_usd,estimate_basis:estimate.basis,original_unknown,
      cost_adjustments:[...(entry.cost_adjustments || []),adjustment]});
  }
  return next;
}

export function budgetSummary(ledger, at) {
  const day=dayOf(at), runs=(ledger?.runs || []).filter(r=>r.day===day);
  if(runs.some(r=>!validMoney(r.charged_usd)||!['observed','estimated','reserved','unknown'].includes(r.status)))throw new Error('Invalid cost ledger');
  const observed=runs.filter(r=>r.status==='observed').reduce((n,r)=>n+r.charged_usd,0);
  const estimates=runs.filter(r=>r.status==='estimated');
  const estimated=estimates.reduce((n,r)=>n+r.charged_usd,0),spent=observed+estimated;
  const reserved=runs.filter(r=>r.status==='reserved'||r.status==='unknown').reduce((n,r)=>n+r.charged_usd,0);
  const unknown=runs.some(r=>r.status==='unknown'||r.status==='reserved');
  return {daily_cap_usd:DAILY_CAP_USD,day,spent_usd:spent,observed_usd:observed,
    estimated_usd:estimated,estimated_run_count:estimates.length,reserved_usd:reserved,
    status:unknown?'usage_unknown':spent+reserved+RUN_RESERVATION_USD>DAILY_CAP_USD?'paused_budget':'available',
    accounting:'CLI token estimates plus historical recorded-run fallback estimates; not an invoice.'};
}

export function reserveBudget(ledger, runId, at) {
  if(!/^tick-\d+-[1-9]\d*$/.test(runId))throw new Error('Invalid cloud run identity');
  const next=reconcileUnknownCosts(ledger,at);
  if(next.runs.some(r=>r.id===runId))return {allowed:false,reason:'attempt_already_reserved',ledger:next};
  const current=budgetSummary(next,at);
  if(current.status!=='available')return {allowed:false,reason:current.status,ledger:next};
  next.runs.push({id:runId,day:current.day,at,status:'reserved',charged_usd:RUN_RESERVATION_USD,cost_usd:null});
  return {allowed:true,ledger:next};
}

export function settleBudget(ledger,runId,usage,at) {
  const next=structuredClone(ledger), entry=next.runs.find(r=>r.id===runId);
  if(!entry)throw new Error('No budget reservation');
  if(entry.status!=='reserved')throw new Error('Budget attempt was already settled');
  const known=usage?.status==='observed'&&validMoney(usage.costUsd)&&usage.model==='gpt-6-luna';
  if (known) Object.assign(entry,{status:'observed',settled_at:at,charged_usd:usage.costUsd,
    cost_usd:usage.costUsd,usage:structuredClone(usage)});
  else {
    const estimate=estimateRecordedRunCost(ledger,at);
    Object.assign(entry,{status:'estimated',settled_at:at,charged_usd:estimate.estimated_cost_usd,
      cost_usd:null,estimated_cost_usd:estimate.estimated_cost_usd,estimate_basis:estimate.basis,
      usage:usage === undefined ? {status:'unknown',reason:'usage_not_available'} : structuredClone(usage)});
  }
  return next;
}
