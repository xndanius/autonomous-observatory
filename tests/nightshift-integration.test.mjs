import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {checkPiece,emptyGallery,metadata,sha,canonical} from '../nightshift.mjs';
import {publishGallery} from '../nightshift-publish.mjs';
import {handleNightShift} from '../worker/nightshift-routes.mjs';
import {sumUsage,settlePieceBudget} from '../scripts/nightshift-tick.mjs';
import {budgetSummary} from '../cloud-budget.mjs';
import {validateArtifact} from '../nightshift-artifacts.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const ORIGIN='https://autonomous-observatory-20261011.xndanius.chatgpt.site';
const TOKEN='test-only-writer-token-'.repeat(3);
const START='2026-10-12T12:00:00.000Z',END='2026-10-12T12:04:00.000Z';
const clone=structuredClone;
const draft=()=>({title:'Lantern steps',summary:'A small original instrumental melody.',tempo_bpm:96,instrument:'triangle',notes:[60,64,67,64,62,65,69,65,60,64,67,72,69,67,64,60].map(midi=>({midi,duration_beats:1,rest:false})),chords:[{start_beat:0,duration_beats:4,midis:[48,52,55]},{start_beat:4,duration_beats:4,midis:[50,53,57]},{start_beat:8,duration_beats:8,midis:[48,52,55]}]});
function piece(run=9001){const original=draft(),final=clone(original);final.notes.at(-1).duration_beats=2;return{id:'nightshift-song-'+run+'-1',type:'song',title:final.title,summary:final.summary,created_at:START,published_at:END,draft:original,final,sources:[],draft_review:{passed:true,summary:'The melody is audible and coherent.',issues:[],improvement:'Extend the ending to make the cadence clearer.'},final_review:{passed:true,summary:'The ending is clearer and the machine checks pass.',issues:[],improvement:'A future piece could try a contrasting phrase.'},changes:'Extended the last note by one beat for a clearer ending.',cost_usd:.032,cost_accounting:'Estimated from actual CLI token counters; not an invoice',run_url:ORIGIN.replace(/https:\/\/.*$/,'https://github.com/xndanius/autonomous-observatory/actions/runs/'+run),steps:['draft','check','improvement','final_check','publish'].map((stage,n)=>({stage,at:new Date(Date.parse(START)+n*60000).toISOString(),status:stage==='publish'?'published':'passed',summary:'Actual bounded stage output recorded.',checks:stage==='final_check'?validateArtifact('song',final).checks:[],cost_usd:stage==='publish'?0:.008}))};}
function gallery(pieces=[],revision=0){const g=emptyGallery();g.revision=revision;g.created_at=START;g.updated_at=END;g.schedule.status='active';g.schedule.next_piece_at='2026-10-12T13:04:00.000Z';g.pieces=pieces;return g;}
class Bucket {
 constructor(){this.objects=new Map();this.writes=[];this.version=0;this.beforePut=null;}
 seed(key,value){this.objects.set(key,{raw:JSON.stringify(value),etag:'"'+(++this.version)+'"'});}
 async get(key){const saved=this.objects.get(key);if(!saved)return null;const raw=saved.raw;return{httpEtag:saved.etag,json:async()=>JSON.parse(raw),text:async()=>raw};}
 async put(key,raw,options={}){this.writes.push(key);if(this.beforePut)await this.beforePut(key,raw,options);const current=this.objects.get(key),match=options.onlyIf?.get('if-match'),absent=options.onlyIf?.get('if-none-match');if(match&&current?.etag!==match||absent==='*'&&current)return null;this.objects.set(key,{raw,etag:'"'+(++this.version)+'"'});return{httpEtag:this.objects.get(key).etag};}
}
const entry=p=>({...metadata(p),state_ref:sha(p)});
function fixture(state=gallery()){const bucket=new Bucket();if(state.revision)bucket.seed('nightshift/gallery.json',state);const env={BUCKET:bucket,OBSERVATORY_WRITE_TOKEN:TOKEN};const requests=[];const fetchImpl=async(url,options={})=>{const request=new Request(url,options);requests.push({method:request.method,path:new URL(url).pathname});return handleNightShift(request,env);};return{bucket,env,requests,fetchImpl};}
const put=(f,path,data)=>f.fetchImpl(ORIGIN+path,{method:'PUT',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:JSON.stringify(data)});

 test('protected end-to-end publication retains exact draft/final and runs only two write requests',async()=>{
 const p=piece(),f=fixture();assert.equal(checkPiece(p).passed,true,checkPiece(p).errors.join('; '));
 const published=await publishGallery({origin:ORIGIN,writerToken:TOKEN,state:gallery(),piece:p,fetchImpl:f.fetchImpl});
 assert.equal(published.revision,1);assert.equal(published.url,ORIGIN+'#'+p.id);
 assert.deepEqual(f.requests.filter(r=>r.method==='PUT').map(r=>r.path),['/api/nightshift/pieces/'+p.id,'/api/nightshift']);
 const stored=await(await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+p.id)).json();assert.deepEqual(stored,p);
 const render=await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+p.id+'/render?version=final');assert.equal(render.status,200);assert.match(await render.text(),/Play song/);assert.match(render.headers.get('content-security-policy'),/connect-src 'none'/);
 const before=f.bucket.writes.length;const anonymous=await f.fetchImpl(ORIGIN+'/api/nightshift',{method:'PUT',body:'unparsed invalid JSON'});assert.equal(anonymous.status,401);assert.equal(f.bucket.writes.length,before);
});

test('a stale proposal performs no writes and cannot replace the current shelf',async()=>{
 const f=fixture(gallery([],3));await assert.rejects(publishGallery({origin:ORIGIN,writerToken:TOKEN,state:gallery([],2),piece:piece(),fetchImpl:f.fetchImpl}),/Stale gallery proposal/);assert.equal(f.bucket.writes.length,0);assert.equal((await(await f.fetchImpl(ORIGIN+'/api/nightshift')).json()).revision,3);
});

test('CAS conflict leaves a staged artifact private and preserves the concurrent publication',async()=>{
 const state=gallery([],2),f=fixture(state),p=piece();let injected=false;
 f.bucket.beforePut=async key=>{if(key==='nightshift/gallery.json'&&!injected){injected=true;f.bucket.seed(key,gallery([],3));}};
 await assert.rejects(publishGallery({origin:ORIGIN,writerToken:TOKEN,state,piece:p,fetchImpl:f.fetchImpl}),/409/);
 assert.equal((await(await f.fetchImpl(ORIGIN+'/api/nightshift')).json()).revision,3);
 assert.equal((await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+p.id)).status,404);
 assert.ok(f.bucket.objects.has('nightshift/pieces/'+sha(p)+'.json'));
});

test('failed deterministic checks cannot be staged or become public',async()=>{
 const f=fixture(),p=piece();p.final.notes.forEach(n=>n.rest=true);
 const response=await put(f,'/api/nightshift/pieces/'+p.id,{piece:p});assert.equal(response.status,400);assert.equal(f.bucket.writes.length,0);
 assert.equal((await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+p.id)).status,404);
});

test('a title-only change is not a genuine substantive artifact improvement',()=>{
 const p=piece();p.final=clone(p.draft);p.final.title='A renamed melody';p.title=p.final.title;p.steps.find(s=>s.stage==='final_check').checks=validateArtifact('song',p.final).checks;
 const checked=checkPiece(p);assert.equal(checked.passed,false,'Renaming an unchanged executable artifact must be rejected');
});

test('an older published id cannot be changed after it leaves the latest 100-piece shelf',async()=>{
 const older=piece(8999),items=Array.from({length:100},(_,n)=>piece(9100+n)),state=gallery(items.map(entry),101),f=fixture(state);
 f.bucket.seed('nightshift/published/'+older.id+'.json',entry(older));f.bucket.seed('nightshift/pieces/'+sha(older)+'.json',older);
 for(const p of items){f.bucket.seed('nightshift/published/'+p.id+'.json',entry(p));f.bucket.seed('nightshift/pieces/'+sha(p)+'.json',p);}
 const altered=clone(older);altered.final.notes[0].midi=61;altered.changes='Changed the first note to a semitone above the original.';altered.steps.find(s=>s.stage==='final_check').checks=validateArtifact('song',altered.final).checks;
 assert.equal((await put(f,'/api/nightshift/pieces/'+altered.id,{piece:altered})).status,200);
 const proposed=gallery([...state.pieces.slice(1),entry(altered)],102),response=await put(f,'/api/nightshift',{expected_revision:101,state:proposed});
 assert.equal(response.status,409,'Historical marker conflict must reject before pointer CAS');
 assert.deepEqual((await(await f.fetchImpl(ORIGIN+'/api/nightshift')).json()),state,'No durable poisoned pointer');
 assert.deepEqual((await(await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+older.id)).json()),older);
});

test('four actual stage costs are aggregated without inventing absent token counters',()=>{
 const rows=['draft','check','improvement','final_check'].map((stage,n)=>({stage,called:true,conclusion:'success',usage:{status:'observed',model:'gpt-6-luna',costUsd:(n+1)*.002,inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:2,reasoningOutputTokens:null}}));
 const result=sumUsage(rows);assert.equal(result.status,'observed');assert.equal(result.costUsd,.02);assert.equal(result.inputTokens,40);assert.equal(result.outputTokens,8);assert.equal(result.reasoningOutputTokens,null);
 const partial=clone(rows);partial[1].usage={status:'unknown',model:'gpt-6-luna',costUsd:null};const unknown=sumUsage(partial);assert.equal(unknown.status,'unknown');assert.equal(unknown.costUsd,null);assert.deepEqual(unknown.steps,partial);
});

test('old simulated-world endpoints are retired without publishing fictional replacements',async()=>{
 const f=fixture();for(const path of ['/api/index','/api/state','/api/experiments/life-research-005/history']){const response=await f.fetchImpl(ORIGIN+path);assert.equal(response.status,410);const body=await response.json();assert.match(body.archive,/archive\/observatory-20261012$/);}assert.equal(f.bucket.writes.length,0);
});

test('a final independent rejection cannot be presented as a finished piece',()=>{
 const p=piece();p.final_review={...p.final_review,passed:false,issues:['The ending is not coherent.']};assert.equal(checkPiece(p).passed,false);
 const f=fixture();return put(f,'/api/nightshift/pieces/'+p.id,{piece:p}).then(async response=>{assert.equal(response.status,400);assert.equal((await f.fetchImpl(ORIGIN+'/api/nightshift/pieces/'+p.id)).status,404);});
});

test('a brief stale public read-back is retried without rerunning writes',async()=>{
 const f=fixture(),p=piece();let pointerWritten=false,staleServed=false;
 const fetchImpl=async(url,options={})=>{const response=await f.fetchImpl(url,options);if(options.method==='PUT'&&new URL(url).pathname==='/api/nightshift')pointerWritten=true;
 if(!options.method&&new URL(url).pathname==='/api/nightshift'&&pointerWritten&&!staleServed){staleServed=true;return Response.json(emptyGallery());}return response;};
 const result=await publishGallery({origin:ORIGIN,writerToken:TOKEN,state:gallery(),piece:p,fetchImpl});assert.equal(result.revision,1);assert.equal(staleServed,true);assert.equal(f.requests.filter(r=>r.method==='PUT').length,2);
});

test('missing usage is estimated per called stage while known costs and raw counters survive',()=>{
 const at='2026-10-12T12:08:00.000Z',runId='tick-9999-1';
 const ledger={schema_version:1,runs:[{id:'tick-8888-1',day:'2026-10-12',at:START,settled_at:'2026-10-12T12:01:00.000Z',status:'observed',charged_usd:.01,cost_usd:.01,usage:{model:'gpt-6-luna',status:'observed',costUsd:.01}},{id:runId,day:'2026-10-12',at:START,status:'reserved',charged_usd:.40,cost_usd:null}]};
 const rows=[{stage:'draft',called:true,usage:{status:'observed',model:'gpt-6-luna',costUsd:.006,inputTokens:11}},{stage:'check',called:true,usage:{status:'unknown',model:'gpt-6-luna',costUsd:null,reason:'log unavailable'}},{stage:'improvement',called:true,usage:{status:'observed',model:'gpt-6-luna',costUsd:.004,inputTokens:13}},{stage:'final_check',called:true,usage:{status:'unknown',model:'gpt-6-luna',costUsd:null,reason:'log unavailable'}}];
 const settled=settlePieceBudget(ledger,runId,rows,at),entry=settled.runs.at(-1);
 assert.equal(entry.status,'estimated');assert.equal(entry.cost_usd,null);assert.ok(Math.abs(entry.charged_usd-.05)<1e-12);
 assert.deepEqual(entry.estimate_basis.stages.map(s=>s.charged_usd),[.006,.02,.004,.02]);assert.equal(entry.estimate_basis.method,'sum_recorded_stage_costs_and_conservative_missing_stage_estimates');
 assert.deepEqual(entry.usage.steps,rows,'Missing raw usage is preserved; no tokens invented');assert.equal(ledger.runs.at(-1).status,'reserved');assert.equal(ledger.runs.at(-1).charged_usd,.40);
 const budget=budgetSummary(settled,at);assert.ok(Math.abs(budget.spent_usd-.06)<1e-12);assert.ok(Math.abs(budget.estimated_usd-.05)<1e-12);assert.equal(budget.reserved_usd,0);assert.equal(budget.daily_cap_usd,2);
});
