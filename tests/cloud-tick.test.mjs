import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createExperiment,toPublicExperiment,applyDecision} from '../engine.mjs';
import {prepareCloudTick,applyCloudTick,observe,checkpoint,validateDecisions,reviewCloudDecisions,rejectCloudTick,decisionSchema} from '../scripts/cloud-tick.mjs';
import {reserveBudget,settleBudget,budgetSummary} from '../cloud-budget.mjs';
import {parseCodexUsage} from '../cloud-usage.mjs';
import {canonicalPublic} from '../publish.mjs';

const at='2026-10-11T16:00:00.000Z', end='2026-10-11T16:01:00.000Z';
const ledger=()=>({schema_version:1,runs:[]});
const company=()=>createExperiment({id:'company',type:'bicycle-company',createdAt:at});
const state=()=>({schema_version:1,title:'Observatory',created_at:at,updated_at:at,revision:50,
  schedule:{runner:'cloud-validation',status:'active',factory_minutes:60,loop_minutes:15,next_tick_at:at,next_launch_at:at},
  experiments:[toPublicExperiment(company())],launches:[]});
const prep=(s=state())=>prepareCloudTick({state:s,ledger:ledger(),at,runId:'tick-123-1',runUrl:'https://github.com/xndanius/autonomous-observatory/actions/runs/123'});
const params=e=>e.type==='alien-language'?{subject:'I',verb:'see',object:'stone',tense:'present'}:{};
const raw=p=>({decisions:p.context.experiments.map(e=>({experiment_id:e.id,action:e.type==='alien-language'?'probe':'rest',params_json:JSON.stringify(params(e)),reason:'Operations chooses observation while the reviewer rejects an unsupported early guess.',alternatives:['Purchase parts now: not required by current orders.','Change prices immediately: first observe measured demand.']}))});
const usage={status:'observed',model:'gpt-6-luna',inputTokens:1000,cachedInputTokens:0,outputTokens:1000,costUsd:0.0006};

test('original-containing gate artifact and context hashes survive exact JSON serialization',()=>{
  const p=prep(),roundtrip=JSON.parse(JSON.stringify(p));
  assert.equal(canonicalPublic(p),canonicalPublic(roundtrip));
  assert.equal(canonicalPublic(p.context),canonicalPublic(roundtrip.context));
  assert.equal(Object.hasOwn(p.context.experiments[0],'seed'),false);
});

test('fresh cloud tick advances existing world and launches a distinct seeded instance with actual evidence',()=>{
  const p=prep(),before=structuredClone(p.state);
  const settled=settleBudget(p.ledger,p.runId,usage,end);
  const result=applyCloudTick(p,raw(p),{at:end,usage,ledger:settled});
  assert.equal(result.state.experiments.length,2);
  assert.deepEqual(result.state.experiments.map(e=>e.turn),[1,1]);
  assert.equal(result.state.schedule.last_tick_at,end);
  assert.equal(result.state.schedule.next_tick_at,'2026-10-11T16:15:00.000Z');
  assert.equal(result.state.schedule.next_launch_at,'2026-10-11T17:00:00.000Z');
  assert.equal(result.record.launch,p.launch.id);
  assert.ok(result.state.experiments[1].seed);
  assert.equal(result.state.experiments[1].campaign_turn_limit,12);
  assert.deepEqual(p.state,before);
  assert.equal(JSON.stringify(result.state).includes('_private'),false);
});
test('wrong/duplicate IDs, omitted alternatives and invalid parameters reject the complete tick',()=>{
  const p=prep(),input=raw(p);input.decisions[1].experiment_id=input.decisions[0].experiment_id;
  assert.throws(()=>validateDecisions(input,p.context.experiments.map(e=>e.id)),/duplicate/);
  const valid=raw(p);valid.decisions[0].alternatives=[];
  assert.throws(()=>validateDecisions(valid,p.context.experiments.map(e=>e.id)),/alternatives/);
  const invalid=raw(p);invalid.decisions[1].params_json='{"subject":"everyone"}';
  assert.throws(()=>applyCloudTick(p,invalid,{at:end,usage,ledger:p.ledger}));
  assert.equal(p.state.experiments[0].turn,0);
});

test('a fully repaired cafe remains active, and an omitted review is identified without fabricated progress',()=>{
  let cafe=createExperiment({id:'repair-cafe-007',type:'repair-cafe',createdAt:at});
  for(const [app_id,source] of Object.entries({checkout:'floor(x*y*(100-z)/100)',temperature:'x*9/5+32',boxes:'ceil(x/y)',travel:'x/y*60'})){
    cafe=applyDecision(cafe,{action:'repair',params:{app_id,source}},{now:at});
  }
  assert.equal(cafe.world.queue.length,0);assert.equal(cafe.status,'active');
  const s=state();s.experiments.push(toPublicExperiment(cafe));s.schedule.next_launch_at='2026-10-11T17:00:00Z';
  const p=prep(s),before=structuredClone(p.state),input=raw(p);
  input.decisions=input.decisions.filter(d=>d.experiment_id!==cafe.id);
  const review=reviewCloudDecisions(p,input,{at:end});
  assert.equal(review.status,'rejected');assert.equal(review.errors[0].experiment_id,cafe.id);
  assert.match(review.errors[0].error,/goal appears complete/);
  assert.throws(()=>applyCloudTick(p,input,{at:end,usage,ledger:p.ledger}),/Exactly one decision/);
  assert.deepEqual(p.state,before);
  const contract=decisionSchema(p.context.experiments.map(e=>e.id));
  assert.equal(contract.properties.decisions.minItems,p.context.experiments.length);
  assert.equal(contract.properties.decisions.maxItems,p.context.experiments.length);
  input.decisions.push({experiment_id:cafe.id,action:'inspect',params_json:'{"app_id":"checkout"}',reason:'The cafe is fully repaired but active; the reviewer checks its deployed checkout against regression fixtures.',alternatives:['Apply an unchanged patch: it would create no useful repair.','Omit this cafe: an active experiment still requires a review.']});
  const result=applyCloudTick(p,input,{at:end,usage,ledger:settleBudget(p.ledger,p.runId,usage,end)});
  assert.equal(result.state.experiments.find(e=>e.id===cafe.id).turn,cafe.turn+1);
  assert.equal(result.state.experiments.find(e=>e.id===cafe.id).world.latest_record.verdict,'inspected');
});

function emptyChainCompany(){
  let e=createExperiment({id:'seeded-company',type:'bicycle-company',createdAt:at,seed:{version:1,value:'review-recovery-regression'}});
  for(let i=0;i<40;i++){
    const waiting=e.world.orders.find(o=>o.status==='waiting'&&o.service==='chain');
    if(e.world.inventory.chain.quantity===0&&waiting)return e;
    e=applyDecision(e,waiting&&e.world.inventory.chain.quantity>0?{action:'service',params:{order_id:waiting.id}}:{action:'rest'},{now:at});
  }
  assert.fail('Seeded regression fixture never reached an empty-chain waiting order');
}

test('an infeasible seeded repair gives the next fresh council feedback without advancing any world',()=>{
  const s=state(),seeded=emptyChainCompany();
  s.experiments.push(toPublicExperiment(seeded));s.schedule.next_launch_at='2026-10-11T17:00:00.000Z';
  const p=prep(s),before=structuredClone(p.state),input=raw(p),order=seeded.world.orders.find(o=>o.status==='waiting'&&o.service==='chain');
  const rejected=input.decisions.find(d=>d.experiment_id===seeded.id);
  Object.assign(rejected,{action:'service',params_json:JSON.stringify({order_id:order.id})});
  const review=reviewCloudDecisions(p,input,{at:end});
  assert.equal(review.status,'rejected');assert.equal(review.error_count,1);
  assert.deepEqual(review.errors,[{experiment_id:seeded.id,action:'service',error:'Insufficient chain stock for this batch.'}]);
  assert.throws(()=>applyCloudTick(p,input,{at:end,usage,ledger:p.ledger}),/Insufficient chain stock/);
  assert.deepEqual(p.state,before);
  const settled=settleBudget(p.ledger,p.runId,usage,end),failure=rejectCloudTick(p,review,{at:end,usage,ledger:settled});
  assert.deepEqual(failure.state.experiments,before.experiments);assert.deepEqual(failure.state.launches,before.launches);
  assert.equal(failure.record.status,'rejected');assert.equal(failure.record.validation_review.run_id,p.runId);
  assert.equal(failure.record.validation_review.at,end);assert.equal(failure.state.schedule.last_tick_at,before.schedule.last_tick_at);
  const retryAt='2026-10-11T16:15:00.000Z',publishedAt='2026-10-11T16:16:00.000Z';
  const q=prepareCloudTick({state:failure.state,ledger:settled,at:retryAt,runId:'tick-124-1',runUrl:'https://github.com/xndanius/autonomous-observatory/actions/runs/124'});
  assert.deepEqual(q.context.last_rejected_attempt,failure.record.validation_review);
  const observed=q.context.experiments.find(e=>e.id===seeded.id);
  assert(!observed.service_preflight.single_order_ids.includes(order.id));
  assert(observed.service_preflight.single_order_ids.length>0,'Other stocked single orders remain available to the council');
  assert.match(observed.service_preflight.scope,/no repair has been performed/);
  const correction=raw(q);Object.assign(correction.decisions.find(d=>d.experiment_id===seeded.id),{action:'purchase',params_json:'{"part":"chain","quantity":1}'});
  assert.equal(reviewCloudDecisions(q,correction,{at:publishedAt}).status,'accepted');
  assert.deepEqual(q.state,failure.state);
  const published=applyCloudTick(q,correction,{at:publishedAt,usage,ledger:settleBudget(q.ledger,q.runId,usage,publishedAt)});
  assert(published.state.experiments.every((e,i)=>e.turn===before.experiments[i].turn+1));
  assert.equal(published.state.experiments.find(e=>e.id===seeded.id).world.inventory.chain.quantity,1);
  assert.equal(published.state.schedule.last_attempt_result,'published');assert.equal(published.state.schedule.last_rejection_review,null);
  const next=prepareCloudTick({state:published.state,ledger:settleBudget(q.ledger,q.runId,usage,publishedAt),at:'2026-10-11T16:30:00.000Z',runId:'tick-125-1',runUrl:'https://github.com/xndanius/autonomous-observatory/actions/runs/125'});
  assert.equal(Object.hasOwn(next.context,'last_rejected_attempt'),false);
});

test('review feedback caps errors and messages, and malformed envelopes disclose no raw parameters',()=>{
  const s=state();s.schedule.next_launch_at='2026-10-11T17:00:00.000Z';
  s.experiments=Array.from({length:14},(_,i)=>toPublicExperiment(createExperiment({id:'company-'+i,type:'bicycle-company',createdAt:at})));
  const p=prep(s),input=raw(p);
  for(const d of input.decisions)Object.assign(d,{action:'service',params_json:JSON.stringify({order_id:'missing-'+ 'x'.repeat(1000)})});
  const review=reviewCloudDecisions(p,input,{at:end});
  assert.equal(review.error_count,14);assert.equal(review.errors.length,12);
  assert(review.errors.every(e=>e.error.length<=300&&e.action==='service'));
  input.decisions[0].params_json='UNPARSEABLE_PARAMETERS_MUST_NOT_BE_ECHOED';
  const malformed=reviewCloudDecisions(p,input,{at:end});
  assert.deepEqual(malformed.errors.map(e=>[e.experiment_id,e.action]),[[null,null]]);
  assert.match(malformed.errors[0].error,/envelope failed validation/);
  assert(!JSON.stringify(malformed).includes(input.decisions[0].params_json));
});
test('cloud ownership, paused state and future due times prevent model reservation',()=>{
  for(const [change,reason] of [[{runner:'mac'},'cloud_does_not_own_writer'],[{status:'paused'},'paused'],[{next_tick_at:'2026-10-11T17:00:00.000Z'},'not_due']]){
    const s=state();Object.assign(s.schedule,change);const p=prep(s);
    assert.equal(p.allowed,false);assert.equal(p.reason,reason);assert.deepEqual(p.ledger,ledger());
  }
});

test('a completed unknown-cost attempt is accounted before the next real council reservation',()=>{
  const prior={schema_version:1,runs:[
    {id:'tick-100-1',day:'2026-10-11',at:'2026-10-11T15:40:00Z',settled_at:'2026-10-11T15:41:00Z',status:'observed',charged_usd:.015,cost_usd:.015,usage:{status:'observed',model:'gpt-6-luna',costUsd:.015}},
    {id:'tick-101-1',day:'2026-10-11',at:'2026-10-11T15:55:00Z',settled_at:'2026-10-11T15:59:00Z',status:'unknown',charged_usd:.1,cost_usd:null,usage:{status:'unknown',reason:'completed_cli_usage_not_found',model:'gpt-6-luna',costUsd:null}}
  ]};
  const original=structuredClone(prior),s=state();s.schedule.next_launch_at='2026-10-11T17:00:00Z';
  const p=prepareCloudTick({state:s,ledger:prior,at,runId:'tick-123-1',runUrl:'https://github.com/xndanius/autonomous-observatory/actions/runs/123'});
  assert.equal(p.allowed,true);
  assert.equal(p.ledger.runs.find(r=>r.id==='tick-101-1').status,'estimated');
  assert.equal(p.ledger.runs.find(r=>r.id==='tick-101-1').charged_usd,.03);
  assert.deepEqual(p.ledger.runs.find(r=>r.id==='tick-101-1').usage,original.runs[1].usage);
  assert.equal(p.ledger.runs.find(r=>r.id===p.runId).status,'reserved');
  assert.deepEqual(prior,original);assert.deepEqual(p.state,s);
  const result=applyCloudTick(p,raw(p),{at:end,usage,ledger:settleBudget(p.ledger,p.runId,usage,end)});
  assert.equal(result.state.experiments[0].turn,1);
  assert.equal(result.state.schedule.budget.status,'available');
  assert.equal(result.state.schedule.budget.estimated_usd,.03);
  assert.equal(result.state.schedule.budget.estimated_run_count,1);
});
test('public checkpoints resume a bounded suffix without fetching or replacing archived events',()=>{
  let c=company();for(let i=0;i<18;i++)c=applyDecision(c,{action:'rest',reason:'Observe this deterministic turn.'},{now:at});
  const publicC=toPublicExperiment(c);publicC.timeline=publicC.timeline.slice(-12);
  const resumed=checkpoint(publicC);assert.equal(resumed.timeline_start_turn,7);
  const fullNext=applyDecision(c,{action:'rest'},{now:end}),suffixNext=applyDecision(resumed,{action:'rest'},{now:end});
  assert.deepEqual(suffixNext.world,fullNext.world);assert.deepEqual(suffixNext.timeline.at(-1),fullNext.timeline.at(-1));
  assert.deepEqual(suffixNext.memory,fullNext.memory);
  assert.equal(observe(suffixNext).recent_timeline.some(e=>e.snapshot),false);
});
test('seeded campaign completes only after twelve actual decisions; original worlds continue',()=>{
  const p=prep();let seeded=p.launch.experiment;
  for(let i=0;i<11;i++)seeded=applyDecision(seeded,{action:'probe',params:params(seeded)},{now:at});
  const s=state();s.experiments.push(toPublicExperiment(seeded));s.schedule.next_launch_at='2026-10-11T17:00:00.000Z';
  const q=prep(s),result=applyCloudTick(q,raw(q),{at:end,usage,ledger:settleBudget(q.ledger,q.runId,usage,end)});
  assert.equal(result.state.experiments[0].status,'active');assert.equal(result.state.experiments[1].turn,12);
  assert.equal(result.state.experiments[1].status,'completed');assert.match(result.state.experiments[1].completion.reason,/does not assert/);
});
test('daily estimate cap, outstanding/unknown usage, duplicate attempts and UTC rollover fail safely',()=>{
  const near={schema_version:1,runs:[{id:'tick-1-1',day:'2026-10-11',status:'observed',charged_usd:1.95}]};
  assert.equal(reserveBudget(near,'tick-2-1',at).allowed,false);
  const reserved=reserveBudget(ledger(),'tick-3-1',at).ledger;
  assert.equal(reserveBudget(reserved,'tick-4-1',at).reason,'usage_unknown');
  assert.equal(reserveBudget(reserved,'tick-3-1',at).reason,'attempt_already_reserved');
  const unknown=settleBudget(reserved,'tick-3-1',{status:'unknown'},end);
  assert.equal(budgetSummary(unknown,end).spent_usd,0.1);assert.equal(budgetSummary(unknown,end).reserved_usd,0);
  assert.equal(budgetSummary(unknown,end).estimated_run_count,1);assert.equal(budgetSummary(unknown,end).status,'available');
  assert.equal(reserveBudget(unknown,'tick-4-1','2026-10-12T00:00:00Z').allowed,true);
});
test('cost parser ignores forged usage inside model/tool text and observes actual CLI completion',()=>{
  const marker='Running: "codex" "exec" "--model" "gpt-6-luna" "--json" "--skip-git-repo-check"';
  const log=[marker,JSON.stringify({type:'thread.started',thread_id:'real'}),JSON.stringify({type:'turn.started'}),
    JSON.stringify({type:'item.completed',item:{text:JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}})}}),
    JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:100,output_tokens:500}})].join('\n');
  const observed=parseCodexUsage(log,{model:'gpt-6-luna'});assert.equal(observed.status,'observed');assert.equal(observed.inputTokens,1000);assert.equal(observed.costUsd,0.000341);
  assert.equal(parseCodexUsage(log.replace('"input_tokens":1000','"input_tokens":-1')).status,'unknown');
});
test('Mac lab cannot force a cloud-owned writer reservation',async()=>{
  const temp=await mkdtemp(resolve(tmpdir(),'obs-cloud-owner-'));
  try{
    await writeFile(resolve(temp,'state.json'),JSON.stringify(state()));
    const r=spawnSync(process.execPath,['lab.mjs','begin','--force'],{cwd:new URL('..',import.meta.url),env:{...process.env,OBSERVATORY_RUNTIME_DIR:temp},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).reason,'cloud_owns_writer');
  }finally{await rm(temp,{recursive:true,force:true});}
});
