import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {publicState,markPublished} from './lab.mjs';

const metadataFields=['id','type','title','description','created_at','updated_at','status','turn','roles','metrics'];
export function canonicalPublic(value) {
  if(Array.isArray(value))return '['+value.map(canonicalPublic).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalPublic(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function buildPublicationIndex(state,revision=state.revision) {
  return {...state,revision,storage_format:'split-v1',experiments:state.experiments.map(e=>({
    ...Object.fromEntries(metadataFields.map(k=>[k,e[k]])),
    state_ref:createHash('sha256').update(canonicalPublic(e)).digest('hex'),
  }))};
}
const samePayload=(a,b)=>{const x=structuredClone(a),y=structuredClone(b);delete x.revision;delete y.revision;return isDeepStrictEqual(x,y);};

export async function publishSnapshot({state,origin,writerToken,fetchImpl=fetch,mark=async()=>{}}) {
  if(!/^https:\/\/[a-z0-9.-]+\.chatgpt\.site$/.test(origin))throw new Error('Invalid pinned site origin');
  const get=async path=>{const r=await fetchImpl(origin+path);if(!r.ok)throw new Error('Public read failed: '+r.status);return r.json();};
  const put=async(path,body)=>{
    const response=await fetchImpl(origin+path,{method:'PUT',headers:{'Authorization':'Bearer '+writerToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const outcome=await response.json();
    if(!response.ok)throw new Error('Publication failed '+response.status+': '+JSON.stringify(outcome));
    return outcome;
  };
  const existing=await get('/api/index');
  const wanted=buildPublicationIndex(state);
  if(samePayload(existing,wanted)) {
    await mark(existing.revision);
    return {action:'already_published',revision:existing.revision,count:existing.experiments.length};
  }
  const index=buildPublicationIndex(state,existing.revision+1);
  const previous=new Map(existing.experiments.map(e=>[e.id,e.state_ref]));
  // Legacy hashes describe embedded worlds, which have not yet been staged.
  // Later ticks stage only changed worlds, keeping every upload independent.
  for(let n=0;n<state.experiments.length;n++) {
    const experiment=state.experiments[n],entry=index.experiments[n];
    if(existing.storage_format==='split-v1'&&previous.get(entry.id)===entry.state_ref)continue;
    const outcome=await put('/api/experiments/'+encodeURIComponent(entry.id)+'/state',{experiment});
    if(outcome.experiment_id!==entry.id||outcome.state_ref!==entry.state_ref)throw new Error('Staged experiment digest differs');
  }
  const outcome=await put('/api/index',{expected_revision:existing.revision,state:index});
  if(outcome.revision!==index.revision)throw new Error('Publication revision differs');
  const verify=await get('/api/index');
  if(!isDeepStrictEqual(verify,index))throw new Error('Publication index read-back differs');
  // Verify immutable worlds at the committed revision, without a combined read.
  for(const experiment of state.experiments) {
    const actual=await get('/api/experiments/'+encodeURIComponent(experiment.id)+'/state?revision='+index.revision);
    if(!isDeepStrictEqual(actual,experiment))throw new Error('Experiment read-back differs: '+experiment.id);
  }
  await mark(index.revision);
  return {action:'published',revision:index.revision,count:index.experiments.length,turns:index.experiments.reduce((n,e)=>n+e.turn,0),url:origin};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const root=dirname(fileURLToPath(import.meta.url));
  const site=JSON.parse(await readFile(resolve(root,'site.json'),'utf8'));
  const writerToken=(await readFile(resolve(root,'.runtime/writer.key'),'utf8')).trim();
  const outcome=await publishSnapshot({state:await publicState(),origin:site.origin,writerToken,mark:markPublished});
  console.log(JSON.stringify(outcome));
}
