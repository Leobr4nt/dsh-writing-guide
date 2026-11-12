// This function is serialized into QuickJS. It must not close over host objects.
// Independently implemented subset of the linked projects' public API contracts.
export function createGuestApi(input) {
  const clone = value => JSON.parse(JSON.stringify(value));
  let local = clone(input.variables ?? {});
  let message = clone(input.messageVariables ?? {});
  let script = clone(input.scriptVariables ?? {});
  const global = clone(input.globalVariables ?? {});
  let cache = clone({ ...global, ...local, ...message });
  const ctx = input.context ?? {};
  const logs = [];
  let seed = 2166136261;
  for (const char of String(input.seed ?? input.scriptId ?? '')) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const keys = path => {
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    if (parts.some(k => !k || ['__proto__', 'constructor', 'prototype'].includes(k))) throw Error('不允许的变量路径');
    return parts;
  };
  const get = (obj, path, fallback) => {
    if (path == null) return obj;
    let value = obj;
    for (const k of keys(path)) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, k)) return fallback;
      value = value[k];
    }
    return value === undefined ? fallback : value;
  };
  const put = (obj, path, value) => {
    const parts = keys(path); let cur = obj;
    for (const k of parts.slice(0, -1)) {
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[parts.at(-1)] = value;
    return value;
  };
  const templateOptions = value => {
    const opts = typeof value === 'string' ? { scope: value } : (value ?? {});
    for (const key of Object.keys(opts)) if (!['scope','defaults','flags','results'].includes(key)) throw Error(`模板选项 ${key} 尚未支持`);
    return opts;
  };
  const table = scope => {
    if (scope === 'local') return local;
    if (scope === 'message') return message;
    if (scope === 'cache') return cache;
    throw Error(`变量作用域 ${scope} 尚未支持`);
  };
  const helperTable = options => {
    const type = options?.type ?? 'chat';
    if (type === 'chat') return local;
    if (type === 'script' && (!options.script_id || options.script_id === input.scriptId)) return script;
    throw Error(`酒馆助手变量作用域 ${type} 尚未支持（首批支持 chat/script）`);
  };
  const assertObject = obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error('变量表必须是对象');
    return clone(obj);
  };
  const deepMerge = (target, source, onlyMissing = false) => {
    for (const [key, value] of Object.entries(assertObject(source))) {
      keys(key);
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') deepMerge(target[key], value, onlyMissing);
      else if (!onlyMissing || !Object.prototype.hasOwnProperty.call(target,key)) target[key] = value;
    }
    return clone(target);
  };
  const api = {
    char: String(ctx.char ?? ''), user: String(ctx.user ?? '用户'), model: String(ctx.model ?? ''),
    userName: String(ctx.user ?? '用户'), charName: String(ctx.char ?? ''), assistantName: String(ctx.char ?? ''),
    get variables() { return cache; },
    getvar(path, value) { const opts = templateOptions(value); return get(table(opts.scope ?? 'cache'), path, opts.defaults); },
    setvar(path, value, options) {
      const opts = templateOptions(options); const dest = table(opts.scope ?? 'message');
      const exists = get(dest, path, undefined) !== undefined;
      if (!['n','nx','xx',undefined].includes(opts.flags)) throw Error('该变量 flags 尚未支持');
      if ((opts.flags === 'nx' && exists) || (opts.flags === 'xx' && !exists)) return undefined;
      if (!['old','new',undefined].includes(opts.results)) throw Error('该变量 results 尚未支持');
      const old = get(dest,path,undefined);
      if (path == null) throw Error('整表替换请使用酒馆助手 replaceVariables');
      put(dest,path,value); put(cache,path,value);
      return opts.results === 'old' ? old : value;
    },
    getVariables(options) { return clone(helperTable(options)); },
    replaceVariables(value, options) {
      const dest = helperTable(options); const next = assertObject(value);
      for (const key of Object.keys(dest)) delete dest[key];
      deepMerge(dest,next); cache = clone({ ...global, ...local, ...message });
    },
    insertOrAssignVariables(value, options) { const result = deepMerge(helperTable(options),value); cache = clone({...global,...local,...message}); return result; },
    insertVariables(value, options) { const result = deepMerge(helperTable(options),value,true); cache = clone({...global,...local,...message}); return result; },
    updateVariablesWith(fn, options) { const next = fn(api.getVariables(options)); if (next?.then) return next.then(v => { api.replaceVariables(v,options); return api.getVariables(options); }); api.replaceVariables(next,options); return api.getVariables(options); },
    getScriptId() { return input.scriptId ?? ''; },
    getLastMessageId() { return (ctx.chatMessages ?? []).length - 1; },
    getChatMessages(range, options = {}) {
      if (options.include_swipes || (options.hide_state && options.hide_state !== 'all')) throw Error('消息页/隐藏状态过滤尚未支持');
      const rows = ctx.chatMessages ?? [];
      const text = String(range).replace('{{lastMessageId}}',String(rows.length - 1));
      const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(text);
      if (!m) throw Error('不支持的消息范围');
      const index = s => Number(s) < 0 ? rows.length + Number(s) : Number(s);
      const start = index(m[1]), end = index(m[2] ?? m[1]);
      return rows.map((row,i) => ({ message_id:i, role:row.role, name:row.role==='user'?api.user:api.char, message:String(row.content ?? ''), is_hidden:false, data:{}, extra:{} }))
        .filter(row => row.message_id >= start && row.message_id <= end && (!options.role || options.role === 'all' || row.role === options.role));
    },
    console: { log(...args) { if (logs.length < 30) logs.push(args.map(String).join(' ').slice(0,1000)); } },
    snapshot(extra) { return { ...extra, variables:local, messageVariables:message, scriptVariables:script, logs }; },
  };
  if (input.kind === 'template') {
    // Capture the seeded Math.random above for lodash random/sample during rebuilds.
    api._=globalThis._.runInContext({Math});
    Object.assign(api,globalThis.__templateReaders({lodash:api._,cache:()=>cache,local:()=>local,global:()=>global,refresh:()=>{cache=clone({...global,...local,...message});}}));
    // These aliases use the same transactional setters; unsupported options still fail.
    api.setLocalVar=(key,value,options={})=>api.setvar(key,value,{...options,scope:'local'});
    api.setMessageVar=(key,value,options={})=>api.setvar(key,value,{...options,scope:'message'});
  }
  return api;
}
