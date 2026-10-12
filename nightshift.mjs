import {createHash} from 'node:crypto';
import {validateArtifact,canRenderArtifact} from './nightshift-artifacts.mjs';
export const ROTATION=['song','game','tool','poster','news'];
export const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
export const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
export const hourAfter=at=>new Date(Date.parse(at)+3600000).toISOString();
export const substantiveChange=(draft,final)=>{
 const body=x=>Object.fromEntries(Object.entries(x||{}).filter(([k])=>!['title','summary'].includes(k)));
 if(canonical(body(draft))!==canonical(body(final)))return true;
 // Instructions are rendered inside the actual artifact, so a clearer control
 // legend is a real usability improvement. Names and punctuation are not.
 const before=new Set(String(draft?.summary||'').toLowerCase().match(/[a-z0-9]+/g)||[]);
 const added=[...new Set(String(final?.summary||'').toLowerCase().match(/[a-z0-9]+/g)||[])].filter(w=>!before.has(w));
 return added.length>=2&&String(final?.summary||'').length>=20&&/control|move|collect|reach|legend|input|enter|unit|box|price|calculate|convert|play|stop|read/i.test(final?.summary||'');
};
export const validRecordedReview=x=>x&&typeof x.passed==='boolean'&&typeof x.summary==='string'&&x.summary.length>=20&&x.summary.length<=1000&&Array.isArray(x.issues)&&x.issues.length<=8&&x.issues.every(v=>typeof v==='string'&&v.length<=600)&&typeof x.improvement==='string'&&x.improvement.length>=10&&x.improvement.length<=1500;
export const emptyGallery=()=>({schema_version:2,title:'The Night Shift',revision:0,piece_count:0,attempt_count:0,created_at:null,updated_at:null,schedule:{status:'preparing',runner:'github-actions',cadence_minutes:60,next_piece_at:null,last_run_url:null,budget:null},pieces:[],failures:[]});
export function metadata(piece){return Object.fromEntries(['id','type','title','summary','created_at','published_at','cost_usd','run_url','changes','steps','cost_accounting'].map(k=>[k,piece[k]]));}
export function checkPiece(piece){
 const errors=[];const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
 if(!piece||!/^nightshift-[a-z]+-\d+-[1-9]\d*$/.test(piece.id)||!ROTATION.includes(piece.type))errors.push('Invalid piece identity');
 if(!iso(piece?.created_at)||!iso(piece?.published_at)||Date.parse(piece.published_at)<Date.parse(piece.created_at))errors.push('Invalid actual timestamps');
 if(!/^https:\/\/github\.com\/xndanius\/autonomous-observatory\/actions\/runs\/\d+$/.test(piece?.run_url))errors.push('Invalid provenance');
 if(typeof piece?.cost_usd!=='number'||!Number.isFinite(piece.cost_usd)||piece.cost_usd<0)errors.push('Invalid cost');
 if(typeof piece?.changes!=='string'||piece.changes.trim().length<10)errors.push('Describe the actual improvement');
 if(!Array.isArray(piece?.steps)||piece.steps.map(s=>s.stage).join(',')!=='draft,check,improvement,final_check,publish')errors.push('All real stages are required');
 else{let previous=Date.parse(piece.created_at);for(const s of piece.steps){if(!iso(s.at)||Date.parse(s.at)<previous||Date.parse(s.at)>Date.parse(piece.published_at)||!['passed','needs_improvement','published'].includes(s.status))errors.push('Invalid stage chronology');previous=Date.parse(s.at);}}
 for(const version of ['draft','final']){try{const renderable=canRenderArtifact(piece.type,piece[version]);if(!renderable.passed)errors.push(...renderable.errors);const v=validateArtifact(piece.type,piece[version],{sources:piece.sources||[]});if(version==='final'){if(!v.passed)errors.push(...v.errors);if(canonical(piece.steps?.find(s=>s.stage==='final_check')?.checks)!==canonical(v.checks))errors.push('Final machine evidence differs from recomputation');}}catch{errors.push('Invalid '+version+' artifact');}}
 if(!substantiveChange(piece?.draft,piece?.final))errors.push('The final artifact must contain a substantive improvement');
 if(!validRecordedReview(piece?.draft_review)||!validRecordedReview(piece?.final_review)||piece?.final_review?.passed!==true)errors.push('The independent checker reports are missing or final approval failed');
 if(piece?.title!==piece?.final?.title||piece?.summary!==piece?.final?.summary)errors.push('Gallery description differs from the final artifact');
 return {passed:errors.length===0,errors};
}
