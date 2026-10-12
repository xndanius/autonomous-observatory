import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPiece,canonical,substantiveChange} from '../nightshift.mjs';
import {renderArtifact,validateArtifact} from '../nightshift-artifacts.mjs';

const draft={title:'Pocket garden',summary:'Collect three dewdrops and find the garden gate.',theme:'grove',grid:['##########','#P..#...G#','#.*.#.*..#','#...#....#','#...*....#','##########'],max_moves:60};
const instructions='Collect every ◆ before reaching ⚑. Move with arrow keys or WASD; use Restart to try a new route.';
const clone=value=>JSON.parse(JSON.stringify(value));
function piece(final){
  const created='2026-10-12T13:00:00.000Z',published='2026-10-12T13:04:00.000Z';
  return {id:'nightshift-game-9003-1',type:'game',title:final.title,summary:final.summary,created_at:created,published_at:published,cost_usd:.025,cost_accounting:'Recorded token cost estimate',run_url:'https://github.com/xndanius/autonomous-observatory/actions/runs/9003',draft:clone(draft),final,sources:[],changes:'Clarified the collection goal and keyboard controls in the visible opening instructions.',draft_review:{passed:true,summary:'The draft is playable and its maze has a reachable win.',issues:[],improvement:'Clarify the goal order and keyboard controls in the opening instructions.'},final_review:{passed:true,summary:'The playable final retains the maze and adds clear opening control instructions.',issues:[],improvement:'Future games could introduce a second route through the maze.'},steps:['draft','check','improvement','final_check','publish'].map((stage,i)=>({stage,at:new Date(Date.parse(created)+i*60000).toISOString(),status:stage==='publish'?'published':'passed',summary:'Recorded completed stage for this test piece.',checks:stage==='final_check'?validateArtifact('game',final).checks:[]}))};
}
const summaryFrom=html=>html.match(/<p class="summary">([\s\S]*?)<\/p>/)[1];

test('clearer usable instructions appear inside the actual playable final, while the original draft stays intact',()=>{
  const final={...clone(draft),summary:instructions};
  const draftHTML=renderArtifact('game',draft),finalHTML=renderArtifact('game',final);
  assert.equal(summaryFrom(draftHTML),draft.summary);
  assert.equal(summaryFrom(finalHTML),instructions);
  assert.match(finalHTML,/<div id="board" class="gameboard" role="grid"/);
  assert.match(finalHTML,/window\.addEventListener\('keydown'/);
  assert.notEqual(summaryFrom(draftHTML),summaryFrom(finalHTML));
  assert.equal(canonical(draft.grid),canonical(final.grid),'The independently winning maze is preserved.');
  assert.equal(substantiveChange(draft,final),true);
});

test('a first checker approval does not forbid a later real control-instruction improvement',()=>{
  const final={...clone(draft),summary:instructions},p=piece(final);
  assert.equal(p.draft_review.passed,true);
  assert.equal(validateArtifact('game',draft).passed,true);
  assert.equal(validateArtifact('game',final).passed,true);
  const report=checkPiece(p);assert.equal(report.passed,true,report.errors.join('; '));
});

test('renaming a playable piece and punctuation changes cannot replace the mandatory improvement',()=>{
  const renamed={...clone(draft),title:'A new garden name'};
  const punctuation={...clone(draft),summary:draft.summary.replace('.','!')};
  for(const final of [renamed,punctuation]){
    assert.equal(substantiveChange(draft,final),false);
    const report=checkPiece(piece(final));
    assert.equal(report.passed,false);
    assert.ok(report.errors.includes('The final artifact must contain a substantive improvement'));
  }
});
