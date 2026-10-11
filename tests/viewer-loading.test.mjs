import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../viewer.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await refresh();setInterval(refresh,30000);setInterval(status,15000);','');
const response=data=>({ok:true,status:200,json:async()=>data});
const metadata=(id,turn=1)=>({id,type:'test-world',title:id,turn});
const index=(revision=1,turn=1)=>({revision,experiments:['a','b','c'].map(id=>metadata(id,turn))});
const experiment=(id,turn=1)=>({...metadata(id,turn),world:{marker:`${id}-${turn}`},timeline:[{turn}]});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(fetch,hash=''){
  const elements=new Map();
  const getElementById=id=>{if(!elements.has(id))elements.set(id,{hidden:false,style:{},textContent:'',setAttribute(){},classList:{toggle(){}},querySelectorAll:()=>[]});return elements.get(id);};
  const context=vm.createContext({fetch,location:{hash},history:{replaceState(){}},document:{getElementById,addEventListener(){}},window:{addEventListener(){}},clearInterval,setInterval,Date,Map,console,renders:[]});
  vm.runInContext(script+`\nrenderGallery=()=>{};status=()=>{};renderExperiment=()=>renders.push({id:current()?.id??null,revision:state?.revision,loading:selectedLoading,error:!!experimentError});globalThis.api={refresh,select,loadSelected,selectedPublic,current,chronology,get selectedId(){return selectedId},get state(){return state},get error(){return experimentError},get cache(){return loadedExperiments},get branch(){return branch},set branch(value){branch=value},get history(){return earlierHistory}};`,context);
  return {api:context.api,renders:context.renders,elements};
}

test('initial permanent hash loads only that experiment and cache avoids refetching worlds',async()=>{
  const calls=[];
  const h=harness(async url=>{calls.push(url);if(url==='/api/index')return response(index());return response(experiment(url.split('/')[3]));},'#b');
  await h.api.refresh();
  assert.deepEqual(calls,['/api/index','/api/experiments/b/state?revision=1']);
  assert.equal(h.api.current().id,'b');
  await h.api.select('a');await h.api.select('b');
  assert.equal(calls.filter(url=>url.includes('/b/state')).length,1);
  assert.equal(calls.some(url=>url.includes('/c/state')),false);
});

test('slow response and slow failure from former selection cannot repaint selected world',async()=>{
  for(const fail of [false,true]){
    const a=deferred(),calls=[];
    const h=harness(async url=>{calls.push(url);if(url==='/api/index')return response(index());if(url.includes('/a/'))return a.promise;return response(experiment('b'));});
    const first=h.api.refresh();await settle();
    const switched=h.api.select('b');await switched;
    if(fail)a.reject(Error('old request failed'));else a.resolve(response(experiment('a')));
    await first;
    assert.equal(h.api.current().id,'b');assert.equal(h.api.error,null);
    assert.equal(h.renders.at(-1).id,'b');
    assert.equal(h.renders.some(render=>render.id==='a'),false);
    assert.equal(calls.some(url=>url.includes('/c/')),false);
  }
});

test('new revision cannot be replaced by late state from previous revision',async()=>{
  const old=deferred();let refreshes=0;
  const h=harness(async url=>{if(url==='/api/index')return response(index(++refreshes,refreshes));if(url.endsWith('revision=1'))return old.promise;return response(experiment('a',2));});
  const first=h.api.refresh();await settle();
  await h.api.refresh();
  old.resolve(response(experiment('a',1)));await first;
  assert.equal(h.api.state.revision,2);assert.equal(h.api.current().world.marker,'a-2');
  assert.equal(h.renders.at(-1).revision,2);
  assert.equal(h.renders.some(render=>render.id==='a'&&render.revision===1),false);
});

test('late index fetch cannot roll revision back or start a stale selected fetch',async()=>{
  const old=deferred(),calls=[];let count=0;
  const h=harness(async url=>{calls.push(url);if(url==='/api/index')return ++count===1?old.promise:response(index(2,2));return response(experiment('a',2));});
  const first=h.api.refresh();await settle();await h.api.refresh();old.resolve(response(index(1,1)));await first;
  assert.equal(h.api.state.revision,2);assert.equal(calls.filter(url=>url.includes('/state?')).length,1);
  assert.equal(calls.some(url=>url.endsWith('revision=1')),false);
});

test('parallel selected requests share one fetch; failed world can be retried',async()=>{
  const pending=deferred(),calls=[];let attempts=0;
  const h=harness(async url=>{calls.push(url);if(url==='/api/index')return response(index());if(++attempts===1)return pending.promise;return response(experiment('a'));});
  const first=h.api.refresh();await settle();const duplicate=h.api.loadSelected();await settle();
  assert.equal(attempts,1);pending.reject(Error('temporarily unavailable'));await Promise.all([first,duplicate]);
  assert.ok(h.api.error);assert.equal(h.api.current(),undefined);
  await h.api.select('a');assert.equal(attempts,2);assert.equal(h.api.current().id,'a');assert.equal(h.api.error,null);
});

test('refresh keeps local branch independent while caching latest public revision; history never adds future turns',async()=>{
  let revision=0;
  const h=harness(async url=>{if(url==='/api/index')return response(index(++revision,revision));return response(experiment('a',revision));});
  await h.api.refresh();
  const local={id:'local-a',turn:4,world:{marker:'private'}};h.api.branch={public:local,baseline:{public_turn:1}};
  await h.api.refresh();
  assert.equal(h.api.branch.public,local);assert.equal(h.api.current().world.marker,'private');
  assert.equal(h.api.selectedPublic().world.marker,'a-2');
  h.api.history.set('a',[{turn:1},{turn:2},{turn:3}]);
  assert.deepEqual(Array.from(h.api.chronology(experiment('a',2)),event=>event.turn),[1,2]);
});

test('mismatched revision snapshot is rejected without caching the wrong saved turn',async()=>{
  const h=harness(async url=>response(url==='/api/index'?index(7,2):experiment('a',3)));
  await h.api.refresh();
  assert.equal(h.api.current(),undefined);assert.equal(h.api.cache.size,0);assert.ok(h.api.error);
});
