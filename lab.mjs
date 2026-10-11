import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createExperiment, applyDecision, toPublicExperiment, TYPE_CATALOG } from './engine.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = resolve(process.env.OBSERVATORY_RUNTIME_DIR || resolve(ROOT, '.runtime'));
const STATE = resolve(RUNTIME, 'state.json');
const LOCK = resolve(RUNTIME, 'reservation.json');
const now = () => new Date().toISOString();
const after = (at, minutes) => new Date(Date.parse(at) + minutes * 60000).toISOString();
async function read(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function atomic(path, value) { await mkdir(dirname(path), {recursive:true}); const temp=path+'.'+randomUUID()+'.tmp'; await writeFile(temp, JSON.stringify(value,null,2)+'\n',{mode:0o600}); await rename(temp,path); }
const catalog = () => Array.isArray(TYPE_CATALOG) ? TYPE_CATALOG : Object.entries(TYPE_CATALOG).map(([type,x])=>typeof x==='object'?{type,...x}:{type,title:x});
export async function initialize() {
  try { return await read(STATE); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const at=now();
  const experiment=createExperiment({id:'bicycle-company-001',type:'bicycle-company',createdAt:at,title:'The Little Bicycle Company',description:'A workshop run by agents. Every part, repair and supplier shock changes its books.'});
  const state={schema_version:1,title:'The Autonomous Observatory',created_at:at,updated_at:at,revision:0,schedule:{factory_minutes:60,loop_minutes:5,status:'preparing',requires:'Mac awake and Codex running',next_launch_at:after(at,60),next_tick_at:at},experiments:[experiment],launches:[{id:experiment.id,type:experiment.type,title:experiment.title,at,reason:'An organizational autonomy demonstration: operations, purchasing and accounting under one real set of simulated rules.'}]};
  await atomic(STATE,state); return state;
}
export async function publicState() { const state=await read(STATE); const {_last_commit_token,...publicRoot}=state; return {...publicRoot,experiments:state.experiments.map(e=>{const p=toPublicExperiment(e);return {...p,timeline:p.timeline.slice(-12)};})}; }
export async function publicEventsAfter(existing) { const state=await read(STATE);return Object.fromEntries(state.experiments.map(e=>{const old=existing.experiments?.find(x=>x.id===e.id);const p=toPublicExperiment(e);return [e.id,p.timeline.filter(event=>event.turn>(old?.turn||0))];})); }
export async function begin({force=false}={}) {
  const state=await initialize(), at=now();
  if(state.schedule.status==='paused') return {action:'skip',reason:'paused'};
  if(!force&&Date.parse(state.schedule.next_tick_at)>Date.parse(at)+15000) return {action:'skip',reason:'not_due',next_tick_at:state.schedule.next_tick_at};
  try { const lock=await read(LOCK); if(Date.parse(lock.expires_at)>Date.parse(at))return {action:'skip',reason:'busy',expires_at:lock.expires_at}; await unlink(LOCK); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const used=new Set(state.experiments.map(e=>e.type));
  const next=catalog().find(e=>!used.has(e.type||e.id));
  const launchDue=Date.parse(at)>=Date.parse(state.schedule.next_launch_at);
  const reservation={token:randomUUID(),revision:state.revision,started_at:at,expires_at:after(at,20),launch_due:launchDue};
  try { await writeFile(LOCK,JSON.stringify(reservation,null,2),{flag:'wx',mode:0o600}); } catch(e) { if(e.code==='EEXIST')return {action:'skip',reason:'busy'};throw e; }
  return {action:'work',...reservation,launch:launchDue?{suggested:next||null,instructions:'Create one genuinely new kind of experiment. Use an unused implemented type or add a distinct deterministic environment, tests and public renderer before launch. Do not relabel an existing simulation.',existing_types:[...used]}:null,experiments:state.experiments.filter(e=>e.status==='active').map(e=>({id:e.id,type:e.type,title:e.title,turn:e.turn,world:toPublicExperiment(e).world,memory:e.memory,metrics:e.metrics,allowed_actions:e.allowed_actions,recent_timeline:e.timeline.slice(-4)}))};
}
export async function commit(token,input) {
  const state=await read(STATE),at=now();
  if(state._last_commit_token===token){try{const old=await read(LOCK);if(old.token===token)await unlink(LOCK);}catch(e){if(e.code!=='ENOENT')throw e;}return {action:'already_committed',experiments:state.experiments.map(e=>({id:e.id,turn:e.turn}))};}
  try {const saved=await read(resolve(RUNTIME,'commits',token+'.json'));return {...saved,action:'already_committed'};} catch(e){if(e.code!=='ENOENT')throw e;}
  const reservation=await read(LOCK);
  if(reservation.token!==token)throw new Error('Wrong reservation token');
  if(reservation.revision!==state.revision)throw new Error('Local revision changed');
  if(!Array.isArray(input.decisions))throw new Error('decisions array required');
  const active=state.experiments.filter(e=>e.status==='active');
  const decisions=new Map(input.decisions.map(d=>[d.experiment_id,d]));
  if(decisions.size!==input.decisions.length||active.some(e=>!decisions.has(e.id)))throw new Error('Exactly one decision is required for each active experiment');
  const updated=structuredClone(state);
  updated.experiments=state.experiments.map(e=>e.status!=='active'?e:applyDecision(e,{...decisions.get(e.id),action_author:'Codex',decision_id:token+':'+e.id},{now:at}));
  if(reservation.launch_due) {
    if(!input.launch)throw new Error('An hourly new experiment is due; launch metadata required');
    if(state.experiments.some(e=>e.type===input.launch.type))throw new Error('Each launch must use a distinct experiment type');
    const id=input.launch.type+'-'+String(state.experiments.length+1).padStart(3,'0');
    const fresh=createExperiment({...input.launch,id,createdAt:at});
    if(!input.launch.decision)throw new Error('Initial launch decision required');
    updated.experiments.push(applyDecision(fresh,{...input.launch.decision,action_author:'Codex',decision_id:token+':'+id},{now:at}));
    updated.launches.push({id,type:fresh.type,title:fresh.title,at,reason:input.launch.reason||fresh.description});
    updated.schedule.next_launch_at=after(at,60);
  } else if(input.launch)throw new Error('Next hourly launch is not due');
  if(input.decisions.some(d=>!active.some(e=>e.id===d.experiment_id)))throw new Error('Unknown decision experiment');
  updated.updated_at=at;updated.schedule.next_tick_at=after(reservation.started_at,5);updated._last_commit_token=token;
  await atomic(STATE,updated);await unlink(LOCK);
  await atomic(resolve(RUNTIME,'commits',token+'.json'),{at,token,experiments:updated.experiments.map(e=>({id:e.id,turn:e.turn})),launch:input.launch?.type||null});
  return {action:'committed',experiments:updated.experiments.map(e=>({id:e.id,turn:e.turn})),next_launch_at:updated.schedule.next_launch_at,next_tick_at:updated.schedule.next_tick_at};
}
export async function markPublished(revision) { const state=await read(STATE);state.revision=revision;await atomic(STATE,state); }
const args=process.argv.slice(2), cmd=args.shift();
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    let result;
    if(cmd==='init')result=await initialize();
    else if(cmd==='status'){const s=await read(STATE);result={revision:s.revision,schedule:s.schedule,experiments:s.experiments.map(e=>({id:e.id,type:e.type,turn:e.turn,status:e.status})),updated_at:s.updated_at};}
    else if(cmd==='begin')result=await begin({force:args.includes('--force')});
    else if(cmd==='commit')result=await commit(args[0],await read(resolve(args[1])));
    else if(cmd==='public')result=await publicState();
    else if(cmd==='schedule'){const s=await read(STATE);s.schedule.status=args[0];if(args[1])s.schedule.automation_id=args[1];await atomic(STATE,s);result={schedule:s.schedule};}
    else if(cmd==='release'){const r=await read(LOCK);if(r.token!==args[0])throw new Error('Wrong reservation token');await atomic(resolve(RUNTIME,'failures',r.token+'.json'),{...r,failed_at:now(),reason:args.slice(1).join(' ')});await unlink(LOCK);result={action:'released'};}
    else throw new Error('Commands: init, status, begin [--force], commit TOKEN INPUT.json, public, schedule STATUS [AUTOMATION_ID], release TOKEN REASON');
    console.log(JSON.stringify(result,null,2));
  } catch(e) { console.error(e.message);process.exitCode=1; }
}
