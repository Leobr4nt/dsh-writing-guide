/**
 * ST 正则的独立兼容实现（只复现行为，不复制 SillyTavern 代码）。
 *
 * 参考：SillyTavern@06bde939fb1e9c4c8d8641d810f0a916b5bce127
 *       public/scripts/extensions/regex/engine.js + public/scripts/utils.js(regexFromString)
 *
 * 与源码对齐的要点：
 *   - `/pat/flags` 的 flags 原样使用，**不擅自补 g**（无 g 只替换第一处）
 *   - substituteRegex=2 只转义**宏的值**（{{char}}/{{user}} 的替换结果），不是整个正则
 *   - 零长度匹配不跳过：`^` 这类空插入要生效（用 lastIndex 推进避免死循环）
 *   - minDepth/maxDepth 为 null/undefined 时视为「不限制」（不是 0）
 *   - 命名捕获、`$1`、`$<name>`、`{{match}}` 都参与 trimStrings；替换体里的 char/user 宏会展开
 *   - 一批消息/多条规则共用一个 worker，deadline 是**整批**总量
 */
import { Worker } from 'node:worker_threads';
import { replaceNameMacros } from './name-macros.js';

export const PLACEMENT = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const SUBSTITUTE = { NONE: 0, RAW: 1, ESCAPED: 2 };

export const LIMITS = { maxInputChars: 1_000_000, maxOutputChars: 2_000_000, deadlineMs: 1500 };

export function escapeRegexMetachars(text) {
  return String(text ?? '').replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (char) => {
    switch (char) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\v': return '\\v';
      case '\f': return '\\f';
      case '\0': return '\\0';
      default: return `\\${char}`;
    }
  });
}

/** 解析 "/pattern/flags"：flags 原样保留，不补 g（对齐 utils.regexFromString）。 */
export function parseRegexString(input) {
  const source = String(input ?? '').trim();
  const match = /^\/([\s\S]*)\/([a-z]*)$/.exec(source);
  if (match) return { pattern: match[1], flags: match[2] };
  return { pattern: source, flags: '' };
}

export function isScriptActive(script) {
  return Boolean(script) && script.disabled !== true && typeof script.findRegex === 'string' && script.findRegex.length > 0;
}

const depthOf = (value) => (value === null || value === undefined || value === '' ? null : Number(value));

export function shouldRun(script, scene = {}) {
  if (!isScriptActive(script)) return false;
  const placement = Number(scene.placement);
  if (!Number.isFinite(placement)) return false;
  const markdownOnly = script.markdownOnly === true;
  const promptOnly = script.promptOnly === true;
  const isMarkdown = scene.isMarkdown === true;
  const isPrompt = scene.isPrompt === true;
  const matchesKind = (markdownOnly && isMarkdown)
    || (promptOnly && isPrompt)
    || (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt);
  if (!matchesKind) return false;
  if (scene.isEdit === true && script.runOnEdit !== true) return false;

  if (typeof scene.depth === 'number' && Number.isFinite(scene.depth)) {
    const min = depthOf(script.minDepth);
    const max = depthOf(script.maxDepth);
    if (min !== null && !Number.isNaN(min) && min >= -1 && scene.depth < min) return false;
    if (max !== null && !Number.isNaN(max) && max >= 0 && scene.depth > max) return false;
  }
  const list = Array.isArray(script.placement) ? script.placement.map(Number) : [];
  return list.includes(placement);
}

/** trimStrings 先做宏展开（{{char}}/{{user}}），再用于所有 trim。 */
export function expandTrimStrings(trimStrings, { char = '', user = '' } = {}) {
  return (Array.isArray(trimStrings) ? trimStrings : [])
    .map((raw) => replaceNameMacros(raw, {char,user}))
    .filter((needle) => needle.length > 0);
}

export function trimMatch(match, trimStrings) {
  let out = String(match ?? '');
  for (const raw of Array.isArray(trimStrings) ? trimStrings : []) {
    const needle = String(raw ?? '');
    if (!needle) continue;
    out = out.split(needle).join('');
  }
  return out;
}

/** 替换体：{{match}} → $0；$n / $<name>；trim；再展开 char/user 宏。 */
export function expandReplacement(template, matchText, groups, { char = '', user = '', trimStrings = [] } = {}) {
  const base = String(template ?? '').replace(/{{match}}/gi, '$0');
  const filled = base.replace(/\$(\d+)|\$<([^>]+)>/g, (_whole, num, name) => {
    if (num) {
      const index = Number(num);
      const value = index === 0 ? matchText : groups?.[index - 1];
      return value === undefined ? '' : trimMatch(value, trimStrings);
    }
    const named = groups?.named?.[String(name ?? '')];
    return named === undefined ? '' : trimMatch(named, trimStrings);
  });
  return replaceNameMacros(filled, {char,user});
}

/** 单个脚本（同步；worker 内部使用）。 */
export function runScriptSync(script, input, { char = '', user = '', limits = LIMITS } = {}) {
  if (!isScriptActive(script)) return { ok: true, output: input };
  const text = String(input ?? '');
  if (!text) return { ok: true, output: text };
  if (text.length > limits.maxInputChars) return { ok: false, code: 'input-too-large', message: '输入超过上限' };

  const substitute = Number(script.substituteRegex ?? 0);
  let pattern = String(script.findRegex);
  if (substitute === SUBSTITUTE.RAW) {
    pattern = replaceNameMacros(pattern, {char,user});
  } else if (substitute === SUBSTITUTE.ESCAPED) {
    // 只转义宏的值，不是整个正则
    pattern = replaceNameMacros(pattern, {char:escapeRegexMetachars(char),user:escapeRegexMetachars(user)});
  }

  const parsed = parseRegexString(pattern);
  let regex;
  try {
    regex = new RegExp(parsed.pattern, parsed.flags);
  } catch (error) {
    return { ok: false, code: 'bad-regex', message: String(error?.message ?? '正则无法编译') };
  }

  const global = parsed.flags.includes('g');
  // trimStrings 先宏展开，后面完整匹配/编号捕获/命名捕获都用这一份，避免二次 trim
  const trimStrings = expandTrimStrings(script.trimStrings ?? [], { char, user });
  const maxOutput = limits.maxOutputChars;
  const started = Date.now();
  let out = '';
  let lastIndex = 0;
  let count = 0;
  let match;
  for (;;) {
    match = regex.exec(text);
    if (!match) break;
    if (Date.now() - started > limits.deadlineMs) return { ok: false, code: 'timeout', message: '正则执行超时' };
    const groups = match.slice(1);
    groups.named = match.groups ?? {};
    const replaced = expandReplacement(script.replaceString ?? '', match[0], groups, { char, user, trimStrings });
    out += text.slice(lastIndex, match.index) + replaced;
    lastIndex = match.index + match[0].length;
    count += 1;
    if (out.length > maxOutput) return { ok: false, code: 'output-too-large', message: '输出超过上限' };
    if (count > 100_000) return { ok: false, code: 'too-many-matches', message: '匹配次数超过上限' };
    if (!global) break;
    if (match[0] === '') {
      // 零长度匹配：不跳过；按 code point 推进，避免落在代理对中间而死循环
      if (regex.lastIndex <= match.index) {
        const code = text.codePointAt(match.index);
        const step = (regex.unicode || regex.unicodeSets) && code !== undefined && code > 0xffff ? 2 : 1;
        regex.lastIndex = match.index + step;
      }
      if (regex.lastIndex > text.length) break;
    }
  }
  out += text.slice(lastIndex);
  if (out.length > maxOutput) return { ok: false, code: 'output-too-large', message: '输出超过上限' };
  return { ok: true, output: out };
}

/**
 * 一批（多条消息 × 多条规则）共用一个 worker；deadline 是整批总量。
 * 应跳过的规则不会进 worker。
 */
export function runBatchSafe({ scripts, inputs, scene = {}, limits = LIMITS, signal }) {
  if(signal?.aborted)return Promise.resolve({ok:false,code:'aborted',message:'正则已取消'});
  if((inputs?.length??0)>1000 || (inputs??[]).reduce((n,x)=>n+String(x.text??'').length,0)>2_000_000)return Promise.resolve({ok:false,code:'input-too-large',message:'正则批次超过上限'});
  const jobs = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const chain = (Array.isArray(scripts) ? scripts : []).filter((script) => shouldRun(script, { ...scene, ...(input.scene ?? {}) }));
    if (!chain.length) { jobs.push({ index: input.index, text: input.text, applied: [] }); continue; }
    jobs.push({ index: input.index, text: input.text, chain });
  }
  const work = jobs.filter((job) => job.chain && job.chain.length);
  if (!work.length) return Promise.resolve({ ok: true, results: jobs.map((job) => ({ index: job.index, output: job.text, applied: [] })) });

  return new Promise((resolve) => {
    let worker;
    let settled = false; let timer;
    const abort=()=>finish({ok:false,code:'aborted',message:'正则已取消'});
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);signal?.removeEventListener('abort',abort);
      try { worker?.terminate(); } catch { /* ignore */ }
      resolve(value);
    };
    try {
      worker = new Worker(new URL('./regex-worker.js', import.meta.url), {
        execArgv: [], resourceLimits:{maxOldGenerationSizeMb:64},
        workerData: { jobs, limits, char: scene.char ?? '', user: scene.user ?? '' },
      });
    } catch (error) {
      resolve({ ok: false, code: 'worker-unavailable', message: String(error?.message ?? error) });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, code: 'timeout', message: '正则执行超时（整批已终止）' }), limits.deadlineMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    worker.once('exit',()=>{if(!settled)finish({ok:false,code:'worker-exit',message:'正则执行中断'});});
    worker.once('message', (message) => { clearTimeout(timer); finish(message); });
    worker.once('error', (error) => { clearTimeout(timer); finish({ ok: false, code: 'worker-error', message: String(error?.message ?? error) }); });
  });
}

/** 兼容单条调用（内部走批量）。 */
export async function applyScriptsSafe(scripts, input, scene = {}) {
  const batch = await runBatchSafe({ scripts, inputs: [{ index: 0, text: String(input ?? ''), scene }], scene, signal:scene.signal });
  if (!batch.ok) { const bad=batch.results?.find(x=>!x.ok);return {ok:false,code:batch.code??bad?.code,message:batch.message??bad?.message,output:String(input??'')}; }
  const row = batch.results[0];
  return { ok: true, output: row.output, applied: row.applied };
}

/** 同步版（预览/测试）。 */
export function applyScripts(scripts, input, scene = {}) {
  let out = String(input ?? '');
  const applied = [];
  for (const script of Array.isArray(scripts) ? scripts : []) {
    if (!shouldRun(script, scene)) continue;
    const result = runScriptSync(script, out, scene);
    if (!result.ok) return { ok: false, code: result.code, message: result.message, output: out, applied };
    out = result.output;
    applied.push(script.scriptName ?? script.id ?? 'script');
  }
  return { ok: true, output: out, applied };
}
