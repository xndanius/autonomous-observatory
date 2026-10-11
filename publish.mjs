import {readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {publicState,publicEventsAfter,markPublished} from './lab.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const site=JSON.parse(await readFile(resolve(root,'site.json'),'utf8'));
const token=(await readFile(resolve(root,'.runtime/writer.key'),'utf8')).trim();
if(!/^https:\/\/[a-z0-9.-]+\.chatgpt\.site$/.test(site.origin))throw new Error('Invalid pinned site origin');
const state=await publicState();
const existingResponse=await fetch(site.origin+'/api/state');
if(!existingResponse.ok)throw new Error('Public read failed: '+existingResponse.status);
const existing=await existingResponse.json();
const samePayload=(a,b)=>{const x=structuredClone(a),y=structuredClone(b);delete x.revision;delete y.revision;return isDeepStrictEqual(x,y);};
if(samePayload(existing,state)) {await markPublished(existing.revision);console.log(JSON.stringify({action:'already_published',revision:existing.revision,count:existing.experiments.length}));}
else {
  state.revision=existing.revision+1;
  const events=await publicEventsAfter(existing);
  const response=await fetch(site.origin+'/api/state',{method:'PUT',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({expected_revision:existing.revision,state,events})});
  const outcome=await response.json();if(!response.ok)throw new Error('Publication failed '+response.status+': '+JSON.stringify(outcome));
  const verify=await fetch(site.origin+'/api/state').then(r=>r.json());
  if(!samePayload(verify,state)||verify.revision!==state.revision)throw new Error('Publication read-back differs');
  await markPublished(verify.revision);
  console.log(JSON.stringify({action:'published',revision:verify.revision,count:verify.experiments.length,turns:verify.experiments.reduce((n,e)=>n+e.turn,0),url:site.origin}));
}
