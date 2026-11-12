/** ST-Prompt-Template ejs.ts aliases and variables.ts getter contract.
 * Serialized into both isolated runtimes; dependencies are explicit guest values.
 */
export function createTemplateReaders({ lodash, cache, local, global, refresh }) {
  const options = value => {
    if (typeof value === 'string') {
      if (['local','global','message','cache','initial'].includes(value)) return {scope:value};
      if (['n','nx','xx','nxs','xxs'].includes(value)) return {flags:value};
      if (['old','new','fullcache'].includes(value)) return {results:value};
    }
    if (typeof value === 'boolean') return {dryRun:value};
    return value ?? {};
  };
  const get = (table, key, fallback) => {
    if (key == null) return table;
    if (lodash.toPath(key).some(part=>['__proto__','constructor','prototype'].includes(part))) throw Error('不允许的变量路径');
    return lodash.get(table,key,fallback);
  };
  const getvar = (key, value) => {
    const opts=options(value);
    for (const field of Object.keys(opts)) if (!['scope','defaults','clone','index','noCache','withMsg','flags','results','dryRun'].includes(field)) throw Error('模板读取选项尚未支持');
    // This adapter has one committed message snapshot, not ST swipe history.
    if (opts.withMsg != null) throw Error('模板 withMsg 消息筛选尚未支持');
    if (opts.noCache) refresh?.();
    let table;
    switch (opts.scope ?? 'cache') {
      case 'message': // Without withMsg the upstream reads STATE.cacheVars.
      case 'cache': table=cache();break;
      case 'local': table=local();break;
      case 'global': table=global();break;
      default: throw Error('模板读取变量作用域尚未支持');
    }
    if (opts.index != null) {
      const indexed=JSON.parse(get(table,key,'{}')||'{}');
      const index=Number(opts.index);
      return get(indexed,Number.isNaN(index)?opts.index:index,opts.defaults);
    }
    const result=get(table,key,opts.defaults);
    return opts.clone?lodash.cloneDeep(result):result;
  };
  return {
    getvar,
    getLocalVar:(key,value={})=>getvar(key,{...value,scope:'local'}),
    getGlobalVar:(key,value={})=>getvar(key,{...value,scope:'global'}),
    getMessageVar:(key,value={})=>getvar(key,{...value,scope:'message'}),
  };
}
