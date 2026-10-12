import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {ARTIFACT_TYPES,artifactSchema,canRenderArtifact,validateArtifact,renderArtifact,artifactThumbnail,solveGame,gameTransition,initialGameState,checkToolFixtures,TOOL_CHORES} from '../nightshift-artifacts.mjs';

const song={title:'A small sunrise',summary:'A bright original melody with a calm chord underneath.',tempo_bpm:96,instrument:'triangle',notes:[60,64,67,64,62,65,69,65,60,64,67,72,69,67,64,60].map(midi=>({midi,duration_beats:1,rest:false})),chords:[{start_beat:0,duration_beats:4,midis:[48,52,55]},{start_beat:4,duration_beats:4,midis:[50,53,57]},{start_beat:8,duration_beats:8,midis:[48,52,55]}]};
const game={title:'Pocket garden',summary:'Collect three dewdrops and find the garden gate.',theme:'grove',grid:['##########','#P..#...G#','#.*.#.*..#','#...#....#','#...*....#','##########'],max_moves:60};
const poster={title:'The city that kept its stars',summary:'An illustrated fictional story about a quiet night.',background:'#102f43',ink:'#ffffff',art_label:'Five bright geometric stars over a small blue city.',caption:'Every window was dark; the sky was wide awake.',paragraphs:['The city switched off its lamps for one quiet minute. Above the rooftops, five stars waited patiently.'],shapes:Array.from({length:5},(_,i)=>({kind:i%2?'triangle':'circle',x:90+i*120,y:60+(i%2)*90,width:60,height:60,fill:i%2?'#f2c960':'#ffffff',stroke:'#f2c960',stroke_width:1,rotation:0}))};
const sources=[{id:'s1',url:'https://example.org/transport',title:'Transport source',excerpt:'The bridge is 200 metres long. It connects two districts.'},{id:'s2',url:'https://example.net/transport',title:'City source',excerpt:'Construction began in 2020. The project includes a footpath.'}];
const news={title:'A bridge, in two sources',summary:'A short sourced reading brief about bridge construction.',topic:'Bridge construction',claims:[{text:'The bridge is 200 metres long.',source_id:'s1',source_url:sources[0].url,source_title:sources[0].title,evidence_quote:'The bridge is 200 metres long.'},{text:'Construction began in 2020.',source_id:'s2',source_url:sources[1].url,source_title:sources[1].title,evidence_quote:'Construction began in 2020.'}]};
function tool(chore='packing-boxes',source='ceil(x/y)') {
  const d=TOOL_CHORES[chore];
  return {title:'Pack the order',summary:'Count the boxes required for a customer order.',chore,source,inputs:d.names.map((name,i)=>({name,label:d.units[i],default:name==='x'?17:name==='y'?6:10,min:d.minima[i],max:d.maxima[i],step:d.integer[i]?1:.01})),result_label:'Boxes required',decimals:d.decimals??3};
}
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(type,payload) {
  const html=renderArtifact(type,payload),script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const nodes=new Map(),events=new Map(),timers=new Map(),audio=[];
  function node(id) {
    if(!nodes.has(id)) nodes.set(id,{id,textContent:'',value:'',disabled:false,style:{},dataset:{},children:[],attributes:{},events:{},classList:{values:[],add(value){this.values.push(value);}},setAttribute(name,value){this.attributes[name]=value;},append(child){this.children.push(child);},replaceChildren(){this.children=[];},addEventListener(name,fn){this.events[name]=fn;}});
    return nodes.get(id);
  }
  for(const input of payload.inputs||[]){const n=node('input-'+input.name);n.value=String(input.default);n.dataset.integer=String(TOOL_CHORES[payload.chore].integer[TOOL_CHORES[payload.chore].names.indexOf(input.name)]);}
  const controls=['up','left','down','right'].map(move=>{const n=node('move-'+move);n.dataset.move=move;return n;});
  class Audio {
    constructor(){this.currentTime=2;this.destination={};this.notes=[];this.gains=[];this.closed=false;audio.push(this);}
    resume(){return Promise.resolve();}close(){this.closed=true;return Promise.resolve();}
    createOscillator(){const n={frequency:{events:[],setValueAtTime(value,at){this.events.push({value,at});}},connect(){},start(at){this.start_at=at;},stop(at){if(at===undefined)this.stopped=true;else this.stop_at=at;}};this.notes.push(n);return n;}
    createGain(){const n={gain:{events:[],setValueAtTime(value,at){this.events.push({value,at});},linearRampToValueAtTime(value,at){this.events.push({value,at,ramp:true});}},connect(){}};this.gains.push(n);return n;}
  }
  const context=vm.createContext({console,URL,document:{getElementById:node,createElement:()=>node('tile-'+Math.random()),querySelectorAll:selector=>selector==='[data-move]'?controls:[...nodes.values()].filter(n=>n.id.startsWith('input-'))},window:{AudioContext:Audio,addEventListener:(name,fn)=>events.set(name,fn)},setTimeout:(fn,ms)=>{const id=timers.size+1;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  if(script)vm.runInContext(script,context);
  return {html,node,events,controls,audio,timers,context};
}

test('all five strict schemas and browser/Worker-compatible module are bounded',async()=>{
  for(const type of ARTIFACT_TYPES){const schema=artifactSchema(type);assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,Object.keys(schema.properties));}
  const first=artifactSchema('song');first.properties.title.maxLength=1;assert.equal(artifactSchema('song').properties.title.maxLength,90);
  const source=await readFile(new URL('../nightshift-artifacts.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/^import /m);
  const independent=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));assert.equal(independent.validateArtifact('song',song).passed,true);
  assert.equal(validateArtifact('unknown',{}).passed,false);
});

test('original song actually schedules melody/chords with finite envelopes and stops',async()=>{
  assert.equal(validateArtifact('song',song).passed,true);
  const h=harness('song',song);assert.equal(h.audio.length,0,'no autoplay');
  await h.node('play').onclick();const a=h.audio.at(-1);
  assert.equal(a.notes.length,song.notes.length+9);
  assert.equal(a.notes[0].frequency.events[0].value,261.6255653005986);
  assert.equal(a.notes[0].start_at,2.08);assert.equal(a.notes[0].stop_at,2.715);
  assert.ok(a.gains.every(g=>g.gain.events[0].value===0 && g.gain.events.at(-1).value===0));
  assert.equal(h.node('play').disabled,true);assert.equal(h.node('stop').disabled,false);
  assert.match(h.node('status').textContent,/Playing 10 seconds/);
  h.node('stop').onclick();assert.equal(a.closed,true);assert.equal(h.node('play').disabled,false);assert.equal(h.timers.size,0);
  assert.ok(a.notes.every(n=>n.stopped));
});

test('song checker rejects inaudible/long music and out-of-bounds simultaneous chords',()=>{
  for(const mutate of [p=>p.notes.forEach(n=>n.rest=true),p=>p.notes.forEach(n=>n.midi=60),p=>p.tempo_bpm=1,p=>p.notes.forEach(n=>n.duration_beats=8),p=>p.chords[0].duration_beats=16,p=>p.chords.push(...Array.from({length:4},()=>({start_beat:0,duration_beats:1,midis:[48,52]})))]) {
    const p=clone(song);mutate(p);if(p.chords[0].duration_beats===16)p.chords[0].start_beat=3;assert.equal(validateArtifact('song',p).passed,false);
  }
});

test('independent maze route wins in browser movement, score and restart controls',()=>{
  const report=validateArtifact('game',game);assert.equal(report.passed,true,report.errors.join('; '));
  const solution=solveGame(game),h=harness('game',game);
  assert.equal(h.node('board').children.length,60);
  for(const direction of solution.route) h.node('move-'+direction).onclick();
  assert.match(h.node('status').textContent,/You won! 3 gems/);
  const finished=vm.runInContext('JSON.stringify(state)',h.context);assert.equal(JSON.parse(finished).won,true);
  h.node('restart').onclick();assert.match(h.node('status').textContent,/Gems 0\/3/);
  let prevented=false;h.events.get('keydown')({key:'ArrowRight',preventDefault(){prevented=true;}});assert.equal(prevented,true);
  assert.equal(JSON.parse(vm.runInContext('JSON.stringify(state)',h.context)).moves,1);
  const initial=initialGameState(game);assert.equal(gameTransition(initial,'up').moves,0,'walls do not consume a move');
});

test('game checker rejects unreachable gems, impossible limits and malformed geometry',()=>{
  const blocked=clone(game);blocked.grid=['##########','#P..#...G#','#.*.#.*..#','#...#....#','#...#*...#','##########'];assert.equal(validateArtifact('game',blocked).passed,false);
  const tooFew=clone(game);tooFew.grid=tooFew.grid.map(row=>row.replaceAll('*','.'));assert.equal(validateArtifact('game',tooFew).passed,false);
  const short=clone(game);short.grid=['####################','#P...............*G#','#.################.#','#*................*#','####################'];short.max_moves=20;assert.ok(solveGame(short).moves>20);assert.equal(validateArtifact('game',short).passed,false);
  const crooked=clone(game);crooked.grid[1]+='.';assert.equal(validateArtifact('game',crooked).passed,false);
  const absent=clone(game);absent.grid=absent.grid.map(row=>row.replace('P','.'));assert.equal(validateArtifact('game',absent).passed,false);
});

test('actual useful tool recalculates live order input and refuses invalid values',()=>{
  const p=tool(),report=validateArtifact('tool',p);assert.equal(report.passed,true,report.errors.join('; '));
  const h=harness('tool',p);assert.equal(h.node('result').textContent,'3');
  h.node('input-x').value='25';h.node('input-x').events.input();assert.equal(h.node('result').textContent,'5');
  h.node('input-y').value='0';h.node('calculator').onsubmit({preventDefault(){}});assert.equal(h.node('result').textContent,'');assert.match(h.node('status').textContent,/valid Box capacity/);
  h.node('input-y').value='6';h.node('input-x').value='2.5';h.node('input-x').events.input();assert.match(h.node('status').textContent,/valid Items/);
  h.node('input-x').value='';h.node('input-x').events.input();assert.equal(h.node('result').textContent,'');
});

test('all five customer chores pass independent edge fixtures; plausible wrong programs fail',()=>{
  const good={'discount-checkout':'floor(x*y*(100-z)/100)','packing-boxes':'ceil(x/y)','celsius-fahrenheit':'x*9/5+32','journey-minutes':'x/y*60','km-to-miles':'x/1.609344'};
  for(const [chore,source] of Object.entries(good)) {
    const p=tool(chore,source);assert.equal(validateArtifact('tool',p).passed,true,chore);
    const fixtures=checkToolFixtures(p);assert.equal(fixtures.length,17);assert.ok(fixtures.every(f=>f.passed));
    const bad=tool(chore,'x+y');assert.equal(validateArtifact('tool',bad).passed,false,chore);
  }
  const unlabelled=tool();unlabelled.inputs[0].label='Anything';assert.equal(validateArtifact('tool',unlabelled).passed,false);
  const undeclared=tool();undeclared.source='ceil(x/y)+z';assert.equal(validateArtifact('tool',undeclared).passed,false);
  const executable=tool();executable.source='fetch("https://example.org")';assert.equal(validateArtifact('tool',executable).passed,false);
});

test('poster renders actual safe illustrated SVG with descriptive text and story',()=>{
  assert.equal(validateArtifact('poster',poster).passed,true);
  const html=renderArtifact('poster',poster);assert.equal((html.match(/<(?:circle|polygon) /g)||[]).length,5);assert.match(html,/role="img"/);assert.match(html,/The city switched off its lamps/);assert.doesNotMatch(html,/<script>/);
  const clipped=clone(poster);clipped.shapes[0].x=799;assert.equal(validateArtifact('poster',clipped).passed,false);
  assert.match(artifactThumbnail('poster',poster),/^<svg/);
});

test('news rejects invented or mismatched facts, stale identifiers, unsafe links and long copied passages',()=>{
  assert.equal(validateArtifact('news',news,{sources}).passed,true);
  assert.equal(validateArtifact('news',news).passed,false,'no source memory cannot prove facts');
  const invented=clone(news);invented.claims[0].text='The bridge is 900 metres long.';assert.equal(validateArtifact('news',invented,{sources}).passed,false);
  const wrong=clone(news);wrong.claims[0].source_url='https://unrelated.example/article';assert.equal(validateArtifact('news',wrong,{sources}).passed,false);
  const malicious=clone(news);malicious.claims[0].source_url='javascript:alert(1)';assert.equal(validateArtifact('news',malicious,{sources}).passed,false);
  const inventedSource=clone(news);inventedSource.claims[0].source_id='missing';assert.equal(validateArtifact('news',inventedSource,{sources}).passed,false);
  const quote=Array.from({length:26},()=> 'word').join(' '),long=clone(news);long.claims[0].text=long.claims[0].evidence_quote=quote;assert.equal(validateArtifact('news',long,{sources:[{...sources[0],excerpt:quote},sources[1]]}).passed,false);
  const html=renderArtifact('news',news);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/https:\/\/example.org\/transport/);assert.doesNotMatch(html,/<script>|fetch\(/);
});

test('model strings stay inert in HTML, SVG and browser scripts; no external resources',()=>{
  for(const [type,base] of [['song',song],['game',game],['poster',poster],['news',news],['tool',tool()]]) {
    const p=clone(base);p.title='</script><img src=x onerror=alert(1)>';p.summary='<iframe src="https://attacker.example">';
    const html=renderArtifact(type,p);assert.doesNotMatch(html,/<img|<iframe|<script[^>]+src=|<link|eval\(|new Function/);assert.match(html,/&lt;img/);
    assert.equal((html.match(/<script>/g)||[]).length,['song','game','tool'].includes(type)?1:0);
    if(['song','game','tool'].includes(type))assert.doesNotThrow(()=>harness(type,p));
    assert.doesNotMatch(artifactThumbnail(type,p),/<img|<script>/);
  }
});

test('machine check rejects unexpected code fields and nonfinite values without throwing',()=>{
  const scripted=clone(song);scripted.javascript='alert(1)';assert.equal(validateArtifact('song',scripted).passed,false);
  const infinite=clone(song);infinite.tempo_bpm=Infinity;assert.equal(validateArtifact('song',infinite).passed,false);
  for(const payload of [null,[],{},'bad'])assert.equal(validateArtifact('game',payload).passed,false);
  assert.throws(()=>renderArtifact('song',scripted),/unknown field javascript/);
});

test('failed but executable draft stays playable beside its genuinely improved final',()=>{
  const draft=tool('packing-boxes','floor(x/y)'),final=tool('packing-boxes','ceil(x/y)');
  assert.equal(canRenderArtifact('tool',draft).passed,true);
  assert.equal(validateArtifact('tool',draft).passed,false);
  assert.equal(harness('tool',draft).node('result').textContent,'2');
  assert.equal(harness('tool',final).node('result').textContent,'3');
  const malformed=clone(draft);malformed.source='alert(1)';
  assert.equal(canRenderArtifact('tool',malformed).passed,false);
  assert.throws(()=>renderArtifact('tool',malformed));
  const noPlayer=clone(game);noPlayer.grid=noPlayer.grid.map(row=>row.replace('P','.'));
  assert.equal(canRenderArtifact('game',noPlayer).passed,false);
  assert.throws(()=>renderArtifact('game',noPlayer));
});

test('game improvement changes real win feasibility while the draft remains executable',()=>{
  const draft={...game,grid:['####################','#P...............*G#','#.################.#','#*................*#','####################'],max_moves:20};
  const final={...draft,max_moves:32,theme:'orbit'};
  assert.equal(canRenderArtifact('game',draft).passed,true);assert.equal(validateArtifact('game',draft).passed,false);
  assert.equal(validateArtifact('game',final).passed,true);
  const route=solveGame(final).route,first=harness('game',draft),improved=harness('game',final);
  for(const direction of route){first.node('move-'+direction).onclick();improved.node('move-'+direction).onclick();}
  assert.match(first.node('status').textContent,/Out of moves/);
  assert.match(improved.node('status').textContent,/You won! 3 gems/);
  assert.match(improved.html,/--wall:#3c2b56/);assert.match(first.html,/--wall:#28433c/);
});
