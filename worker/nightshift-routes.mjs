import {renderArtifact} from '../nightshift-artifacts.mjs';
import {checkPiece,canonical,metadata,emptyGallery} from '../nightshift.mjs';
const KEY='nightshift/gallery.json';
const json=(x,status=200)=>Response.json(x,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const hash=async x=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(x))))).map(v=>v.toString(16).padStart(2,'0')).join('');
async function authorized(request,token){if(typeof token!=='string'||token.length<32)return false;const given=request.headers.get('authorization')||'';if(given.length>4096||!given.startsWith('Bearer '))return false;const [a,b]=await Promise.all([hash(given.slice(7)),hash(token)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function read(bucket,key){const v=await bucket.get(key);return v?{value:await v.json(),etag:v.httpEtag}:null;}
async function body(request){const raw=await request.text();if(raw.length>512000)throw Error('Payload too large');return JSON.parse(raw);}
const pieceKey=ref=>'nightshift/pieces/'+ref+'.json';
const publicKey=id=>'nightshift/published/'+id+'.json';
async function loadPiece(bucket,state,id){const entry=state.pieces.find(p=>p.id===id)||(await read(bucket,publicKey(id)))?.value;if(!entry)return null;const saved=await read(bucket,pieceKey(entry.state_ref));if(!saved||await hash(saved.value)!==entry.state_ref)return null;return saved.value;}
async function immutable(bucket,key,value){const existing=await read(bucket,key);if(existing){if(canonical(existing.value)!==canonical(value))throw Error('Immutable archive conflict');return;}const written=await bucket.put(key,JSON.stringify(value),{onlyIf:new Headers({'if-none-match':'*'})});if(!written){const saved=await read(bucket,key);if(!saved||canonical(saved.value)!==canonical(value))throw Error('Immutable archive conflict');}}
async function repairMarkers(bucket,state){for(const entry of state.pieces)await immutable(bucket,publicKey(entry.id),entry);if(state.revision)await immutable(bucket,'nightshift/revisions/'+state.revision+'.json',state);}
export async function handleNightShift(request,env){
 const url=new URL(request.url),path=url.pathname;if(!path.startsWith('/api/'))return null;
 if(!path.startsWith('/api/nightshift')&&path!=='/api/status')return json({error:'The simulated worlds are retired. Complete history is preserved in the repository archive.',archive:'https://github.com/xndanius/autonomous-observatory/tree/main/archive/observatory-20261012'},410);
 if(!env.BUCKET)return json({error:'Gallery storage unavailable'},503);
 try{
  const record=await read(env.BUCKET,KEY),state=record?.value||emptyGallery();
  const match=/^\/api\/nightshift\/pieces\/(nightshift-[a-z]+-\d+-[1-9]\d*)(\/render)?$/.exec(path);
  if(request.method==='PUT'){
   if(!await authorized(request,env.OBSERVATORY_WRITE_TOKEN))return json({error:'Unauthorized'},401);
   const data=await body(request);
   if(match&&!match[2]){
    const piece=data.piece;const checked=checkPiece(piece);if(!checked.passed||piece.id!==match[1])return json({error:'Piece validation failed',errors:checked.errors},400);
    const ref=await hash(piece);await env.BUCKET.put(pieceKey(ref),JSON.stringify(piece));return json({id:piece.id,state_ref:ref});
   }
   if(path!=='/api/nightshift')return json({error:'Not found'},404);
   const next=data.state;if(data.expected_revision!==state.revision)return json({error:'Revision conflict',revision:state.revision},409);
   if(!next||next.schema_version!==2||next.title!=='The Night Shift'||next.revision!==state.revision+1||!Array.isArray(next.pieces)||next.pieces.length>100||!Array.isArray(next.failures)||next.failures.length>100||!['active','preparing','paused','budget_paused'].includes(next.schedule?.status)||next.schedule.runner!=='github-actions')return json({error:'Invalid gallery'},400);
   const ids=new Set();for(const entry of next.pieces){if(ids.has(entry.id)||!/^[a-f0-9]{64}$/.test(entry.state_ref))return json({error:'Invalid piece reference'},400);ids.add(entry.id);const saved=await read(env.BUCKET,pieceKey(entry.state_ref));if(!saved||await hash(saved.value)!==entry.state_ref||!checkPiece(saved.value).passed||canonical(metadata(saved.value))!==canonical(Object.fromEntries(Object.entries(entry).filter(([k])=>k!=='state_ref'))))return json({error:'Referenced piece is invalid'},400);}
   const overlap=new Map(next.pieces.map(p=>[p.id,p]));for(let n=0;n<state.pieces.length;n++){const old=state.pieces[n];if(overlap.has(old.id)&&canonical(old)!==canonical(overlap.get(old.id)))return json({error:'Published piece is immutable'},409);if(!overlap.has(old.id)&&next.pieces.length!==100)return json({error:'Published piece cannot disappear'},409);}
   for(const entry of next.pieces){const published=await read(env.BUCKET,publicKey(entry.id));if(published&&canonical(published.value)!==canonical(entry))return json({error:'Archived published identity is immutable'},409);}
   if(state.created_at&&next.created_at!==state.created_at)return json({error:'Gallery identity is immutable'},409);
   await repairMarkers(env.BUCKET,state);
   const condition=new Headers(record?{'if-match':record.etag}:{'if-none-match':'*'});const committed=await env.BUCKET.put(KEY,JSON.stringify(next),{onlyIf:condition});if(!committed)return json({error:'Revision conflict'},409);
   await repairMarkers(env.BUCKET,next);return json({action:'published',revision:next.revision});
  }
  if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed'},405);
  if(path==='/api/nightshift'||path==='/api/status')return json(state);
  if(match){const piece=await loadPiece(env.BUCKET,state,match[1]);if(!piece)return json({error:'Piece not found'},404);if(!match[2])return json(piece);const version=url.searchParams.get('version');if(!['draft','final'].includes(version))return json({error:'Choose draft or final'},400);return new Response(request.method==='HEAD'?null:renderArtifact(piece.type,piece[version]),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'"}});}
  return json({error:'Not found'},404);
 }catch{return json({error:'Gallery storage or validation failed; retry later'},503);}
}
