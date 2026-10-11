import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as repair from '../repair.mjs';

const html=await readFile(new URL('../viewer.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await refresh();setInterval(refresh,30000);setInterval(status,15000);','');
const NOW='2026-10-11T17:45:00.000Z';
// These artifacts isolate viewer wiring. Fixture output and live input are computed
// through the same exported, bounded source evaluator that runs real app versions.
function artifact(id,source,status){
  const inputs={x:12,y:3},result=repair.evaluateRepairSource(source,inputs),actual=result.value??null;
  return {id,source,status,passed:result.ok&&actual===36?1:0,total:1,tests:[{id:'three-items',inputs,expected:36,actual,passed:result.ok&&actual===36,error:result.error??null}]};
}
function record(){
  const original=artifact('opening-demo','x + y','broken'),good=artifact('repair-1','x * y','accepted'),bad=artifact('repair-2','x - y','rejected');
  const app={id:'demo',title:'Item total',spec:'Multiply the price by the quantity.',inputs:[{name:'x',label:'Price',default:12},{name:'y',label:'Quantity',default:3}],original,current:good,versions:[original,good,bad],status:'repaired'};
  const accepted={id:'r1',action:'repair',app_id:'demo',before:{id:original.id,source:original.source},candidate:good,verdict:'accepted',requeued:false};
  const rejected={id:'r2',action:'repair',app_id:'demo',before:{id:good.id,source:good.source},candidate:bad,verdict:'rejected',requeued:true};
  const firstWorld={apps:[{...app,versions:[original,good]}],records:[accepted],latest_record:accepted};
  return {id:'repair-viewer',title:'Repair viewer test',type:'repair-cafe',turn:2,world:{apps:[app],records:[accepted,rejected],latest_record:rejected},timeline:[{turn:1,at:NOW,snapshot:{world:firstWorld,metrics:[]}},{turn:2,at:NOW}],metrics:[]};
}
function harness(){
  const nodes=new Map();
  const getElementById=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,isConnected:true,style:{},textContent:'',innerHTML:'',value:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},querySelectorAll(selector){return selector==='[data-repair-input]'?[...nodes.values()].filter(n=>n.dataset?.repairInput):[];},classList:{toggle(){}}});return nodes.get(id);};
  const context=vm.createContext({Date,Map,URL,structuredClone,setInterval,clearInterval,providedRepair:repair,document:{getElementById,addEventListener(){}},window:{addEventListener(){}},location:{hash:''},history:{replaceState(){}},fetch:async()=>{throw Error('No public request is needed in a local app comparison.');}});
  vm.runInContext(script+`\nrepairModule=providedRepair;globalThis.api={render(e){renderRepairDetails(e,e)},replay(e,index){renderRepairDetails(e,snapshotFor(e,index))},scene:repairScene,card:repairRecordCard};`,context);
  return {api:context.api,node:getElementById,input(name,value){const n=getElementById('repair-input-'+name);n.value=String(value);n.dataset={repairInput:name};}};
}

test('playable original and saved repaired versions evaluate live numeric input',async()=>{
  const e=record(),before=JSON.stringify(e),h=harness();h.api.render(e);h.input('x',12);h.input('y',3);
  await h.node('repair-run').onclick();
  assert.equal(h.node('repair-original-output').textContent,'15');
  assert.equal(h.node('repair-version-output').textContent,'36');
  assert.match(h.node('repair-run-note').textContent,/Live input/);
  h.input('x',7);h.input('y',4);await h.node('repair-run').onclick();
  assert.equal(h.node('repair-original-output').textContent,'11');
  assert.equal(h.node('repair-version-output').textContent,'28');
  assert.equal(JSON.stringify(e),before,'trying the apps must not rewrite saved artifacts');
});

test('a rejected candidate remains selectable and its saved failure is visible',async()=>{
  const e=record(),h=harness();h.api.render(e);
  assert.match(h.node('repair-detail').innerHTML,/The rejected app returned to the queue/);
  assert.match(h.node('repair-detail').innerHTML,/repair-2 · Rejected attempt/);
  h.node('repair-version-select').onchange({target:{value:'repair-2'}});
  assert.match(h.node('repair-detail').innerHTML,/Selected · repair-2/);
  assert.match(h.node('repair-detail').innerHTML,/saved computed fixture results \(0 \/ 1 passed\)/);
  assert.match(h.node('repair-detail').innerHTML,/repair-test-fail/);
  h.input('x',12);h.input('y',3);await h.node('repair-run').onclick();
  assert.equal(h.node('repair-version-output').textContent,'9');
  assert.equal(e.world.apps[0].current.id,'repair-1','a failed candidate is not the shipped app');
  h.api.replay(e,0);
  assert.doesNotMatch(h.node('repair-detail').innerHTML,/repair-2|The rejected app returned/);
  assert.match(h.node('repair-detail').innerHTML,/verified candidate became the shipped version/);
});

test('invalid live input cannot be mistaken for a computed result; supplied prose is escaped',async()=>{
  const e=record(),h=harness();h.api.render(e);h.input('x','');h.input('y',3);await h.node('repair-run').onclick();
  assert.match(h.node('repair-run-note').textContent,/finite number/);
  assert.equal(h.node('repair-version-output').textContent,'');
  const injection='<img src=x onerror=alert(1)><script>alert(1)</script>';
  e.world.apps[0].title=injection;e.world.apps[0].spec=injection;e.world.apps[0].current.source=injection;
  h.api.render(e);const markup=h.node('repair-detail').innerHTML;
  assert.doesNotMatch(markup,/<img|<script/);assert.match(markup,/&lt;img/);
});


test('actual repair café artifacts run the saved checkout source before and after fixture acceptance',async()=>{
  const initial=repair.initializeRepair();
  const accepted=repair.applyRepairDecision(initial,{action:'repair',params:{app_id:'checkout',source:'floor(x*y*(100-z)/100)'}}).world;
  const rejected=repair.applyRepairDecision(accepted,{action:'repair',params:{app_id:'checkout',source:'floor(x*y-z)'}}).world;
  const e={id:'actual-repair-cafe',type:'repair-cafe',turn:2,world:rejected,metrics:[],timeline:[{turn:1,at:NOW,snapshot:repair.repairSnapshot(accepted)},{turn:2,at:NOW}]};
  const before=JSON.stringify(e),h=harness();h.api.render(e);h.input('x',1299);h.input('y',3);h.input('z',10);await h.node('repair-run').onclick();
  assert.equal(h.node('repair-original-output').textContent,'3887');
  assert.equal(h.node('repair-version-output').textContent,'3507');
  assert.match(h.node('repair-detail').innerHTML,/saved computed fixture results \(6 \/ 6 passed\)/);
  assert.match(h.node('repair-detail').innerHTML,/rejected app returned to the queue/);
  const failed=rejected.apps.find(app=>app.id==='checkout').versions.at(-1);
  h.node('repair-version-select').onchange({target:{value:failed.id}});await h.node('repair-run').onclick();
  assert.equal(h.node('repair-version-output').textContent,'3887');
  h.api.replay(e,0);assert.doesNotMatch(h.node('repair-detail').innerHTML,/patch-2/);
  assert.equal(JSON.stringify(e),before);
});
