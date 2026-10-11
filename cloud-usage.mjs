import { spawn } from 'node:child_process';

// Trusted CLI-event parser adapted from the read-only While You Sleep pattern.
// Rates verified 2026-10-11: https://developers.openai.com/api/docs/pricing
export const TOKEN_RATES = Object.freeze({
  'gpt-6-luna': Object.freeze({
    inputUsdPerMillion: 0.10, cachedInputUsdPerMillion: 0.01,
    cacheWriteInputUsdPerMillion: 0.125, outputUsdPerMillion: 0.50,
    source: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    verifiedAt: '2026-10-11', tier: 'standard_short_context', currency: 'USD',
  }),
});
const MAX_LOG_BYTES = 24 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_TOKENS = 1_000_000_000;
const nullCounts = () => ({inputTokens:null,cachedInputTokens:null,cacheWriteInputTokens:null,outputTokens:null,reasoningOutputTokens:null,costUsd:null});
const validTokens = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS;
const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value) ? value : null;
const cleanLine = line => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '').trim();

function commandModel(line) {
  if (!line.startsWith('Running: ')) return null;
  // codex-action prints each argument with JSON.stringify. Never search inside
  // a JSON event or tool output for this marker.
  const quoted = line.match(/"(?:\\.|[^"\\])*"/g) || [];
  let args;
  try { args = quoted.map(value => JSON.parse(value)); } catch { return null; }
  const execIndex = args.indexOf('exec');
  if (execIndex < 0 || !args.includes('--json') || !args.includes('--skip-git-repo-check')) return null;
  const codexBeforeExec = execIndex > 0 && /(?:^|\/)codex$/.test(args[execIndex - 1]);
  const directCodex = execIndex === 0 && /^Running: (?:CODEX_HOME=\S+ )?\S*\bcodex\s/.test(line);
  if (!codexBeforeExec && !directCodex) return null;
  const index = args.indexOf('--model', execIndex);
  return {model: index >= 0 ? modelName(args[index + 1]) : null};
}

export function estimateTokenCost(usage, model) {
  const rates = TOKEN_RATES[model];
  if (!rates || !validTokens(usage.inputTokens) || !validTokens(usage.cachedInputTokens) || !validTokens(usage.outputTokens)) return null;
  const writes = usage.cacheWriteInputTokens ?? 0;
  if (!validTokens(writes) || usage.cachedInputTokens + writes > usage.inputTokens) return null;
  return ((usage.inputTokens - usage.cachedInputTokens - writes) * rates.inputUsdPerMillion
    + usage.cachedInputTokens * rates.cachedInputUsdPerMillion
    + writes * rates.cacheWriteInputUsdPerMillion
    + usage.outputTokens * rates.outputUsdPerMillion) / 1_000_000;
}

function eventUsage(event) {
  if (!event || event.type !== 'turn.completed' || !event.usage || Array.isArray(event.usage)) return null;
  if (Object.keys(event).some(key => !['type', 'usage'].includes(key))) return null;
  const raw = event.usage;
  if (![raw.input_tokens, raw.cached_input_tokens, raw.output_tokens].every(validTokens)) return null;
  const writes = raw.cache_write_input_tokens;
  const reasoning = raw.reasoning_output_tokens;
  if ((writes !== undefined && !validTokens(writes)) || (reasoning !== undefined && !validTokens(reasoning))) return null;
  if (raw.cached_input_tokens + (writes ?? 0) > raw.input_tokens || (reasoning ?? 0) > raw.output_tokens) return null;
  return {inputTokens:raw.input_tokens,cachedInputTokens:raw.cached_input_tokens,cacheWriteInputTokens:writes ?? null,outputTokens:raw.output_tokens,reasoningOutputTokens:reasoning ?? null};
}

/** Read only actual JSONL CLI events, never recursively search item/tool text. */
export function parseCodexUsage(log, {model:configuredModel} = {}) {
  const unknown = reason => ({status:'unknown',reason,model:modelName(configuredModel),...nullCounts()});
  if (typeof log !== 'string' || Buffer.byteLength(log) > MAX_LOG_BYTES) return unknown('log_unavailable_or_oversized');
  let invocation = null, threadStarted = false, turnStarted = false, ended = false, observed = null;
  let invocationCount = 0, invalid = false, failed = false;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    const command = commandModel(line);
    if (command) {
      invocationCount++;
      if (invocationCount !== 1) invalid = true;
      invocation = command;
      continue;
    }
    if (!invocation || ended || !line.startsWith('{') || Buffer.byteLength(line) > MAX_EVENT_BYTES) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || Array.isArray(event) || typeof event !== 'object') continue;
    if (event.type === 'thread.started') {
      if (threadStarted || turnStarted || typeof event.thread_id !== 'string' || !event.thread_id) invalid = true;
      threadStarted = true;
    } else if (event.type === 'turn.started') {
      if (!threadStarted || turnStarted) invalid = true;
      turnStarted = true;
    } else if (event.type === 'turn.completed') {
      if (!threadStarted || !turnStarted) invalid = true;
      observed = eventUsage(event);
      if (!observed) invalid = true;
      ended = true;
    } else if (event.type === 'turn.failed') {
      failed = true;
      ended = true;
    }
  }
  if (invocationCount !== 1 || invalid || failed || !ended || !observed) return unknown(failed ? 'codex_turn_failed' : invalid ? 'invalid_cli_usage_event' : 'completed_cli_usage_not_found');
  const model = invocation.model || modelName(configuredModel);
  return {
    status:'observed',reason:null,model,...observed,costUsd:estimateTokenCost(observed,model),
    cacheWriteAccounting:observed.cacheWriteInputTokens === null ? 'not_reported_by_cli' : 'reported_by_cli',
    pricingStatus:!TOKEN_RATES[model] ? 'model_rates_unknown' : observed.cacheWriteInputTokens === null ? 'reported_categories_standard_estimate' : 'standard_token_estimate',
  };
}

/** GitHub CLI follows the authenticated job-log redirect. Keep output in RAM. */
export function githubApiGet(endpoint, {maxBytes = MAX_LOG_BYTES, timeoutMs = 30_000, env = process.env} = {}) {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/(?:runs\/\d+|runs\/\d+\/attempts\/\d+\/jobs\?per_page=100&page=\d+|jobs\/\d+\/logs)$/.test(endpoint)) throw new Error('Unsupported usage API endpoint.');
  return new Promise((resolve,reject) => {
    const childEnv = {...env,GH_PROMPT_DISABLED:'1'};
    delete childEnv.GH_DEBUG;
    // GitHub job logs contain ANSI formatting. Recent gh versions otherwise
    // reject them even when stdout is a pipe. This flag is confined to the
    // bounded RAM-only log reader; the raw response is never displayed.
    const args=['api','--hostname','github.com','--method','GET'];
    if (/\/actions\/jobs\/\d+\/logs$/.test(endpoint)) args.push('--allow-escape-sequences');
    const child = spawn('gh',[...args,endpoint],{env:childEnv,stdio:['ignore','pipe','pipe']});
    let size = 0, chunks = [], finished = false;
    const finish = (error,value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chunks = [];
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {child.kill('SIGKILL');finish(new Error('Usage API request timed out.'));},timeoutMs);
    child.stdout.on('data',chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {child.kill('SIGKILL');finish(new Error('Usage API response exceeded size limit.'));}
      else chunks.push(chunk);
    });
    // Never echo GitHub error bodies, signed log URLs, or inherited credentials.
    child.stderr.on('data',() => {});
    child.on('error',() => finish(new Error('Usage API request unavailable.')));
    child.on('close',code => code === 0 ? finish(null,Buffer.concat(chunks).toString('utf8')) : finish(new Error('Usage API request unavailable.')));
  });
}

