import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createExperiment,toPublicExperiment,applyDecision} from '../engine.mjs';
import {prepareCloudTick,applyCloudTick,observe,checkpoint,validateDecisions} from '../scripts/cloud-tick.mjs';
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
test('cloud ownership, paused state and future due times prevent model reservation',()=>{
  for(const [change,reason] of [[{runner:'mac'},'cloud_does_not_own_writer'],[{status:'paused'},'paused'],[{next_tick_at:'2026-10-11T17:00:00.000Z'},'not_due']]){
    const s=state();Object.assign(s.schedule,change);const p=prep(s);
    assert.equal(p.allowed,false);assert.equal(p.reason,reason);assert.deepEqual(p.ledger,ledger());
  }
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
  assert.equal(budgetSummary(unknown,end).reserved_usd,0.1);assert.equal(budgetSummary(unknown,end).status,'usage_unknown');
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
