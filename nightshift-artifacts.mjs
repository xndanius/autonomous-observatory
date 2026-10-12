/** Bounded, executable Night Shift pieces. Model data never becomes JavaScript. */

export const ARTIFACT_TYPES = Object.freeze(['song', 'game', 'poster', 'news', 'tool']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseRepairSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 160) throw new RangeError('App source must be 1–160 characters.');
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/,])/y;
  let cursor = 0;
  while (cursor < source.length) {
    if (!source.slice(cursor).trim()) break;
    re.lastIndex = cursor;
    const match = re.exec(source);
    if (!match) throw new SyntaxError('Only numbers, x/y/z, arithmetic and the documented functions are allowed.');
    tokens.push(match[1]); cursor = re.lastIndex;
    if (tokens.length > 96) throw new RangeError('App source has too many tokens.');
  }
  let position = 0, nodes = 0;
  const node = value => { if (++nodes > 64) throw new RangeError('App source exceeds 64 syntax nodes.'); return value; };
  const expression = (depth, minimum = 0) => {
    if (depth > 12) throw new RangeError('App source exceeds twelve nesting levels.');
    const token = tokens[position++]; let left;
    if (token === '-' || token === '+') left = node({ kind: 'unary', op: token, arg: expression(depth + 1, 3) });
    else if (token === '(') { left = expression(depth + 1); if (tokens[position++] !== ')') throw new SyntaxError('Missing closing parenthesis.'); }
    else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      const value = Number(token); if (!Number.isFinite(value) || value > 1000000) throw new RangeError('Constants must be finite and at most one million.');
      left = node({ kind: 'number', value });
    } else if (['x', 'y', 'z'].includes(token)) left = node({ kind: 'input', name: token });
    else if (['floor', 'ceil', 'round', 'abs', 'min', 'max'].includes(token)) {
      if (tokens[position++] !== '(') throw new SyntaxError('Function calls need parentheses.');
      const args = [expression(depth + 1)];
      if (['min', 'max'].includes(token)) { if (tokens[position++] !== ',') throw new SyntaxError('min/max need two arguments.'); args.push(expression(depth + 1)); }
      if (tokens[position++] !== ')') throw new SyntaxError('Incorrect function arguments.');
      left = node({ kind: 'call', name: token, args });
    } else throw new SyntaxError('Expected a number, an input or a documented function.');
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
    while (precedence[tokens[position]] !== undefined && precedence[tokens[position]] >= minimum) {
      const op = tokens[position++]; left = node({ kind: 'binary', op, left, right: expression(depth + 1, precedence[op] + 1) });
    }
    return left;
  };
  const ast = expression(0);
  if (position !== tokens.length) throw new SyntaxError('Unexpected trailing source.');
  return ast;
}
export function evaluateRepairSource(source, inputs = {}) {
  try {
    if (!object(inputs) || Object.keys(inputs).some(key => !['x', 'y', 'z'].includes(key))) throw new TypeError('Inputs are numeric x, y and z fields.');
    const values = Object.fromEntries(['x', 'y', 'z'].map(name => {
      const value = inputs[name] === undefined ? 0 : inputs[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) throw new RangeError('Inputs must be finite numbers between minus and plus one million.');
      return [name, value];
    }));
    const visit = node => {
      let value;
      if (node.kind === 'number') value = node.value;
      else if (node.kind === 'input') value = values[node.name];
      else if (node.kind === 'unary') value = node.op === '-' ? -visit(node.arg) : visit(node.arg);
      else if (node.kind === 'call') value = Math[node.name](...node.args.map(visit));
      else { const a = visit(node.left), b = visit(node.right); value = node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b; }
      if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new RangeError('The calculation is undefined or exceeds the numeric bound.');
      return Object.is(value, -0) ? 0 : value;
    };
    return { ok: true, value: visit(parseRepairSource(source)), error: null };
  } catch (error) { return { ok: false, value: null, error: error.message }; }
}

const text = (maxLength, minLength = 1) => ({type:'string', minLength, maxLength});
const number = (minimum, maximum, integer = false) => ({type:integer ? 'integer' : 'number', minimum, maximum});
const list = (items, minItems, maxItems) => ({type:'array', items, minItems, maxItems});
const record = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const colour = {type:'string', pattern:'^#[0-9a-fA-F]{6}$'};
const one = values => ({type:'string', enum:values});
const shared = {title:text(90), summary:text(200)};
const schemas = {
  song:record({...shared, tempo_bpm:number(60,180), instrument:one(['sine','triangle']), notes:list(record({midi:number(36,96,true), duration_beats:number(.25,8), rest:{type:'boolean'}}),8,96), chords:list(record({start_beat:number(0,96), duration_beats:number(.25,16), midis:list(number(36,84,true),2,4)}),0,16)}),
  game:record({...shared, theme:one(['grove','orbit','city']), grid:list({type:'string',minLength:6,maxLength:20,pattern:'^[#.PG*]+$'},5,14), max_moves:number(20,600,true)}),
  poster:record({...shared, background:colour, ink:colour, art_label:text(250), caption:text(200), paragraphs:list(text(600),1,4), shapes:list(record({kind:one(['circle','ellipse','rect','triangle','line']),x:number(0,800),y:number(0,500),width:number(1,800),height:number(1,500),fill:colour,stroke:colour,stroke_width:number(0,8),rotation:number(-180,180)}),5,40)}),
  news:record({...shared, topic:text(120), claims:list(record({text:text(240),source_id:text(80),source_url:text(1000),source_title:text(200),evidence_quote:text(240)}),2,6)}),
  tool:record({...shared, chore:one(['discount-checkout','packing-boxes','celsius-fahrenheit','journey-minutes','km-to-miles']), source:text(160), inputs:list(record({name:one(['x','y','z']),label:text(60),default:number(-1000000,1000000),min:number(-1000000,1000000),max:number(-1000000,1000000),step:number(.0001,1000)}),1,3), result_label:text(80), decimals:number(0,6,true)})
};
export function artifactSchema(type) {
  if (!ARTIFACT_TYPES.includes(type)) throw new RangeError('Unknown Night Shift artifact type.');
  return JSON.parse(JSON.stringify(schemas[type]));
}
function schemaErrors(schema, value, path = 'payload') {
  const errors = [];
  const fail = detail => errors.push(`${path}: ${detail}`);
  if (schema.type === 'object') {
    if (!object(value)) return [`${path}: expected an object`];
    for (const key of schema.required) if (!Object.hasOwn(value,key)) fail(`missing ${key}`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties,key)) fail(`unknown field ${key}`);
    for (const [key,s] of Object.entries(schema.properties)) if (Object.hasOwn(value,key)) errors.push(...schemaErrors(s,value[key],`${path}.${key}`));
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    if (value.length < schema.minItems || value.length > schema.maxItems) fail(`expected ${schema.minItems}–${schema.maxItems} items`);
    for (const [i,v] of value.slice(0,schema.maxItems + 1).entries()) errors.push(...schemaErrors(schema.items,v,`${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${path}: expected text`];
    if (schema.minLength && value.trim().length < schema.minLength || schema.maxLength && value.length > schema.maxLength) fail('text length is outside its bound');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('text does not match the allowed format');
    if (schema.enum && !schema.enum.includes(value)) fail('unknown choice');
  } else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('expected a boolean'); }
  else if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) fail('number is outside its bound');
  return errors;
}

/** A wrong calculation can be a visible draft; malformed code/data cannot. */
export function canRenderArtifact(type,payload) {
  if(!ARTIFACT_TYPES.includes(type))return {passed:false,errors:['Unknown Night Shift artifact type.']};
  const errors=schemaErrors(schemas[type],payload);
  if(errors.length)return {passed:false,errors};
  if(type==='game') {
    const chars=payload.grid.join('');
    if(!payload.grid.every(row=>row.length===payload.grid[0].length))errors.push('Game grid must be rectangular to render executable movement.');
    if([...chars].filter(c=>c==='P').length!==1||[...chars].filter(c=>c==='G').length!==1)errors.push('Game requires exactly one player and one goal.');
  }
  if(type==='tool') {
    const names=payload.inputs.map(input=>input.name);
    if(new Set(names).size!==names.length)errors.push('Calculator inputs require unique names.');
    try {
      const visit=node=>{if(node.kind==='input'&&!names.includes(node.name))throw Error('Source uses an undeclared input.');if(node.arg)visit(node.arg);if(node.left)visit(node.left);if(node.right)visit(node.right);for(const n of node.args||[])visit(n);};
      visit(parseRepairSource(payload.source));
    }catch(error){errors.push(error.message);}
  }
  return {passed:errors.length===0,errors};
}

export const TOOL_CHORES = Object.freeze({
  'discount-checkout':{description:'Calculate a discounted basket total in whole cents; round down once at the end.', names:['x','y','z'], units:['Unit price (cents)','Quantity','Discount (%)'], minima:[0,0,0],maxima:[1000000,1000,100],integer:[true,true,false],decimals:0, fixtures:[{x:1299,y:3,z:10},{x:101,y:1,z:15},{x:500,y:2,z:100},{x:0,y:10,z:25},{x:199,y:2,z:25}]},
  'packing-boxes':{description:'Find how many boxes are needed, counting a partly filled box as one.',names:['x','y'],units:['Items','Box capacity'],minima:[0,1],maxima:[1000000,1000000],integer:[true,true],decimals:0,fixtures:[{x:17,y:6},{x:12,y:6},{x:1,y:8},{x:0,y:8},{x:101,y:10}]},
  'celsius-fahrenheit':{description:'Convert degrees Celsius to degrees Fahrenheit.',names:['x'],units:['Celsius (°C)'],minima:[-273.15],maxima:[1000000],integer:[false],decimals:null,fixtures:[{x:0},{x:100},{x:-40},{x:12.5},{x:-273.15}]},
  'journey-minutes':{description:'Estimate uninterrupted travel time in minutes from kilometres and kilometres per hour.',names:['x','y'],units:['Distance (km)','Speed (km/h)'],minima:[0,.0001],maxima:[1000000,1000000],integer:[false,false],decimals:null,fixtures:[{x:12,y:24},{x:5,y:5},{x:1,y:12},{x:0,y:10},{x:2.5,y:20}]},
  'km-to-miles':{description:'Convert kilometres to international miles using exactly 1 mile = 1.609344 km.',names:['x'],units:['Distance (km)'],minima:[0],maxima:[1000000],integer:[false],decimals:null,fixtures:[{x:0},{x:1.609344},{x:5},{x:42.195},{x:1000}]}
});
function toolOracle(chore,{x=0,y=0,z=0}) {
  if (chore === 'discount-checkout') return Math.floor(x * y * (100 - z) / 100);
  if (chore === 'packing-boxes') return Math.ceil(x / y);
  if (chore === 'celsius-fahrenheit') return x * 1.8 + 32;
  if (chore === 'journey-minutes') return 60 * x / y;
  return x / 1.609344;
}
export function checkToolFixtures(payload) {
  const definition = TOOL_CHORES[payload.chore];
  if (!definition) throw new RangeError('Unknown customer chore.');
  const fixtures = [...definition.fixtures];
  // Separate, deterministic edge/interior samples prevent invented self-tests.
  for (let i = 1; i <= 12; i++) fixtures.push(Object.fromEntries(definition.names.map((name,j) => [name,
    definition.integer[j] ? Math.max(definition.minima[j],(i * (j + 3) * 17) % 299) : name === 'z' ? (i * 7) % 100 : definition.minima[j] + i * (j + 1) * 3.125])));
  return fixtures.map((inputs,i) => {
    const actual = evaluateRepairSource(payload.source,inputs), expected = toolOracle(payload.chore,inputs);
    const matches = definition.decimals === 0 ? actual.value === expected : Math.abs(actual.value - expected) <= 1e-8 * Math.max(1,Math.abs(expected));
    return {id:`independent-${i+1}`,inputs,expected,actual:actual.value,passed:actual.ok && matches,error:actual.error};
  });
}

export function parseGameGrid(grid) {
  const width = grid[0].length, walls = [], gems = [];
  let player = -1, goal = -1;
  for (const [y,row] of grid.entries()) for (const [x,char] of [...row].entries()) {
    const cell = y * width + x;
    if (char === '#') walls.push(cell);
    if (char === '*') gems.push(cell);
    if (char === 'P') player = cell;
    if (char === 'G') goal = cell;
  }
  return {width,height:grid.length,walls,gems,player,goal};
}
export function gameTransition(state,direction) {
  if (state.won || state.lost) return {...state};
  const delta = {up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[direction];
  if (!delta) return {...state};
  const x = state.player % state.width + delta[0], y = Math.floor(state.player / state.width) + delta[1];
  if (x < 0 || y < 0 || x >= state.width || y >= state.height || state.walls.includes(y * state.width + x)) return {...state};
  const player = y * state.width + x, gems = state.gems.filter(cell => cell !== player), moves = state.moves + 1;
  const won = gems.length === 0 && player === state.goal;
  return {...state,player,gems,moves,score:state.total_gems-gems.length,won,lost:!won && moves >= state.max_moves};
}
export function initialGameState(payload) {
  const board = parseGameGrid(payload.grid);
  return {...board,total_gems:board.gems.length,score:0,moves:0,max_moves:payload.max_moves,won:false,lost:false};
}
export function solveGame(payload) {
  const board = parseGameGrid(payload.grid), points = [board.player,...board.gems,board.goal];
  const routes = points.map(start => {
    const found = new Map([[start,[]]]), queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const cell = queue[q], x = cell % board.width, y = Math.floor(cell / board.width);
      for (const [direction,dx,dy] of [['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]]) {
        const nx=x+dx,ny=y+dy,next=ny*board.width+nx;
        if (nx<0 || ny<0 || nx>=board.width || ny>=board.height || board.walls.includes(next) || found.has(next)) continue;
        found.set(next,[...found.get(cell),direction]); queue.push(next);
      }
    }
    return points.map(end => found.get(end) || null);
  });
  if (routes[0].some(route => route === null)) return {reachable:false,route:[],moves:null};
  const n = board.gems.length, table = new Map([['0:0',[]]]);
  for (let mask=0;mask<2**n;mask++) for (let last=0;last<=n;last++) {
    const route=table.get(`${mask}:${last}`); if (!route) continue;
    for (let next=1;next<=n;next++) if (!(mask & (1<<(next-1)))) {
      const key=`${mask | (1<<(next-1))}:${next}`,candidate=[...route,...routes[last][next]],prior=table.get(key);
      if (!prior || candidate.length<prior.length) table.set(key,candidate);
    }
  }
  const finalists=[];
  for (let last=0;last<=n;last++) { const route=table.get(`${2**n-1}:${last}`); if (route) finalists.push([...route,...routes[last][n+1]]); }
  finalists.sort((a,b)=>a.length-b.length);
  return {reachable:true,route:finalists[0],moves:finalists[0].length};
}
const words = value => value.trim().split(/\s+/).filter(Boolean).length;
function safeHttps(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !['localhost','127.0.0.1','[::1]'].includes(u.hostname) && !u.hostname.endsWith('.local'); } catch { return false; }
}
/** Checks are deterministic evidence with a deliberately explicit scope. */
export function validateArtifact(type,payload,{sources=[]}={}) {
  const checks = [],errors = [];
  const check = (id,passed,detail) => {checks.push({id,passed:Boolean(passed),detail});if(!passed) errors.push(`${id}: ${detail}`);};
  if (!ARTIFACT_TYPES.includes(type)) return {passed:false,checks:[],errors:['Unknown Night Shift artifact type.']};
  const structural = schemaErrors(schemas[type],payload);
  check('bounded-payload',structural.length === 0,structural.join('; ') || 'Only documented bounded data fields are present.');
  if (structural.length) return {passed:false,checks,errors};
  try {
    if (type === 'song') {
      const beats = payload.notes.reduce((sum,n)=>sum+n.duration_beats,0),seconds=60*beats/payload.tempo_bpm,played=payload.notes.filter(n=>!n.rest);
      check('audible-length',seconds>=8 && seconds<=75,`The composition lasts ${seconds.toFixed(2)} seconds; allowed range 8–75.`);
      check('melody',played.length>=8 && new Set(played.map(n=>n.midi)).size>=3,'At least eight audible notes and three different pitches.');
      check('chord-timing',payload.chords.every(c=>c.start_beat+c.duration_beats<=beats && new Set(c.midis).size===c.midis.length),'Every distinct-pitch chord finishes within the melody.');
      check('polyphony',payload.chords.every(c=>payload.chords.filter(other=>other.start_beat<c.start_beat+c.duration_beats && other.start_beat+other.duration_beats>c.start_beat).length<=3),'No more than three simultaneous chord events.');
      check('playable-web-audio',true,'Browser synthesizer uses bounded MIDI pitches, finite durations, a gain envelope and explicit Play/Stop.');
    } else if (type === 'game') {
      const chars=payload.grid.join(''),rectangular=payload.grid.every(row=>row.length===payload.grid[0].length);
      check('grid-geometry',rectangular && [...chars].filter(c=>c==='P').length===1 && [...chars].filter(c=>c==='G').length===1,'Rectangular board with exactly one player and one goal.');
      const gems=[...chars].filter(c=>c==='*').length;
      check('collectibles',gems>=2 && gems<=8,'Two to eight collectible gems.');
      if (rectangular && checks.at(-2).passed && gems>=2 && gems<=8) {
        const solution=solveGame(payload);check('reachable-win',solution.reachable && solution.moves<=payload.max_moves,`Independent maze search needs ${solution.moves ?? 'unreachable'} moves; limit ${payload.max_moves}.`);
        let state=initialGameState(payload);for(const direction of solution.route) state=gameTransition(state,direction);
        check('executed-win',state.won && !state.lost && state.score===gems,'The found route executes through the shipped movement rules and collects every gem before winning.');
      }
    } else if (type === 'poster') {
      check('visible-illustration',payload.shapes.every(s=>s.x+s.width<=800 && s.y+s.height<=500),'Every shape lies within the illustration viewBox before rotation.');
      check('illustrated-story',new Set(payload.shapes.map(s=>s.fill)).size>=2 && payload.caption.length>=10,'Illustration has at least two shape colours and a readable caption.');
      check('accessible-poster',payload.art_label.length>=10 && payload.ink.toLowerCase()!==payload.background.toLowerCase(),'Illustration has a descriptive text alternative and a distinct text colour.');
    } else if (type === 'news') {
      const used=new Map();let grounded=true,links=true,short=true;
      for(const claim of payload.claims) {
        const source=sources.find(s=>s.id===claim.source_id),quote=claim.evidence_quote.trim();
        grounded &&= Boolean(source && typeof source.excerpt==='string' && quote.length>=15 && source.excerpt.includes(quote) && claim.text===quote);
        links &&= Boolean(source && claim.source_url===source.url && claim.source_title===source.title && safeHttps(claim.source_url));
        used.set(claim.source_id,(used.get(claim.source_id)||0)+words(quote));
      }
      for(const count of used.values()) short &&= count<=25;
      check('trusted-source-extracts',grounded,'Each factual claim is an exact short extract from its supplied trusted source excerpt. This check proves source correspondence, not the source’s universal accuracy.');
      check('source-links',links,'Every HTTPS source link and title matches the trusted source record.');
      check('short-extracts',short,'No more than 25 quoted words per source.');
      check('source-diversity',used.size>=2,'At least two independently identified source records.');
    } else {
      const d=TOOL_CHORES[payload.chore],names=payload.inputs.map(i=>i.name);
      check('customer-inputs',names.length===d.names.length && d.names.every(name=>names.includes(name)) && new Set(names).size===names.length,'Inputs match the selected concrete customer chore.');
      check('input-domain',payload.inputs.every(i=>{const j=d.names.indexOf(i.name);return j>=0 && i.min>=d.minima[j] && i.max<=d.maxima[j] && i.min<i.max && i.default>=i.min && i.default<=i.max && (!d.integer[j] || Number.isSafeInteger(i.default) && Number.isSafeInteger(i.min) && Number.isSafeInteger(i.max) && Number.isSafeInteger(i.step));}),'Defaults and input ranges respect independently defined physical and numeric domains.');
      check('display-units',payload.inputs.every(i=>i.label===d.units[d.names.indexOf(i.name)]) && (d.decimals===null || payload.decimals===d.decimals),'Labels state canonical units; integer-result chores display whole counts/cents.');
      try {const ast=parseRepairSource(payload.source);const namesInSource=[];const visit=node=>{if(node.kind==='input')namesInSource.push(node.name);if(node.arg)visit(node.arg);if(node.left)visit(node.left);if(node.right)visit(node.right);for(const n of node.args||[])visit(n);};visit(ast);check('safe-expression',namesInSource.every(name=>names.includes(name)),'Source parses as bounded arithmetic and uses only declared inputs.');} catch(error){check('safe-expression',false,error.message);}
      const fixtures=checkToolFixtures(payload);check('independent-fixtures',fixtures.every(f=>f.passed),`${fixtures.filter(f=>f.passed).length}/${fixtures.length} independently computed golden and edge/interior examples pass.`);
      const defaults=Object.fromEntries(payload.inputs.map(i=>[i.name,i.default]));check('default-calculation',evaluateRepairSource(payload.source,defaults).ok,'The displayed defaults compute a finite real result.');
    }
  } catch(error) {check('complete-check',false,error.message);}
  return {passed:errors.length===0,checks,errors};
}

const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const json = value => JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const css = `:root{color-scheme:light;--ink:#18273b;--muted:#566779;--accent:#256760;--paper:#fffdf7}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,sans-serif}main{max-width:920px;margin:auto;padding:clamp(20px,5vw,48px)}.kicker{font:700 12px/1.4 system-ui;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)}h1{font-size:clamp(30px,6vw,58px);line-height:1.06;letter-spacing:-.04em;margin:12px 0 16px}.summary{max-width:65ch;color:var(--muted)}button,input{font:inherit}button{cursor:pointer;border:1px solid #bad0cb;border-radius:12px;padding:12px 20px;background:var(--accent);color:white}button:focus-visible,input:focus-visible{outline:3px solid #e2a530;outline-offset:3px}button.secondary{background:transparent;color:var(--ink)}button:disabled{opacity:.55;cursor:default}.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.stage{margin:24px 0;border:1px solid #dce2dd;border-radius:20px;overflow:hidden;background:#f0f4ed;padding:20px}svg{display:block;width:100%;height:auto}.hint{font-size:14px;color:var(--muted)}[role=status]{min-height:1.6em}.gameboard{display:grid;gap:3px;max-width:620px;margin:auto;touch-action:none}.cell{aspect-ratio:1;border-radius:4px;background:var(--path,#dce8d3);display:grid;place-items:center;font-size:clamp(10px,2.6vw,24px)}.wall{background:var(--wall,#28433c)}.goal{background:var(--goal,#dbb454)}.player{background:var(--player,#fffdf7);box-shadow:inset 0 0 0 3px #1e7568}.gem{background:var(--gem,#c2e3df)}.pad{display:grid;grid-template-columns:repeat(3,56px);grid-template-rows:repeat(2,48px);gap:7px;margin:18px auto;width:max-content}.pad button{padding:0}.pad [data-move=up]{grid-column:2}.pad [data-move=left]{grid-column:1;grid-row:2}.pad [data-move=down]{grid-column:2;grid-row:2}.pad [data-move=right]{grid-column:3;grid-row:2}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px}label{display:block;font-weight:600}input{display:block;width:100%;padding:12px;margin-top:6px;border:1px solid #bdcac4;border-radius:10px;background:white;color:var(--ink)}output{display:block;font-size:clamp(28px,5vw,48px);font-weight:750;overflow-wrap:anywhere}.source{font-size:14px;color:var(--muted);overflow-wrap:anywhere}.news-claim{font-size:clamp(20px,3vw,27px);line-height:1.4;margin:24px 0 8px}.article{max-width:65ch}.story p{max-width:65ch}footer{margin-top:36px;padding-top:16px;border-top:1px solid #dce2dd;font-size:13px;color:var(--muted)}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;
function posterSvg(p) {
  const shapes=p.shapes.map(s=>{
    const attributes=`fill="${esc(s.fill)}" stroke="${esc(s.stroke)}" stroke-width="${s.stroke_width}" transform="rotate(${s.rotation} ${s.x+s.width/2} ${s.y+s.height/2})"`;
    if(s.kind==='circle')return `<circle cx="${s.x+s.width/2}" cy="${s.y+s.height/2}" r="${Math.min(s.width,s.height)/2}" ${attributes}/>`;
    if(s.kind==='ellipse')return `<ellipse cx="${s.x+s.width/2}" cy="${s.y+s.height/2}" rx="${s.width/2}" ry="${s.height/2}" ${attributes}/>`;
    if(s.kind==='triangle')return `<polygon points="${s.x+s.width/2},${s.y} ${s.x+s.width},${s.y+s.height} ${s.x},${s.y+s.height}" ${attributes}/>`;
    if(s.kind==='line')return `<line x1="${s.x}" y1="${s.y}" x2="${s.x+s.width}" y2="${s.y+s.height}" ${attributes}/>`;
    return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="8" ${attributes}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="${esc(p.art_label)}"><title>${esc(p.title)}</title><desc>${esc(p.art_label)}</desc><rect width="800" height="500" fill="${esc(p.background)}"/>${shapes}</svg>`;
}
function songSvg(p) {
  const total=p.notes.reduce((sum,n)=>sum+n.duration_beats,0);let beat=0;
  const bars=p.notes.map(n=>{const x=20+beat/total*760;beat+=n.duration_beats;return n.rest?'':`<rect x="${x}" y="${180-(n.midi-36)/60*145}" width="${Math.max(2,n.duration_beats/total*760-2)}" height="9" rx="3" fill="#28786b"/>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" role="img" aria-label="Melody piano roll, pitch vertically and time horizontally"><rect width="800" height="220" rx="12" fill="#e5efe7"/><path d="M20 190H780" stroke="#bad0c3"/>${bars}<text x="20" y="210" font-family="system-ui" font-size="13" fill="#4c6556">${esc(p.tempo_bpm)} BPM · ${Math.round(total*60/p.tempo_bpm)} seconds · original instrumental</text></svg>`;
}
function songRuntime(p) {
  return `const piece=${json(p)};let audio=null,voices=[],finishTimer=null;const play=document.getElementById('play'),stop=document.getElementById('stop'),status=document.getElementById('status');
  function stopSong(){if(finishTimer!==null)clearTimeout(finishTimer);finishTimer=null;for(const voice of voices){try{voice.stop()}catch{}}voices=[];if(audio){audio.close().catch(()=>{});audio=null;}play.disabled=false;stop.disabled=true;status.textContent='Stopped. Play it again whenever you like.';}
  async function playSong(){stopSong();const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio){status.textContent='This browser does not support Web Audio.';return;}audio=new Audio();try{await audio.resume();const start=audio.currentTime+.08,secondsPerBeat=60/piece.tempo_bpm;let beat=0;const note=(midi,begin,duration,gain)=>{const osc=audio.createOscillator(),amp=audio.createGain();osc.type=piece.instrument;osc.frequency.setValueAtTime(440*2**((midi-69)/12),begin);amp.gain.setValueAtTime(0,begin);amp.gain.linearRampToValueAtTime(gain,begin+Math.min(.02,duration/4));amp.gain.setValueAtTime(gain,begin+duration*.65);amp.gain.linearRampToValueAtTime(0,begin+duration);osc.connect(amp);amp.connect(audio.destination);osc.start(begin);osc.stop(begin+duration+.01);voices.push(osc);};for(const n of piece.notes){if(!n.rest)note(n.midi,start+beat*secondsPerBeat,n.duration_beats*secondsPerBeat,.12);beat+=n.duration_beats;}for(const chord of piece.chords)for(const midi of chord.midis)note(midi,start+chord.start_beat*secondsPerBeat,chord.duration_beats*secondsPerBeat,.025);play.disabled=true;stop.disabled=false;status.textContent='Playing '+Math.round(beat*secondsPerBeat)+' seconds of original music.';finishTimer=setTimeout(()=>{stopSong();status.textContent='Finished. You can play the composition again.';},(beat*secondsPerBeat+.2)*1000);}catch{stopSong();status.textContent='Audio could not start. Try Play again.';}}
  play.onclick=playSong;stop.onclick=stopSong;window.addEventListener('pagehide',stopSong);`;
}
function gameRuntime(p) {
  const initial=initialGameState(p);
  return `let state=${json(initial)};const opening=${json(initial)};const step=${gameTransition.toString()};const board=document.getElementById('board'),status=document.getElementById('status');
  function paint(){board.replaceChildren();board.style.gridTemplateColumns='repeat('+state.width+',1fr)';for(let cell=0;cell<state.width*state.height;cell++){const tile=document.createElement('div');tile.className='cell';let name='path';if(state.walls.includes(cell)){tile.classList.add('wall');name='wall';}else if(cell===state.player){tile.classList.add('player');tile.textContent='●';name='you';}else if(state.gems.includes(cell)){tile.classList.add('gem');tile.textContent='◆';name='gem';}else if(cell===state.goal){tile.classList.add('goal');tile.textContent='⚑';name='goal';}tile.setAttribute('role','gridcell');tile.setAttribute('aria-label',name+' at row '+(Math.floor(cell/state.width)+1)+', column '+(cell%state.width+1));board.append(tile);}status.textContent=state.won?'You won! '+state.score+' gems in '+state.moves+' moves.':state.lost?'Out of moves. Restart to try another route.':'Gems '+state.score+'/'+state.total_gems+' · Moves '+state.moves+'/'+state.max_moves;}
  function move(direction){state=step(state,direction);paint();}
  for(const button of document.querySelectorAll('[data-move]'))button.onclick=()=>move(button.dataset.move);
  document.getElementById('restart').onclick=()=>{state=JSON.parse(JSON.stringify(opening));paint();};
  window.addEventListener('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey)return;const direction={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',w:'up',s:'down',a:'left',d:'right',W:'up',S:'down',A:'left',D:'right'}[event.key];if(direction){event.preventDefault();move(direction);}});paint();`;
}
function toolRuntime(p) {
  return `const piece=${json(p)};const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);const parseRepairSource=${parseRepairSource.toString()};const evaluateRepairSource=${evaluateRepairSource.toString()};const output=document.getElementById('result'),status=document.getElementById('status');
  function calculate(event){if(event)event.preventDefault();const values={};for(const field of piece.inputs){const input=document.getElementById('input-'+field.name),raw=input.value.trim(),value=Number(raw);if(!raw||!Number.isFinite(value)||value<field.min||value>field.max||(input.dataset.integer==='true'&&!Number.isSafeInteger(value))){output.textContent='';status.textContent='Enter a valid '+field.label+' between '+field.min+' and '+field.max+'.';return;}values[field.name]=value;}const answer=evaluateRepairSource(piece.source,values);if(!answer.ok){output.textContent='';status.textContent=answer.error;return;}output.textContent=answer.value.toLocaleString(undefined,{minimumFractionDigits:piece.decimals,maximumFractionDigits:piece.decimals});status.textContent='Calculated from your inputs.';}
  document.getElementById('calculator').onsubmit=calculate;for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>calculate());calculate();`;
}
/** Returns a complete, network-free piece; news has only ordinary external links. */
export function renderArtifact(type,payload) {
  const {errors}=canRenderArtifact(type,payload);if(errors.length)throw new RangeError(errors.join('; '));
  let body='',script='';
  const themeStyle=type==='game'?{grove:'--path:#dce8d3;--wall:#28433c;--goal:#dbb454;--gem:#c2e3df;--player:#fffdf7',orbit:'--path:#e5ddf1;--wall:#3c2b56;--goal:#efd084;--gem:#d3d7ff;--player:#ffffff',city:'--path:#e6e5e1;--wall:#3d4958;--goal:#f7c94f;--gem:#cae6ec;--player:#fffdf7'}[payload.theme]:'';
  if(type==='song'){body=`<section class="stage">${songSvg(payload)}</section><div class="controls"><button id="play" type="button">▶ Play song</button><button id="stop" class="secondary" type="button" disabled>Stop</button></div><p id="status" role="status" aria-live="polite">Press Play to hear the composition.</p><p class="hint">Sound starts only when you press Play. A melody and its chords are synthesized here in your browser.</p>`;script=songRuntime(payload);}
  else if(type==='game'){body=`<p class="hint">Collect every ◆, then reach ⚑. Move with arrow keys, WASD or the buttons.</p><section class="stage"><div id="board" class="gameboard" role="grid" aria-label="${esc(payload.title)} maze"></div></section><div class="pad"><button data-move="up" aria-label="Move up">↑</button><button data-move="left" aria-label="Move left">←</button><button data-move="down" aria-label="Move down">↓</button><button data-move="right" aria-label="Move right">→</button></div><div class="controls"><button id="restart" class="secondary">Restart</button><span id="status" role="status" aria-live="polite"></span></div>`;script=gameRuntime(payload);}
  else if(type==='poster')body=`<figure class="stage" style="background:${payload.background};color:${payload.ink}">${posterSvg(payload)}<figcaption>${esc(payload.caption)}</figcaption></figure><section class="story">${payload.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</section>`;
  else if(type==='news')body=`<article class="article"><p class="hint">Source reading brief · exact short extracts · ${esc(payload.topic)}</p>${payload.claims.map(c=>`<section><blockquote class="news-claim">${esc(c.text)}</blockquote><p class="source"><a href="${esc(safeHttps(c.source_url)?c.source_url:'#')}" target="_blank" rel="noopener noreferrer">${esc(c.source_title)}</a> · short source extract</p></section>`).join('')}<p class="hint">These passages were checked against saved source excerpts. The linked sources provide context and their own publication dates.</p></article>`;
  else {const definition=TOOL_CHORES[payload.chore];body=`<p>${esc(definition.description)}</p><form id="calculator"><section class="stage"><div class="fields">${payload.inputs.map(i=>{const integer=definition.integer[definition.names.indexOf(i.name)];return `<label for="input-${i.name}">${esc(i.label)}<input id="input-${i.name}" type="number" inputmode="decimal" value="${i.default}" min="${i.min}" max="${i.max}" step="${i.step}" data-integer="${integer}" required></label>`;}).join('')}</div></section><button type="submit">Calculate</button></form><section class="stage"><span>${esc(payload.result_label)}</span><output id="result" aria-live="polite"></output><p id="status" class="hint" role="status"></p></section><details><summary>How the calculation works</summary><code>${esc(payload.source)}</code><p class="hint">x, y and z refer to the labelled inputs above. Only bounded arithmetic is interpreted.</p></details>`;script=toolRuntime(payload);}
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(payload.title)} · The Night Shift</title><style>${css}</style></head><body${themeStyle?` style="${themeStyle}"`:''}><main><div class="kicker">The Night Shift · ${esc(type)}</div><h1>${esc(payload.title)}</h1><p class="summary">${esc(payload.summary)}</p>${body}<footer>An original small piece from The Night Shift. Draft and final use this same executable renderer.</footer></main>${script?`<script>${script}</script>`:''}</body></html>`;
}
export function artifactThumbnail(type,payload) {
  const {errors}=canRenderArtifact(type,payload);if(errors.length)throw new RangeError(errors.join('; '));
  if(type==='poster')return posterSvg(payload);
  if(type==='song')return songSvg(payload);
  const symbol={game:'◆ → ⚑',news:'Read the sources',tool:'Try the calculator'}[type] || type;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="${esc(payload.title)}"><rect width="800" height="500" rx="24" fill="#e5efe7"/><text x="48" y="120" font-size="25" font-family="system-ui" fill="#28786b">THE NIGHT SHIFT · ${esc(type.toUpperCase())}</text><text x="48" y="270" font-size="42" font-family="system-ui" fill="#18273b">${esc(symbol)}</text><text x="48" y="400" font-size="22" font-family="system-ui" fill="#18273b">${esc(payload.title.slice(0,48))}</text></svg>`;
}
