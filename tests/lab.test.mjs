import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const runtime=await mkdtemp(join(tmpdir(),'observatory-lab-test-'));
process.env.OBSERVATORY_RUNTIME_DIR=runtime;
const {initialize,begin,commit,publicState}=await import('../lab.mjs');
test.after(async()=>{await rm(runtime,{recursive:true,force:true});delete process.env.OBSERVATORY_RUNTIME_DIR;});
test('coordinator excludes concurrent runs, rejects invalid decisions atomically and recovers commit retries',async()=>{
  const initial=await initialize();assert.equal(initial.experiments.length,1);
  const reservation=await begin({force:true});assert.equal(reservation.action,'work');assert.equal((await begin({force:true})).reason,'busy');
  const path=join(runtime,'state.json'),before=await readFile(path,'utf8');
  await assert.rejects(commit(reservation.token,{decisions:[]}),/Exactly one/);assert.equal(await readFile(path,'utf8'),before);
  const input={decisions:[{experiment_id:initial.experiments[0].id,action:'service',params:{order_ids:['order-0001','order-0002','order-0003']},reason:'Complete available customer orders before their deadlines.'}]};
  const outcome=await commit(reservation.token,input);assert.equal(outcome.experiments[0].turn,1);
  assert.equal((await commit(reservation.token,input)).action,'already_committed');
  const state=await publicState();assert.equal(state.experiments[0].turn,1);assert.equal(state.experiments[0].timeline[0].action_author,'Codex');assert.equal(state._last_commit_token,undefined);
});
test('hourly factory launches a distinct environment with a real first decision and a private oracle',async()=>{
  const path=join(runtime,'state.json'),state=JSON.parse(await readFile(path,'utf8'));
  state.schedule.next_launch_at=new Date(Date.now()-60000).toISOString();await writeFile(path,JSON.stringify(state));
  const reservation=await begin({force:true});assert.equal(reservation.launch_due,true);assert.equal(reservation.launch.suggested.type,'alien-language');
  const outcome=await commit(reservation.token,{decisions:[{experiment_id:state.experiments[0].id,action:'rest',params:{},reason:'Observe demand while launching the new research experiment.'}],launch:{type:'alien-language',title:'The Alien Language Institute',description:'Researchers choose examples and test rules against withheld evidence.',reason:'Research autonomy has falsifiable hypotheses rather than organizational cashflow.',decision:{action:'probe',params:{subject:'I',verb:'see',object:'star',tense:'present'},reason:'Request one controlled present-tense example.'}}});
  assert.equal(outcome.experiments.length,2);assert.equal(outcome.experiments[1].turn,1);
  const published=await publicState();assert.equal(published.launches.length,2);assert.equal(published.experiments[1].type,'alien-language');assert.equal(published.experiments[1].timeline.length,1);
  assert.ok(!JSON.stringify(published).includes('_private'));
  assert.ok(Date.parse(published.schedule.next_launch_at)>Date.now()+59*60000);
});
