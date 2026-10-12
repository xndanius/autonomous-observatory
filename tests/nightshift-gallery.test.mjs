import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../nightshift.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await refresh();setInterval(refresh,60000);','');
const NOW='2026-10-12T15:00:00.000Z';
const clock=class extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return Date.parse(NOW);}};
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value,text:async()=>value});
const piece=(id,overrides={})=>({id,type:'tool',title:'A small useful tool',summary:'Convert a recipe for the number of people at your table.',created_at:NOW,published_at:NOW,cost_usd:.012,steps:[],changes:[],...overrides});
const index=(pieces=[],overrides={})=>({schema_version:2,title:'The Night Shift',revision:1,updated_at:NOW,schedule:{status:'active',runner:'github-actions',next_piece_at:'2026-10-12T16:00:00Z',budget:{spent_usd:.55,daily_cap_usd:2,estimated_usd:.03,estimated_run_count:1,accounting:'hybrid_estimate'}},pieces,failures:[],...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function harness(fetch=async()=>response(index()),hash=''){
  const nodes=new Map(),frames=[];
  const makeNode=()=>({hidden:false,textContent:'',innerHTML:'',className:'',attributes:{},children:[],setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},addEventListener(){},scrollIntoView(){},replaceChildren(...children){this.children=children;}});
  const getElementById=id=>{if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id);};
  const location={hash,pathname:'/',search:''};
  const document={getElementById,querySelectorAll:()=>[],createElement(tag){const node=makeNode();node.tag=tag;frames.push(node);return node;}};
  const context=vm.createContext({fetch,Date:clock,URL,AbortSignal,Map,location,history:{replaceState(_a,_b,path){location.hash=path.includes('#')?path.slice(path.indexOf('#')):'';}},document,window:{addEventListener(){}},setInterval});
  vm.runInContext(script+`\nglobalThis.api={refresh,selectPiece,closePiece,sortedPieces,renderRuntime,renderGallery,renderSteps,checkLines,attachPreview,safeUrl,changesFor,money,show(record,error=null){state=record;indexError=error;renderGallery();renderRuntime();renderFailures();},get state(){return state},get selectedId(){return selectedId},get selectedPiece(){return selectedPiece},get detailError(){return detailError}};`,context);
  return {api:context.api,nodes,frames,node:getElementById,text:id=>getElementById(id).textContent};
}

test('newest finished work comes first and an empty shelf contains no fictional pieces',()=>{
  const h=harness();h.api.show(index([piece('old',{published_at:'2026-10-12T13:00:00Z'}),piece('new'),piece('../not-an-id')]));
  assert.deepEqual(Array.from(h.api.sortedPieces(),value=>value.id),['new','old']);
  assert.match(h.node('gallery').innerHTML,/data-open="new"/);
  assert.equal(h.text('piece-count'),'02');
  h.api.show(index());
  assert.equal(h.node('gallery').innerHTML,'');assert.equal(h.node('empty').hidden,false);
  assert.equal(h.text('empty-title'),'No published pieces yet.');
  assert.match(h.text('empty-description'),/after its draft, independent check and final check are recorded/);
});

test('metadata is escaped and missing costs are never presented as zero',()=>{
  const h=harness();h.api.show(index([piece('safe',{title:'<script>bad()</script>',summary:'A "tool" <img src=x onerror=bad()>',cost_usd:null})]));
  const card=h.node('gallery').innerHTML;
  assert.match(card,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(card,/<script>|<img src=x/);
  assert.match(card,/Cost not recorded/);assert.doesNotMatch(card,/\$0\.00/);
  assert.equal(h.api.safeUrl('javascript:bad()'),null);assert.equal(h.api.safeUrl('https://user:secret@example.com'),null);
});

test('recorded estimates count toward the cap and cloud pauses remain explicit',()=>{
  const h=harness();h.api.show(index());
  assert.equal(h.text('runner-label'),'Runs in the cloud');
  assert.match(h.text('budget-note'),/Estimated recorded cost today: \$0\.55 \/ \$2\.00 daily cap/);
  assert.match(h.text('budget-note'),/Includes \$0\.03 estimated across 1 run with unavailable usage/);
  const paused=index();paused.schedule.status='paused_budget';paused.schedule.budget.status='paused_budget';h.api.show(paused);
  assert.equal(h.text('runner-label'),'Paused · daily cap');assert.equal(h.text('next-label'),'Next piece on hold');
  h.api.show(index(), 'network unavailable');assert.equal(h.text('runner-label'),'Cloud record is stale');
  h.api.show(index([],{updated_at:'2026-10-12T12:00:00Z'}));assert.equal(h.text('runner-label'),'Cloud record is old');
  const missing=index();missing.schedule.budget.spent_usd=null;h.api.show(missing);assert.equal(h.text('runner-label'),'Cloud cost record unavailable');assert.match(h.text('budget-note'),/cost today: unavailable/);
  h.api.show(index([],{updated_at:null}));assert.notEqual(h.text('runner-label'),'Runs in the cloud');
});

test('failed hours stay in the quiet log and are excluded from the shelf count',()=>{
  const h=harness();h.api.show(index([piece('one')],{failures:[{id:'failed-one',at:NOW,type:'song',reason:'Second check rejected an inaudible draft.',cost_usd:.018}]}));
  assert.equal(h.text('piece-count'),'01');assert.equal(h.node('quiet-log').hidden,false);
  assert.match(h.node('failure-log').innerHTML,/Second check rejected an inaudible draft/);
  assert.doesNotMatch(h.node('gallery').innerHTML,/failed-one|inaudible/);
});

test('actual checker comments and change records are shown without inventing a verdict',()=>{
  const h=harness();const steps=h.api.renderSteps(piece('a',{steps:[{stage:'check',at:NOW,status:'failed',summary:'Tested the first draft.',checks:{verdict:'needs_improvement',comments:['The units are unclear.','<unsafe> text']}}]}));
  assert.match(steps,/Independent check/);assert.match(steps,/needs improvement/);assert.match(steps,/The units are unclear/);assert.match(steps,/&lt;unsafe&gt;/);
  assert.doesNotMatch(h.api.renderSteps(piece('a')),/Passed|approved/);
  assert.deepEqual(Array.from(h.api.changesFor({changes:['Clarified the units.']})),['Clarified the units.']);
});

test('previews can run scripts but cannot access the gallery origin or autoplay media',()=>{
  const h=harness();h.api.attachPreview('final','<html><script>window.example=true;</script></html>');
  const frame=h.frames[0];assert.equal(frame.tag,'iframe');assert.equal(frame.attributes.sandbox,'allow-scripts');
  assert.doesNotMatch(frame.attributes.sandbox,/allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(frame.attributes.allow,/autoplay 'none'/);assert.equal(frame.attributes.referrerpolicy,'no-referrer');
  assert.match(frame.srcdoc,/window.example=true/);
});

test('a stable piece hash opens only that detail and both saved versions',async()=>{
  const calls=[];const h=harness(async path=>{calls.push(path);if(path==='/api/nightshift')return response(index([piece('one'),piece('two')]));if(path==='/api/nightshift/pieces/two')return response(piece('two'));return response('<!doctype html><title>Saved piece</title>');},'#two');
  await h.api.refresh();assert.equal(h.api.selectedId,'two');assert.equal(h.api.selectedPiece.id,'two');
  assert.deepEqual(calls,['/api/nightshift','/api/nightshift/pieces/two','/api/nightshift/pieces/two/render?version=draft','/api/nightshift/pieces/two/render?version=final']);
  assert.equal(h.api.detailError,null);assert.equal(h.node('draft-host').children[0].attributes.sandbox,'allow-scripts');
});

test('an older permanent link opens its verified piece outside the latest hundred on the shelf',async()=>{
  const current=Array.from({length:100},(_,i)=>piece('current-'+i)),older=piece('nightshift-older',{title:'The first useful tool',published_at:'2026-10-01T12:00:00Z'}),calls=[];
  const h=harness(async path=>{calls.push(path);if(path==='/api/nightshift')return response(index(current));if(path==='/api/nightshift/pieces/nightshift-older')return response(older);return response('<!doctype html><title>Original saved version</title>');},'#nightshift-older');
  await h.api.refresh();
  assert.equal(h.api.state.pieces.length,100);assert.equal(h.text('piece-count'),'100');assert.equal(h.api.selectedPiece.id,'nightshift-older');
  assert.equal(h.api.detailError,null);assert.equal(h.node('gallery-error').hidden,true);assert.match(h.node('piece-detail').innerHTML,/The first useful tool/);
  assert.doesNotMatch(h.node('gallery').innerHTML,/data-open="nightshift-older"/);
  assert.deepEqual(calls,['/api/nightshift','/api/nightshift/pieces/nightshift-older','/api/nightshift/pieces/nightshift-older/render?version=draft','/api/nightshift/pieces/nightshift-older/render?version=final']);
});

test('unpublished or invalid linked pieces show an honest error without requesting previews',async()=>{
  for(const missing of [true,false]){
    const calls=[];const h=harness(async path=>{calls.push(path);if(path==='/api/nightshift')return response(index([piece('current')]));return missing?response(null,404):response(piece('old',{type:'constructor'}));},'#old');
    await h.api.refresh();assert.equal(h.api.selectedId,'old');assert.equal(h.api.selectedPiece,null);
    assert.match(h.api.detailError,missing?/no published record \(HTTP 404\)/:/metadata is incomplete or unsupported/);
    assert.equal(calls.length,2);assert.equal(h.frames.length,0);assert.equal(h.text('piece-count'),'01');
  }
});

test('a slow former selection cannot replace a more recently opened piece',async()=>{
  const old=deferred();const h=harness(async path=>{if(path.endsWith('/one'))return old.promise;if(path.endsWith('/two'))return response(piece('two'));return response('<html>Preview</html>');});
  h.api.show(index([piece('one'),piece('two')]));const first=h.api.selectPiece('one');await settle();await h.api.selectPiece('two');old.resolve(response(piece('one')));await first;
  assert.equal(h.api.selectedId,'two');assert.equal(h.api.selectedPiece.id,'two');assert.match(h.node('piece-detail').innerHTML,/Original draft/);
  assert.equal(h.api.detailError,null);
});

test('a failed gallery refresh keeps the last saved shelf and says it is stale',async()=>{
  let count=0;const h=harness(async()=>{if(++count===1)return response(index([piece('real')]));throw new Error('The connection is unavailable.');});
  await h.api.refresh();await h.api.refresh();assert.equal(h.api.state.pieces[0].id,'real');
  assert.equal(h.text('runner-label'),'Cloud record is stale');assert.match(h.text('gallery-error-text'),/Showing the last successfully read shelf/);
  assert.match(h.node('gallery').innerHTML,/data-open="real"/);
});
