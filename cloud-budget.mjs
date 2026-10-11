export const DAILY_CAP_USD = 2;
export const RUN_RESERVATION_USD = 0.10;
const dayOf = at => new Date(at).toISOString().slice(0,10);
const validMoney = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function budgetSummary(ledger, at) {
  const day=dayOf(at), runs=(ledger?.runs || []).filter(r=>r.day===day);
  if(runs.some(r=>!validMoney(r.charged_usd)))throw new Error('Invalid cost ledger');
  const spent=runs.filter(r=>r.status==='observed').reduce((n,r)=>n+r.charged_usd,0);
  const reserved=runs.filter(r=>r.status!=='observed').reduce((n,r)=>n+r.charged_usd,0);
  const unknown=runs.some(r=>r.status==='unknown'||r.status==='reserved');
  return {daily_cap_usd:DAILY_CAP_USD,day,spent_usd:spent,reserved_usd:reserved,
    status:unknown?'usage_unknown':spent+reserved+RUN_RESERVATION_USD>DAILY_CAP_USD?'paused_budget':'available',
    accounting:'Reported CLI token estimates at published standard rates; not an invoice.'};
}

export function reserveBudget(ledger, runId, at) {
  if(!/^tick-\d+-[1-9]\d*$/.test(runId))throw new Error('Invalid cloud run identity');
  if(ledger?.runs?.some(r=>r.id===runId))return {allowed:false,reason:'attempt_already_reserved',ledger};
  const current=budgetSummary(ledger,at);
  if(current.status!=='available')return {allowed:false,reason:current.status,ledger};
  const next=structuredClone(ledger||{schema_version:1,runs:[]});
  next.runs.push({id:runId,day:current.day,at,status:'reserved',charged_usd:RUN_RESERVATION_USD,cost_usd:null});
  return {allowed:true,ledger:next};
}

export function settleBudget(ledger,runId,usage,at) {
  const next=structuredClone(ledger), entry=next.runs.find(r=>r.id===runId);
  if(!entry)throw new Error('No budget reservation');
  if(entry.status!=='reserved')throw new Error('Budget attempt was already settled');
  const known=usage?.status==='observed'&&validMoney(usage.costUsd)&&usage.model==='gpt-6-luna';
  Object.assign(entry,{status:known?'observed':'unknown',settled_at:at,
    charged_usd:known?usage.costUsd:RUN_RESERVATION_USD,cost_usd:known?usage.costUsd:null,
    usage:usage || {status:'unknown',reason:'usage_not_available'}});
  return next;
}
