import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../engine.mjs';

const html=await readFile(new URL('../viewer.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await refresh();setInterval(refresh,30000);setInterval(status,15000);','');
const NOW='2026-10-11T16:25:00.000Z';
const params={name:'Canal tally vessel',year:125,material:'clay',technology:'kiln-firing',form:'vessel',purpose:'recording',site:'canal',layer:'middle',motif_count:6,inscription_marks:3,evidence_id:'survey-canal-middle'};
function fresh(){return engine.createExperiment({id:'museum-permanent',type:'civilization-museum',createdAt:NOW});}
function turn(e,p=params,action='propose'){return engine.applyDecision(e,{action,params:p,actor:'Test curator',reason:'Compare the proposal with fictional constraints.'},{now:NOW});}
function publicRecord(e){return engine.toPublicExperiment(e);}
function harness(records=[],hash=''){
  const nodes=new Map(),publicRecords=records.map(publicRecord);
  const getElementById=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,style:{},textContent:'',innerHTML:'',value:'',attributes:{},classes:new Map(),setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},querySelectorAll:()=>[],classList:{toggle(key,value){nodes.get(id).classes.set(key,value);}}});return nodes.get(id);};
  const context=vm.createContext({Date,Map,URL,structuredClone,setInterval,clearInterval,document:{getElementById,addEventListener(){}},window:{addEventListener(){}},location:{hash},history:{replaceState(_state,_title,url){context.location.hash=url;}},providedEngine:engine,fetch:async url=>({ok:true,status:200,json:async()=>url==='/api/index'?{revision:1,updated_at:NOW,experiments:publicRecords.map(e=>({id:e.id,type:e.type,title:e.title,turn:e.turn}))}:publicRecords.find(e=>url.includes(`/experiments/${encodeURIComponent(e.id)}/`))})});
  vm.runInContext(script+`\nglobalThis.api={refresh,select,museumArtifactDrawing,museumArtifactCard,museumScene,renderMuseumDetails,museumBranchDefaults,get current(){return current()},replay(index){replayIndex=index;renderExperiment();},local(e){engine=providedEngine;branch={private:e,public:engine.toPublicExperiment(e),baseline:null};replayIndex=null;renderExperiment();},applyLocal(params,action='propose'){branchParams=()=>params;$('branch-action').value=action;$('apply-branch').onclick();},get public(){return selectedPublic()},get branch(){return branch}};`,context);
  return {api:context.api,node:getElementById};
}

test('museum permanent hash shows three fictional facts, dated constraints and initial empty evidence',async()=>{
  const museum=fresh(),other=engine.createExperiment({id:'another-world',type:'bicycle-company',createdAt:NOW});
  const h=harness([other,museum],'#museum-permanent');await h.api.refresh();
  assert.equal(h.api.current.id,'museum-permanent');
  assert.equal(h.node('museum-detail').hidden,false);
  assert.equal(h.node('scene').classes.get('museum-scene'),true);
  assert.match(h.node('scene-label').textContent,/imaginary museum/);
  const content=h.node('museum-detail').innerHTML;
  assert.equal((content.match(/class="museum-fact"/g)||[]).length,3);
  assert.match(content,/fictional.*internal consistency/s);
  assert.match(content,/not external evidence or a historical discovery/);
  assert.match(content,/0–79/);assert.match(content,/80–139/);assert.match(content,/140–239/);
  assert.match(content,/Copper casting/);assert.match(content,/Iron forging \(unsupported\)/);
  assert.match(content,/accepted collection is empty/i);assert.match(content,/No rejected proposal/);
  await h.api.select('another-world');assert.equal(h.node('museum-detail').hidden,true);
  assert.equal(h.node('scene').classes.get('museum-scene'),false);
});

test('accepted and rejected curator evidence and counts replay the saved museum turn',async()=>{
  const accepted=turn(fresh()),rejected=turn(accepted,{...params,name:'Premature iron tool',year:125,material:'iron',technology:'iron-forging',form:'tool'});
  const h=harness([rejected],'#museum-permanent');await h.api.refresh();
  let content=h.node('museum-detail').innerHTML;
  assert.match(content,/2 proposals tested · 1 accepted proposals · 1 rejected proposals/);
  assert.match(content,/Accepted collection · 1 retained artifacts/);
  assert.match(content,/Rejected artifact evidence · 1 retained attempts/);
  assert.match(content,/Fail · Available material/);assert.match(content,/Iron is unavailable/);
  assert.match(content,/Canal tally vessel/);assert.match(content,/Premature iron tool/);
  assert.match(h.node('scene').innerHTML,/REJECTED/);
  assert.equal((h.node('scene').innerHTML.match(/class="museum-motif"/g)||[]).length,6);
  assert.equal((h.node('scene').innerHTML.match(/class="museum-mark"/g)||[]).length,3);
  h.api.replay(0);content=h.node('museum-detail').innerHTML;
  assert.match(content,/1 proposals tested · 1 accepted proposals · 0 rejected proposals/);
  assert.match(content,/Rejected artifact evidence · 0 retained attempts/);
  assert.doesNotMatch(content,/Premature iron tool/);assert.match(h.node('scene').innerHTML,/ACCEPTED/);
});

test('legacy, compact and mixed museum snapshots render the same saved turns and current state',async()=>{
  const accepted=turn(fresh()),rejected=turn(accepted,{...params,name:'Rejected iron vessel',material:'iron',technology:'iron-forging',form:'tool'});
  const source=turn(rejected,{...params,proposal_id:'museum-2',name:'Revised clay vessel'},'revise');
  const originalFirstEvent=JSON.stringify(source.timeline[0]),views=[];
  for(const format of ['legacy','compact','mixed']){
    const fixture=structuredClone(source);
    fixture.timeline.forEach((event,index)=>{
      if(format==='legacy'||format==='mixed'&&index===0){
        event.snapshot.latest_record=structuredClone(event.snapshot.world.latest_record);
        event.snapshot.artifacts=structuredClone(event.snapshot.world.artifacts);
      }else{
        delete event.snapshot.latest_record;delete event.snapshot.artifacts;
      }
    });
    const h=harness([fixture],'#museum-permanent');await h.api.refresh();
    const capture=()=>({scene:h.node('scene').innerHTML,detail:h.node('museum-detail').innerHTML,metrics:h.node('metrics').innerHTML,world:h.node('world-data').textContent,position:h.node('replay-position').textContent});
    const current=capture();
    assert.match(current.scene,/Revised clay vessel/);assert.match(current.detail,/3 proposals tested · 2 accepted proposals · 1 rejected proposals/);
    h.api.replay(0);const first=capture();
    assert.match(first.scene,/Canal tally vessel/);assert.match(first.detail,/1 proposals tested · 1 accepted proposals · 0 rejected proposals/);
    assert.doesNotMatch(first.detail,/Rejected iron vessel|Revised clay vessel/);
    h.api.replay(1);const second=capture();
    assert.match(second.scene,/Rejected iron vessel/);assert.match(second.scene,/REJECTED/);
    assert.match(second.detail,/Fail · Available material/);assert.match(second.detail,/2 proposals tested · 1 accepted proposals · 1 rejected proposals/);
    assert.doesNotMatch(second.detail,/Revised clay vessel/);
    views.push({current,first,second});
  }
  assert.deepEqual(views[0],views[1]);assert.deepEqual(views[1],views[2]);
  assert.equal(JSON.stringify(source.timeline[0]),originalFirstEvent);
});

test('museum illustrations whitelist geometry and colors, bound counts and escape supplied text',()=>{
  const h=harness(),injection='"><script>alert(1)</script><img src=x onerror=alert(1)>';
  const artifact={...params,name:injection,material:injection,form:injection,year:injection,evidence_id:injection,motif_count:999999,inscription_marks:-2,display:{base:{type:'path',d:injection},fill:injection,motifs:[{type:'script',text:injection}]}};
  const card=h.api.museumArtifactCard({artifact,verdict:{checks:[{passed:false,reason:injection}]}},'rejected');
  assert.doesNotMatch(card,/<script|<img/);assert.equal(card.includes(injection),false);
  assert.match(card,/&lt;script&gt;/);assert.match(card,/&quot;&gt;/);
  assert.match(card,/fill="#c6c9b6"/);
  assert.equal((card.match(/class="museum-motif"/g)||[]).length,0);
  assert.equal((card.match(/class="museum-mark"/g)||[]).length,0);
  const vessel=h.api.museumArtifactDrawing(params),tool=h.api.museumArtifactDrawing({...params,form:'tool',material:'copper',motif_count:12,inscription_marks:9});
  assert.notEqual(vessel,tool);assert.match(tool,/fill="#a26845"/);
  assert.equal((tool.match(/class="museum-motif"/g)||[]).length,12);
  assert.equal((tool.match(/class="museum-mark"/g)||[]).length,9);
});

test('a local museum decision records its verdict without replacing cached public history',async()=>{
  const published=turn(fresh()),h=harness([published],'#museum-permanent');await h.api.refresh();
  const publicBefore=JSON.stringify(h.api.public);
  h.api.local(engine.createExperiment({id:'local-museum',type:'civilization-museum',createdAt:NOW}));
  assert.equal(h.api.museumBranchDefaults('propose').evidence_id,'survey-canal-middle');
  h.api.applyLocal({...params,name:'Local impossible tool',material:'iron',technology:'iron-forging',form:'tool'});
  assert.equal(h.api.branch.public.world.rejected_proposals,1);
  assert.match(h.node('branch-log').textContent,/Local curator result: Rejected/);
  assert.match(h.node('museum-detail').innerHTML,/Local impossible tool/);
  assert.equal(JSON.stringify(h.api.public),publicBefore);
  const revisionDefaults=h.api.museumBranchDefaults('revise');
  assert.equal(revisionDefaults.proposal_id,'museum-1');assert.equal(revisionDefaults.name,'Local impossible tool');
});
