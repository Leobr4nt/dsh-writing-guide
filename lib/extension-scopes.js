import {randomUUID} from 'node:crypto';

// Contracts: ST regex engine/saveScriptsByType; Tavern Helper settings + script stores.
// Data remains in its owner. This adapter uses stable DSH material IDs for allow lists.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const error=(message,status=400)=>Object.assign(new Error(message),{status,code:'bad-shape'});
const queues=new WeakMap();
const clone=v=>structuredClone(v);
function array(v,label){if(v===undefined)return [];if(!Array.isArray(v))throw error(label+' 必须是数组');return v;}
export function helperSettings(ext={}){
  if(ext.tavern_helper!==undefined){
    const value=Array.isArray(ext.tavern_helper)?Object.fromEntries(ext.tavern_helper):ext.tavern_helper;
    if(!object(value))throw error('tavern_helper 必须是对象或键值对数组');
    return clone(value);
  }
  const old=ext.TavernHelper_scripts;
  if(old===undefined)return {scripts:[],variables:{}};
  const convertScript=(v,fallback)=>({...v,type:'script',id:String(v.id??fallback),enabled:v.enabled===true,name:String(v.name??''),content:String(v.content??''),button:v.button??{enabled:true,buttons:v.buttons??[]},data:v.data??{},export_with:v.export_with??{data:true,button:true}});
  const scripts=array(old,'TavernHelper_scripts').map((node,i)=>{
    if(!object(node))throw error('旧脚本条目无效');
    if(node.type==='folder')return {...node,type:'folder',id:String(node.id??'legacy-folder-'+i),enabled:true,scripts:array(node.value,'旧文件夹 value').map((s,j)=>convertScript(s,'legacy-'+i+'-'+j))};
    return convertScript(node.value??node,'legacy-'+i);
  });
  return {scripts,variables:clone(ext.TavernHelper_characterScriptVariables??{})};
}
export function assertItems(items,kind){
  if(!['regex','helper'].includes(kind))throw error('扩展类型无效');
  array(items,kind);if(!Array.isArray(items)||items.length>500)throw error('扩展列表无效或过长');
  const ids=new Set();let count=0;
  function walk(nodes,depth=0){if(depth>8)throw error('目录嵌套过深');for(const node of nodes){
    if(!object(node)||++count>1000)throw error('扩展条目无效或过多');
    if(node.id!=null){if(typeof node.id!=='string')throw error('id 必须是文本');if(ids.has(node.id))throw error('同一来源内 id 重复');ids.add(node.id);}
    if(kind==='regex'){
      if(typeof node.findRegex!=='string'||typeof node.replaceString!=='string'||!Array.isArray(node.placement))throw error('正则需要 findRegex、replaceString 与 placement');
      if(node.disabled!==undefined&&typeof node.disabled!=='boolean')throw error('disabled 必须为布尔值');
    }else{
      if(node.enabled!==undefined&&typeof node.enabled!=='boolean')throw error('enabled 必须为布尔值');
      if(node.type==='folder')walk(array(node.scripts,'文件夹 scripts'),depth+1);
      else if((node.type===undefined||node.type==='script')&&typeof node.content==='string'){}else throw error('助手需要 script.content 或 folder.scripts');
    }
  }}walk(items);return items;
}
function normalized(items,kind){
  assertItems(items,kind);
  const walk=(nodes,path=[])=>nodes.map((node,i)=>{
    const p=[...path,i],copy={...clone(node),id:node.id||'embedded-'+p.join('-')};
    if(kind==='helper'){copy.type=node.type??'script';copy.enabled=node.enabled===true;if(copy.type==='folder')copy.scripts=walk(node.scripts??[],p);}
    return copy;
  });return walk(items);
}
export function flattenEnabled(trees,{basePath=[],requireEnabled=true}={}){
  const result=[];
  function walk(nodes,path){nodes.forEach((item,i)=>{
    const here=[...path,i];if(requireEnabled&&item.enabled!==true)return;
    if(item.type==='folder')walk(item.scripts??[],here);else result.push({item,path:here});
  });}walk(trees,basePath);return result;
}
export class ExtensionScopes {
  constructor({store,extensionStore}){this.store=store;this.extensionStore=extensionStore;}
  transaction(fn){const previous=queues.get(this.store)??Promise.resolve();const next=previous.then(fn,fn);queues.set(this.store,next.catch(()=>{}));return next;}
  async source({type,id},state){
    if(type==='global'){
      if(id!=='global')throw error('全局来源 id 必须为 global');
      state??=await this.extensionStore.load();
      return {type,id,name:'全局',regex:normalized(state.regex?.global??state.global??[],'regex'),scripts:normalized(state.helper?.scripts??[],'helper')};
    }
    if(!['preset','character'].includes(type)||!id)throw error('来源无效');
    const entity=type==='preset'?await this.store.getPreset(id):await this.store.getCard(id);
    if(!entity)throw error('所属素材已不存在：'+id,404);
    const ext=entity.extensions??entity.data?.extensions??{};
    const helper=helperSettings(ext);
    return {type,id,name:entity.name??entity.data?.name??id,regex:normalized(ext.regex_scripts??[],'regex'),scripts:normalized(helper.scripts??[],'helper')};
  }
  async list({presetId='',cardId=''}={}){
    const state=await this.extensionStore.load(),out=[];const requests=[{type:'global',id:'global'}];
    if(presetId)requests.push({type:'preset',id:String(presetId)});if(cardId)requests.push({type:'character',id:String(cardId)});
    for(const req of requests){let source;try{source=await this.source(req,state);}catch(e){if(e.status===404)continue;throw e;}
      const bucket=req.type==='preset'?'presets':'characters';
      out.push({...source,regexAllowed:req.type==='global'||(state.allowed?.regex?.[bucket]??[]).includes(req.id),helperAllowed:req.type==='global'?state.helper?.enabled!==false:(state.allowed?.helper?.[bucket]??[]).includes(req.id)});
    }return out;
  }
  async setAllowed({type,id,kind,enabled}){
    if(!['regex','helper'].includes(kind))throw error('扩展类型无效');await this.source({type,id});
    if(type==='global'){
      if(kind!=='helper')throw error('全局正则没有来源允许列表');
      await this.extensionStore.update(s=>({...s,helper:{...s.helper,enabled:enabled===true}}));return {ok:true};
    }
    const bucket=type==='preset'?'presets':'characters';
    await this.extensionStore.update(s=>{const a=clone(s.allowed??{});a[kind]??={};const values=new Set(a[kind][bucket]??[]);enabled?values.add(id):values.delete(id);a[kind][bucket]=[...values];return {...s,allowed:a};});return {ok:true};
  }
  async _write({type,id,kind,items}){
    items=normalized(items,kind);
    if(type==='global'){
      if(id!=='global')throw error('全局来源无效');
      await this.extensionStore.update(s=>({...s,[kind==='regex'?'regex':'helper']:kind==='regex'?{...s.regex,global:items}:{...s.helper,scripts:items}}));
    }else{
      if(!['preset','character'].includes(type))throw error('来源无效');
      const entity=type==='preset'?await this.store.getPreset(id):await this.store.getCard(id);if(!entity)throw error('所属素材不存在',404);
      const extensions=clone(entity.extensions??entity.data?.extensions??{});
      if(kind==='regex')extensions.regex_scripts=items;
      else {extensions.tavern_helper={...helperSettings(extensions),scripts:items};delete extensions.TavernHelper_scripts;delete extensions.TavernHelper_characterScriptVariables;}
      if(type==='preset')await this.store.savePreset({...entity,extensions});else await this.store.saveCard({...entity,extensions});
    }return {ok:true,count:items.length};
  }
  replace(args){return this.transaction(()=>this._write(args));}
  updateItem(args){return this.transaction(async()=>{
    const source=await this.source(args),items=clone(args.kind==='regex'?source.regex:source.scripts);let list=items;
    if(!Array.isArray(args.path)||!args.path.length)throw error('path 无效');
    args.path.forEach((index,i)=>{if(!Number.isInteger(index)||index<0||index>=list.length)throw error('path 越界');if(i===args.path.length-1)list[index]=args.item;else {if(list[index].type!=='folder')throw error('path 不是目录');list=list[index].scripts;}});
    return this._write({...args,items});
  });}
  importItems(args){return this.transaction(async()=>{
    assertItems(args.items,args.kind);const source=await this.source(args),existing=args.kind==='regex'?source.regex:source.scripts;
    const assign=(node,root)=>{const item={...clone(node),id:randomUUID()};if(args.kind==='helper'){if(root)item.enabled=false;if(item.type==='folder')item.scripts=(item.scripts??[]).map(n=>assign(n,false));}return item;};
    return this._write({...args,items:[...existing,...args.items.map(n=>assign(n,true))]});
  });}
  async resolve(selection){
    const sources=await this.list(selection);const regex=[],scripts=[];
    for(const source of sources){if(source.regexAllowed)for(const rule of source.regex)if(!rule.disabled)regex.push({...rule,source:source.type,scopeType:source.type,scopeId:source.id});
      if(source.helperAllowed)for(const {item,path} of flattenEnabled(source.scripts))scripts.push({...item,scopeType:source.type,scopeId:source.id,path,key:JSON.stringify([source.type,source.id,item.id])});
    }return {regex,scripts};
  }
}
