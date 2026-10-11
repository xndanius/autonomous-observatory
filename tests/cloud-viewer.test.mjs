import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('../viewer.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await refresh();setInterval(refresh,30000);setInterval(status,15000);','');
const NOW='2026-10-11T15:30:00.000Z';
const LAST='2026-10-11T15:20:00.000Z';
const NEXT='2026-10-11T15:35:00.000Z';
const clock=class extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return Date.parse(NOW);}};
const cloud=overrides=>({runner:'github-actions',status:'active',loop_minutes:15,factory_minutes:60,last_tick_at:LAST,next_tick_at:NEXT,next_launch_at:'2026-10-11T16:00:00.000Z',repo_url:'https://github.com/xndanius/autonomous-observatory',last_run_url:'https://github.com/xndanius/autonomous-observatory/actions/runs/123',...overrides});

function harness(){
  const nodes=new Map();
  const getElementById=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:false,style:{},textContent:'',innerHTML:'',attributes:{},classes:new Map(),setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},querySelectorAll:()=>[],classList:{toggle(key,value){nodes.get(id).classes.set(key,value);}}});
    return nodes.get(id);
  };
  const context=vm.createContext({Date:clock,URL,location:{hash:''},document:{getElementById,addEventListener(){}},window:{addEventListener(){}},setInterval,clearInterval});
  vm.runInContext(script+'\nglobalThis.api={show(record,failed=false){state=record;fetchFailed=failed;status();},renderInstanceContext};',context);
  return {nodes,show:(schedule,options={})=>context.api.show({revision:8,updated_at:options.updated_at??NOW,schedule},!!options.fetchFailed),context:context.api,text:id=>getElementById(id).textContent,node:getElementById};
}

test('verified cloud schedule shows actual last and next ticks, cadence, and run evidence',()=>{
  const h=harness();h.show(cloud());
  assert.equal(h.text('runner-label'),'Runs in the cloud');
  assert.match(h.text('status-text'),/^Runs in the cloud · last tick 10 min ago$/);
  assert.equal(h.node('last-tick').attributes.datetime,LAST);
  assert.equal(h.node('next-tick').attributes.datetime,NEXT);
  assert.match(h.text('last-tick'),/15:20.*UTC/);
  assert.match(h.text('next-tick'),/15:35.*UTC/);
  assert.equal(h.text('next-tick-label'),'Next tick scheduled:');
  assert.match(h.node('tick-cadence').innerHTML,/^15</);
  assert.match(h.node('launch-cadence').innerHTML,/^60</);
  assert.equal(h.text('launch-label'),'new seeded instance');
  assert.equal(h.node('cloud-scope').hidden,false);
  assert.match(html,/Cloud launches create new seeded instances of existing environments/);
  assert.match(html,/New environment types require source deployment from Danielius’s Mac\/session/);
  assert.match(h.node('cloud-links').innerHTML,/actions\/runs\/123/);
  assert.equal(h.node('status-dot').classes.get('warn'),false);
});

test('cloud validation and absent ticks do not claim a confirmed cloud handoff',()=>{
  const h=harness();h.show(cloud({runner:'cloud-validation',last_tick_at:null}));
  assert.equal(h.text('runner-label'),'Cloud verification in progress');
  assert.equal(h.text('status-text'),'Cloud verification in progress');
  assert.match(h.text('schedule-note'),/permanent cloud handoff has not been confirmed/);
  assert.match(h.text('schedule-note'),/No completed cloud tick has been recorded/);
  assert.equal(h.text('last-tick'),'Not recorded');
  assert.equal(h.node('last-tick').attributes.datetime,undefined);
  assert.equal(h.text('next-tick-label'),'Planned next tick:');
  assert.equal(h.node('status-dot').classes.get('warn'),true);
  h.show(cloud({last_tick_at:null,next_tick_at:null}));
  assert.equal(h.text('status-text'),'No cloud tick recorded');
  assert.equal(h.text('next-tick'),'Not recorded');
  assert.equal(h.node('next-tick').attributes.datetime,undefined);
});

test('old ticks and failed refreshes remain stale even when a publish timestamp is recent',()=>{
  for(const [schedule,options] of [[cloud({last_tick_at:'2026-10-11T12:00:00.000Z'}),{}],[cloud(),{fetchFailed:true}],[cloud(),{updated_at:'2026-10-11T12:00:00.000Z'}]]){
    const h=harness();h.show(schedule,options);
    assert.equal(h.text('runner-label'),'Cloud record is stale');
    assert.match(h.text('status-text'),/^Cloud record stale/);
    assert.match(h.text('schedule-note'),/scheduled runs are not verified/);
    assert.equal(h.text('next-tick-label'),'Planned next tick:');
    assert.equal(h.node('status-dot').classes.get('warn'),true);
  }
});

test('preparing or unrecorded scheduling cannot be mistaken for active cloud runs',()=>{
  for(const status of ['preparing',undefined]){
    const h=harness();h.show(cloud({status}));
    assert.equal(h.text('runner-label'),'Cloud schedule · '+(status||'status not recorded'));
    assert.doesNotMatch(h.text('status-text'),/Runs in the cloud/);
    assert.equal(h.text('next-tick-label'),'Planned next tick:');
    assert.equal(h.node('status-dot').classes.get('warn'),true);
  }
});

test('daily budget pauses take precedence over a fresh tick and show estimates honestly',()=>{
  const h=harness();h.show(cloud({budget:{daily_cap_usd:2,day:'2026-10-11',spent_usd:1.91,reserved_usd:.09,status:'paused_budget'}}));
  assert.equal(h.text('status-text'),'Cloud runs paused · daily budget cap');
  assert.equal(h.text('runner-label'),'Cloud runs paused');
  assert.match(h.text('schedule-note'),/paused at the recorded daily budget cap/);
  assert.equal(h.text('next-tick-label'),'Planned next tick:');
  assert.equal(h.node('budget-note').hidden,false);
  assert.match(h.text('budget-note'),/Estimated recorded spend: \$1\.91 \/ \$2\.00 daily cap · 2026-10-11 UTC/);
  assert.match(h.text('budget-note'),/\$0\.09 reserved/);
  assert.match(h.text('budget-note'),/Estimates may differ from provider invoices/);
  assert.equal(h.node('status-dot').classes.get('warn'),true);
});

test('missing usage is not presented as zero spend and blocks the active cloud claim',()=>{
  const h=harness();h.show(cloud({budget:{daily_cap_usd:2,day:'2026-10-11',spent_usd:null,reserved_usd:0,status:'usage_unknown'}}));
  assert.equal(h.text('status-text'),'Cloud runs paused · usage unavailable');
  assert.match(h.text('budget-note'),/^Recorded spend unavailable \/ \$2\.00 daily cap/);
  assert.match(h.text('budget-note'),/ticks pause until it is accounted for/);
  assert.doesNotMatch(h.text('budget-note'),/\$0\.00/);
  h.show(cloud({status:'paused'}));
  assert.equal(h.text('status-text'),'Cloud runs paused · paused');
  assert.equal(h.node('budget-note').hidden,true);
  assert.equal(h.text('budget-note'),'');
});

test('existing Mac schedules preserve their requirements and hide cloud-only details',()=>{
  const h=harness();h.show(cloud());h.show({status:'active',loop_minutes:5,factory_minutes:60,requires:'Mac awake and Codex running'});
  assert.equal(h.text('runner-label'),'The working rhythm');
  assert.match(h.text('status-text'),/^Record saved/);
  assert.match(h.text('schedule-note'),/Mac awake and Codex running/);
  assert.equal(h.text('launch-label'),'new experiment');
  assert.match(h.node('tick-cadence').innerHTML,/^5</);
  assert.equal(h.node('schedule-details').hidden,true);
  assert.equal(h.node('cloud-scope').hidden,true);
  assert.equal(h.node('cloud-links').hidden,true);
  assert.equal(h.node('cloud-links').innerHTML,'');
});

test('public evidence links reject unsafe destinations and escape link attributes',()=>{
  const h=harness();
  for(const destination of ['javascript:alert(1)','https://github.com.evil.test/run','https://user:password@github.com/run']){
    h.show(cloud({last_run_url:destination,repo_url:undefined}));
    assert.equal(h.node('cloud-links').hidden,true);
    assert.equal(h.node('cloud-links').innerHTML,'');
  }
  h.show(cloud({repo_url:undefined,last_run_url:'https://github.com/xndanius/autonomous-observatory/actions/runs/123?x=1&y=2'}));
  assert.match(h.node('cloud-links').innerHTML,/x=1&amp;y=2/);
  assert.match(h.node('cloud-links').innerHTML,/rel="noopener noreferrer"/);
});

test('instance context shows recorded goals and seeds without implying older worlds were seeded',()=>{
  const h=harness();
  h.context.renderInstanceContext({goal:'Test <forecast> accuracy',seed:0});
  assert.equal(h.node('instance-note').hidden,false);
  assert.equal(h.text('instance-note'),'Goal: Test <forecast> accuracy · Seed: 0');
  assert.equal(h.node('instance-note').innerHTML,'');
  h.context.renderInstanceContext({goal:'Only the recorded goal'});
  assert.equal(h.text('instance-note'),'Goal: Only the recorded goal');
  h.context.renderInstanceContext({});
  assert.equal(h.node('instance-note').hidden,true);
  assert.equal(h.text('instance-note'),'');
});
