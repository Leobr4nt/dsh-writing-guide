/** Serializable event broker. ST emit awaits sequentially; emitAndWait does not. */
export function createTavernEvents(onError = () => {}) {
  const events=new Map();
  const remove=(name,fn)=>{const list=events.get(name)??[];const i=list.findIndex(x=>x.fn===fn);if(i>=0)list.splice(i,1);};
  const add=(name,fn,{once=false,first=false,last=false}={})=>{
    if(typeof name!=='string'||typeof fn!=='function')throw Error('EVENT_ARGUMENT');
    const list=events.get(name)??[];events.set(name,list);
    if(first||last)remove(name,fn);
    const entry={fn,once};first?list.unshift(entry):list.push(entry);
    return {stop:()=>remove(name,fn)};
  };
  const invoke=(name,item,args)=>{if(item.once)remove(name,item.fn);return item.fn(...args);};
  return {
    eventOn:(name,fn)=>add(name,fn),eventOnce:(name,fn)=>add(name,fn,{once:true}),
    eventMakeFirst:(name,fn)=>add(name,fn,{first:true}),eventMakeLast:(name,fn)=>add(name,fn,{last:true}),
    eventRemoveListener:remove,
    eventClearEvent:name=>events.delete(name),
    eventClearListener:fn=>{for(const name of events.keys())while((events.get(name)??[]).some(x=>x.fn===fn))remove(name,fn);},
    eventClearAll:()=>events.clear(),
    async eventEmit(name,...args){for(const item of [...(events.get(name)??[])]){try{await invoke(name,item,args);}catch(error){onError(error);}}},
    eventEmitAndWait(name,...args){for(const item of [...(events.get(name)??[])]){try{const value=invoke(name,item,args);if(value?.catch)value.catch(onError);}catch(error){onError(error);}}},
    listenerCount:()=>[...events.values()].reduce((n,list)=>n+list.length,0),
  };
}
