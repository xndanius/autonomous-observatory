import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPublicationIndex,publishSnapshot} from '../publish.mjs';
import {handleApi} from '../worker/routes.mjs';
import {createExperiment,toPublicExperiment} from '../engine.mjs';

const origin='https://observatory.example.chatgpt.site';
const makeState=()=>({schema_version:1,title:'Observatory',revision:8,created_at:'2026-10-11T10:00:00.000Z',updated_at:'2026-10-11T10:05:00.000Z',schedule:{status:'active'},launches:[],experiments:[1,2].map(n=>({id:'world-'+n,type:'example',title:'World '+n,description:'A world',created_at:'2026-10-11T10:00:00.000Z',updated_at:'2026-10-11T10:05:00.000Z',status:'active',turn:n,roles:['Researcher'],metrics:[],world:{value:n},timeline:[],memory:{}}))});

test('compact index hashes world content but retains no world or timeline',()=>{
  const state=makeState(),index=buildPublicationIndex(state);
  assert.equal(index.storage_format,'split-v1');
  assert.equal(index.experiments[0].world,undefined);assert.equal(index.experiments[0].timeline,undefined);assert.equal(index.experiments[0].memory,undefined);
  const changed=structuredClone(state);changed.experiments[0].world.value++;
  assert.notEqual(buildPublicationIndex(changed).experiments[0].state_ref,index.experiments[0].state_ref);
  assert.equal(buildPublicationIndex(changed).experiments[1].state_ref,index.experiments[1].state_ref);
});

function server(existing,worlds,{wrongWorld=false,wrongDigest=false}={}) {
  let index=structuredClone(existing);const calls=[],stored=new Map(worlds.map(e=>[e.id,structuredClone(e)]));
  return {calls,fetchImpl:async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({path,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});
    if(path==='/api/index'&&options.method==='PUT'){const body=JSON.parse(options.body);assert.equal(body.expected_revision,index.revision);index=body.state;return Response.json({revision:index.revision});}
    if(path==='/api/index')return Response.json(index);
    const id=decodeURIComponent(path.split('/')[3]);
    if(options.method==='PUT'){const e=JSON.parse(options.body).experiment;stored.set(id,e);return Response.json({experiment_id:id,state_ref:wrongDigest?'0'.repeat(64):buildPublicationIndex({experiments:[e]}).experiments[0].state_ref});}
    const e=structuredClone(stored.get(id));if(wrongWorld)e.world.value++;
    return Response.json(e);
  }};
}

test('legacy migration stages all worlds before CAS and verifies before marking',async()=>{
  const state=makeState(),existing=buildPublicationIndex(state,7);existing.storage_format='legacy';const mock=server(existing,[]),marks=[];
  const outcome=await publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:mock.fetchImpl,mark:async n=>marks.push(n)});
  assert.equal(outcome.action,'published');assert.deepEqual(marks,[8]);
  assert.deepEqual(mock.calls.filter(c=>c.method==='PUT').map(c=>c.path),['/api/experiments/world-1/state','/api/experiments/world-2/state','/api/index']);
  assert(mock.calls.filter(c=>c.method==='GET').every(c=>c.path!=='/api/state'));
});

test('routine publication stages only changed worlds and retry writes nothing',async()=>{
  const state=makeState(),old=structuredClone(state);old.experiments[0].world.value=0;const mock=server(buildPublicationIndex(old,7),old.experiments),marks=[];
  await publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:mock.fetchImpl,mark:async n=>marks.push(n)});
  assert.deepEqual(mock.calls.filter(c=>c.method==='PUT').map(c=>c.path),['/api/experiments/world-1/state','/api/index']);
  mock.calls.length=0;const retry=await publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:mock.fetchImpl,mark:async n=>marks.push(n)});
  assert.equal(retry.action,'already_published');assert.deepEqual(marks,[8,8]);assert.deepEqual(mock.calls.map(c=>c.method),['GET']);
});

test('incorrect staging digest prevents pointer publication',async()=>{
  const state=makeState(),old=buildPublicationIndex(state,7);old.storage_format='legacy';const mock=server(old,[],{wrongDigest:true});
  await assert.rejects(publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:mock.fetchImpl}),/digest differs/);
  assert(!mock.calls.some(c=>c.path==='/api/index'&&c.method==='PUT'));
});

test('incorrect committed world read-back cannot mark local publication',async()=>{
  const state=makeState(),old=buildPublicationIndex(state,7);old.storage_format='legacy';const mock=server(old,[],{wrongWorld:true}),marks=[];
  await assert.rejects(publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:mock.fetchImpl,mark:async n=>marks.push(n),waitForRetry:async()=>{}}),/read-back differs/);assert.deepEqual(marks,[]);
});

test('transient read-back failures recover without repeating writes or claiming an unverified result',async()=>{
  const state=makeState(),old=buildPublicationIndex(state,7);old.storage_format='legacy';
  const mock=server(old,[]),marks=[],delays=[];let indexReads=0,worldFailure=true;
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;
    if(!options.method&&path==='/api/index'&&++indexReads===2)return Response.json({error:'temporary'}, {status:503});
    if(!options.method&&path==='/api/experiments/world-1/state'&&worldFailure){worldFailure=false;throw new TypeError('fetch failed');}
    return mock.fetchImpl(url,options);
  };
  const result=await publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl,mark:async r=>marks.push(r),waitForRetry:async ms=>delays.push(ms)});
  assert.equal(result.revision,8);assert.deepEqual(marks,[8]);assert.deepEqual(delays,[500,500]);
  assert.deepEqual(mock.calls.filter(c=>c.method==='PUT').map(c=>c.path),['/api/experiments/world-1/state','/api/experiments/world-2/state','/api/index']);
});

test('a briefly stale index is reread, while persistent errors never mark publication',async()=>{
  const state=makeState(),old=buildPublicationIndex(state,7);old.storage_format='legacy';
  const mock=server(old,[]),marks=[];let reads=0;
  const fetchImpl=(url,options={})=>!options.method&&new URL(url).pathname==='/api/index'&&++reads===2?Response.json(old):mock.fetchImpl(url,options);
  await publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl,mark:async r=>marks.push(r),waitForRetry:async()=>{}});
  assert.deepEqual(marks,[8]);assert.equal(mock.calls.filter(c=>c.path==='/api/index'&&c.method==='PUT').length,1);
  let attempts=0;
  await assert.rejects(publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:async()=>{attempts++;return Response.json({error:'temporary'},{status:503});},waitForRetry:async()=>{}}),/Public read failed: 503/);
  assert.equal(attempts,3);
  attempts=0;
  await assert.rejects(publishSnapshot({state,origin,writerToken:'test-only-token',fetchImpl:async()=>{attempts++;return Response.json({error:'denied'},{status:403});},waitForRetry:async()=>{}}),/Public read failed: 403/);
  assert.equal(attempts,1);
});

test('publisher and real Worker agree on canonical hashes and exact saved experiment reads',async()=>{
  const objects=new Map();let serial=0;
  const bucket={get:async key=>{const x=objects.get(key);return x?{httpEtag:x.etag,json:async()=>JSON.parse(x.body)}:null;},put:async(key,body,options={})=>{
    const old=objects.get(key),match=options.onlyIf?.get('if-match'),absent=options.onlyIf?.get('if-none-match');
    if((match&&old?.etag!==match)||(absent==='*'&&old))return null;
    const etag='"'+(++serial)+'"';objects.set(key,{body,etag});return{httpEtag:etag};
  }};
  const at='2026-10-11T10:00:00.000Z',writerToken='test-only-integration-token-at-least-32-characters';
  const experiment=toPublicExperiment(createExperiment({id:'company-test',type:'bicycle-company',createdAt:at}));
  const state={schema_version:1,title:'The Autonomous Observatory',revision:0,created_at:at,updated_at:at,schedule:{factory_minutes:60,loop_minutes:5,status:'active',requires:'Mac awake and Codex running',next_launch_at:at,next_tick_at:at},launches:[{id:experiment.id,type:experiment.type,title:experiment.title,at,reason:'A test fixture.'}],experiments:[experiment]};
  const fetchImpl=(url,options)=>handleApi(new Request(url,options),{BUCKET:bucket,OBSERVATORY_WRITE_TOKEN:writerToken});const marks=[];
  const outcome=await publishSnapshot({state,origin,writerToken,fetchImpl,mark:async n=>marks.push(n)});
  assert.equal(outcome.revision,1);assert.deepEqual(marks,[1]);
  assert.deepEqual(await (await fetchImpl(origin+'/api/state')).json(),{...state,revision:1});
  assert.deepEqual(await (await fetchImpl(origin+'/api/history?revision=1')).json(),{...state,revision:1});
  assert.equal((await publishSnapshot({state,origin,writerToken,fetchImpl})).action,'already_published');
});
