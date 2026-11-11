import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const hash = value => createHash('sha256').update(value).digest('hex');
const allowedHosts = new Set(['cdn.jsdelivr.net','testingcf.jsdelivr.net']);
const allowedPaths = [
  '/gh/MagicalAstrogy/MagVarUpdate/', '/gh/StageDog/tavern_resource/',
  '/npm/jquery', '/npm/lodash', '/npm/zod', '/npm/yaml', '/npm/js-yaml',
];
export class RuntimeModules {
  constructor(root) { this.root=root;this.records={};this.downloads=0;this.writes=Promise.resolve(); }
  async load() { try { this.records=JSON.parse(await fs.readFile(path.join(this.root,'manifest.json'),'utf8')); } catch(e) { if(e.code!=='ENOENT')throw e; } }
  async source(address, transitive = false) {
    const url=new URL(address);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!allowedHosts.has(url.hostname)||!(allowedPaths.some(p=>url.pathname.startsWith(p))||(transitive&&url.pathname.startsWith('/npm/')))){this.lastDenied=url.href;throw Error('MODULE_NOT_ALLOWED');}
    const id=hash(url.href),file=path.join(this.root,id+'.js');
    const old=this.records[id];
    if(old){const bytes=await fs.readFile(file);if(hash(bytes)!==old.sha256)throw Error('MODULE_INTEGRITY');return bytes.toString('utf8');}
    if(Object.keys(this.records).length>=256)throw Error('MODULE_LIMIT');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('MODULE_DOWNLOAD_FAILED');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>8*1024*1024)throw Error('MODULE_TOO_LARGE');
    await fs.mkdir(this.root,{recursive:true});await fs.writeFile(file,bytes);
    this.records[id]={url:url.href,sha256:hash(bytes),bytes:bytes.length};this.downloads++;
    this.writes=this.writes.then(()=>fs.writeFile(path.join(this.root,'manifest.json'),JSON.stringify(this.records,null,2)));await this.writes;
    return bytes.toString('utf8');
  }
  async bundle(source) {
    try {
      const result=await build({stdin:{contents:source,sourcefile:'protected-script.js',loader:'js'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],write:false,logLevel:'silent',plugins:[{
        name:'fixed-public-modules',setup:api=>{
          api.onResolve({filter:/^https:\/\//},args=>({path:args.path,namespace:'public-module',pluginData:{transitive:args.namespace==='public-module'}}));
          api.onResolve({filter:/.*/,namespace:'public-module'},args=>args.path.startsWith('node:')?{path:args.path,external:true}:{path:new URL(args.path,args.importer).href,namespace:'public-module',pluginData:{transitive:true}});
          api.onLoad({filter:/.*/,namespace:'public-module'},async args=>({contents:await this.source(args.path,args.pluginData?.transitive),loader:'js'}));
        },
      }]});
      return result.outputFiles[0].text;
    } catch(error) { const messages=(error?.errors??[]).map(e=>e.text).join(' ');throw new Error(['MODULE_NOT_ALLOWED','MODULE_DOWNLOAD_FAILED','MODULE_TOO_LARGE','MODULE_INTEGRITY','MODULE_LIMIT'].find(s=>messages.includes(s))??'MODULE_BUILD_FAILED',{cause:error}); }
  }
}
