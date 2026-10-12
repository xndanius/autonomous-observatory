import {metadata,canonical,sha} from './nightshift.mjs';
export async function publishGallery({origin,writerToken,state,piece,fetchImpl=fetch}){
 if(origin!=='https://autonomous-observatory-20261011.xndanius.chatgpt.site')throw Error('Wrong pinned origin');
 async function get(path,expected){for(let n=0;n<3;n++){try{const r=await fetchImpl(origin+path,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Read unavailable');const value=await r.json();if(expected&&canonical(value)!==canonical(expected))throw Error('Read-back differs');return value;}catch{if(n===2)throw Error('Public read-back failed');await new Promise(r=>setTimeout(r,500*(n+1)));}}}
 async function put(path,value){const r=await fetchImpl(origin+path,{method:'PUT',headers:{authorization:'Bearer '+writerToken,'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Protected gallery publication failed '+r.status);return r.json();}
 const current=await get('/api/nightshift');if(current.revision!==state.revision)throw Error('Stale gallery proposal');
 const next=structuredClone(state);next.revision=current.revision+1;
 if(piece){const stage=await put('/api/nightshift/pieces/'+piece.id,{piece});if(stage.state_ref!==sha(piece))throw Error('Staged digest differs');next.pieces.push({...metadata(piece),state_ref:stage.state_ref});next.pieces=next.pieces.slice(-100);next.piece_count=(state.piece_count??state.pieces.length)+1;}
 const done=await put('/api/nightshift',{expected_revision:current.revision,state:next});if(done.revision!==next.revision)throw Error('Publication revision differs');
 await get('/api/nightshift',next);if(piece)await get('/api/nightshift/pieces/'+piece.id,piece);return {state:next,revision:next.revision,url:origin+(piece?'#'+piece.id:'')};
}
