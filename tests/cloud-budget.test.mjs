import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRecordedRunCost,reconcileUnknownCosts,reserveBudget,settleBudget,budgetSummary} from '../cloud-budget.mjs';

const at='2026-10-12T08:00:00.000Z',later='2026-10-12T09:00:00.000Z';
const observed=(id,cost,settled_at=at,model='gpt-6-luna')=>({id,day:settled_at.slice(0,10),at:settled_at,
  status:'observed',settled_at,charged_usd:cost,cost_usd:cost,usage:{status:'observed',model,costUsd:cost}});
const rawUnknown={status:'unknown',reason:'trusted_completed_cli_usage_unavailable',model:'gpt-6-luna',
  inputTokens:null,cachedInputTokens:null,outputTokens:null,costUsd:null};
const unknown=(id='tick-99-1')=>({id,day:'2026-10-12',at,status:'unknown',settled_at:at,
  charged_usd:0.10,cost_usd:null,usage:structuredClone(rawUnknown)});
const ledger=runs=>({schema_version:1,runs});

test('recorded estimate uses the latest twenty same-model measured settlements and no future data',()=>{
  const history=[observed('tick-1-1',0.90,'2026-10-11T00:00:00.000Z')];
  for(let i=0;i<20;i++)history.push(observed('tick-'+(i+2)+'-1',i===19?0.015235175:0.014,'2026-10-12T07:'+String(i).padStart(2,'0')+':00.000Z'));
  history.push(observed('tick-80-1',0.80,'2026-10-12T10:00:00.000Z'),observed('tick-81-1',0.70,at,'different-model'));
  history.push({...observed('tick-82-1',0.60),status:'estimated'},observed('tick-83-1',Infinity),observed('tick-84-1',-1));
  const before=structuredClone(history),estimate=estimateRecordedRunCost(ledger(history.reverse()),at);
  assert.equal(estimate.estimated_cost_usd,0.04);assert.equal(estimate.basis.observed_max_usd,0.015235175);
  assert.equal(estimate.basis.sample_count,20);assert.deepEqual(estimate.basis.sample_ids,Array.from({length:20},(_,i)=>'tick-'+(i+2)+'-1'));
  assert.equal(estimate.basis.multiplier,2);assert.equal(estimate.basis.as_of,at);
  assert.deepEqual(history, before.reverse());
});

test('estimate rounds upward to cents, retains the minimum, and has an explicit no-history fallback',()=>{
  assert.equal(estimateRecordedRunCost(ledger([observed('tick-1-1',0.035)]),at).estimated_cost_usd,0.07);
  assert.equal(estimateRecordedRunCost(ledger([observed('tick-1-1',0.0001)]),at).estimated_cost_usd,0.02);
  const fallback=estimateRecordedRunCost(ledger([]),at);
  assert.equal(fallback.estimated_cost_usd,0.10);assert.equal(fallback.basis.method,'no_history_reservation_fallback');
  assert.equal(fallback.basis.observed_max_usd,null);assert.deepEqual(fallback.basis.sample_ids,[]);
});

test('unknown completed usage settles as a labelled estimate without inventing token counts',()=>{
  const original=ledger([observed('tick-1-1',0.015)]),reserved=reserveBudget(original,'tick-2-1',at).ledger;
  const result=settleBudget(reserved,'tick-2-1',rawUnknown,later),entry=result.runs.at(-1);
  assert.equal(entry.status,'estimated');assert.equal(entry.charged_usd,0.03);assert.equal(entry.estimated_cost_usd,0.03);
  assert.equal(entry.cost_usd,null);assert.deepEqual(entry.usage,rawUnknown);assert.equal(entry.settled_at,later);
  assert.deepEqual(entry.estimate_basis.sample_ids,['tick-1-1']);assert.equal(reserved.runs.at(-1).status,'reserved');
  assert.equal(reserveBudget(result,'tick-3-1',later).allowed,true);
  assert.equal(reserveBudget(result,'tick-2-1',later).reason,'attempt_already_reserved');
  assert.throws(()=>settleBudget(result,'tick-2-1',rawUnknown,later),/already settled/);
  const summary=budgetSummary(result,later);assert.equal(summary.observed_usd,0.015);assert.equal(summary.estimated_usd,0.03);
  assert.equal(summary.estimated_run_count,1);assert.equal(summary.spent_usd,0.045);assert.equal(summary.reserved_usd,0);
  assert.match(summary.accounting,/fallback estimates/);
});

test('measured settlement remains measured and never acquires fallback metadata',()=>{
  const reserved=reserveBudget(ledger([]),'tick-1-1',at).ledger,usage={status:'observed',model:'gpt-6-luna',costUsd:0.012,inputTokens:1000,outputTokens:22000};
  const entry=settleBudget(reserved,'tick-1-1',usage,later).runs[0];
  assert.equal(entry.status,'observed');assert.equal(entry.charged_usd,usage.costUsd);assert.equal(entry.cost_usd,usage.costUsd);
  assert.deepEqual(entry.usage,usage);assert.equal(Object.hasOwn(entry,'estimate_basis'),false);
});

test('legacy reconciliation preserves original unknown accounting and raw usage, using only its historical cutoff',()=>{
  const original=ledger([observed('tick-1-1',0.015,'2026-10-12T07:00:00.000Z'),unknown(),observed('tick-2-1',0.80,'2026-10-12T08:30:00.000Z')]);
  const before=structuredClone(original),reconciled=reconcileUnknownCosts(original,later),entry=reconciled.runs[1];
  assert.equal(entry.status,'estimated');assert.equal(entry.charged_usd,0.03);assert.equal(entry.cost_usd,null);
  assert.deepEqual(entry.usage,rawUnknown);assert.equal(entry.estimate_basis.as_of,at);
  assert.deepEqual(entry.estimate_basis.sample_ids,['tick-1-1']);
  assert.deepEqual(entry.original_unknown,{status:'unknown',charged_usd:0.1,settled_at:at,cost_usd:null,usage:rawUnknown});
  assert.equal(entry.cost_adjustments.length,1);assert.equal(entry.cost_adjustments[0].reconciled_at,later);
  assert.equal(entry.cost_adjustments[0].previous_charged_usd,0.1);
  assert.deepEqual(reconcileUnknownCosts(reconciled,'2026-10-12T10:00:00.000Z'),reconciled);
  assert.deepEqual(original,before);
});

test('pending reservations and not-yet-settled unknown entries are never reconciled',()=>{
  const pending={id:'tick-1-1',day:'2026-10-12',at,status:'reserved',charged_usd:0.1,cost_usd:null};
  const future={...unknown('tick-2-1'),settled_at:'2026-10-12T10:00:00.000Z'},missing={...unknown('tick-3-1')};delete missing.settled_at;
  const original=ledger([pending,future,missing]);
  assert.deepEqual(reconcileUnknownCosts(original,later),original);
  assert.equal(reserveBudget(original,'tick-4-1',later).reason,'usage_unknown');
  assert.equal(budgetSummary(original,later).reserved_usd,0.30000000000000004);
});

test('reservations reconcile legacy entries before duplicate or cap rejection and include estimated spending',()=>{
  const history=Array.from({length:20},(_,i)=>observed('tick-'+(i+1)+'-1',0.09)),original=ledger([...history,unknown('tick-99-1')]);
  const blocked=reserveBudget(original,'tick-100-1',later),summary=budgetSummary(blocked.ledger,later);
  assert.equal(blocked.allowed,false);assert.equal(blocked.reason,'paused_budget');
  assert.equal(blocked.ledger.runs.at(-1).status,'estimated');assert.equal(summary.estimated_usd,0.18);
  assert(Math.abs(summary.spent_usd-1.98)<1e-12);assert.equal(summary.estimated_run_count,1);
  assert.equal(blocked.ledger.runs.length,original.runs.length);
  const duplicate=reserveBudget(original,'tick-99-1',later);
  assert.equal(duplicate.reason,'attempt_already_reserved');assert.equal(duplicate.ledger.runs.at(-1).status,'estimated');
  const nextDay=reserveBudget(blocked.ledger,'tick-101-1','2026-10-13T00:00:00.000Z');
  assert.equal(nextDay.allowed,true);assert.equal(nextDay.ledger.runs.at(-1).charged_usd,0.1);
  assert.equal(budgetSummary(blocked.ledger,'2026-10-13T00:00:00.000Z').spent_usd,0);
});

test('malformed accounting cannot silently disappear from the daily spending gate',()=>{
  for(const entry of [{...observed('tick-1-1',.5),status:'unrecognized'},
    {...observed('tick-1-1',.5),charged_usd:-1},
    {...observed('tick-1-1',.5),charged_usd:Infinity}]){
    assert.throws(()=>budgetSummary(ledger([entry]),at),/Invalid cost ledger/);
    assert.throws(()=>reserveBudget(ledger([entry]),'tick-2-1',at),/Invalid cost ledger/);
  }
});
