import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ipaddr from 'ipaddr.js';

export function publicImageUrl(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.href.length>4096)return null;
    const host=url.hostname.replace(/^\[|\]$/g,'');
    if(host==='localhost'||/\.(?:local|localhost|internal)$/i.test(host))return null;
    if(ipaddr.isValid(host)&&ipaddr.process(host).range()!=='unicast')return null;
    return url;
  }catch{return null;}
}
function imageMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  return null;
}
/** Public HTTPS images only. DNS answers are checked and pinned for each redirect hop. */
async function downloadImage(address,hops=0,kind='image'){
  const url=publicImageUrl(address);if(!url||hops>3)throw Error('IMAGE_ADDRESS');
  let answers=await lookup(url.hostname,{all:true});
  // TUN clients may return 198.18/15 fake IPs. Resolve the public hostname via DoH,
  // then still pin a checked public address; never admit the reserved address itself.
  if(!ipaddr.isValid(url.hostname)&&answers.some(entry=>ipaddr.parse(entry.address).kind()==='ipv4'&&ipaddr.parse(entry.address).match(ipaddr.parse('198.18.0.0'),15))){
    const response=await fetch('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(url.hostname)+'&type=A',{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw Error('IMAGE_DNS');const data=await response.json();
    answers=(data.Answer??[]).filter(entry=>entry.type===1).map(entry=>({address:entry.data,family:4}));
  }
  if(!answers.length||answers.some(entry=>ipaddr.process(entry.address).range()!=='unicast'))throw Error('IMAGE_ADDRESS');
  const answer=answers[0];
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{lookup:(_host,options,callback)=>options?.all?callback(null,[answer]):callback(null,answer.address,answer.family),headers:{accept:kind==='style'?'text/css':'image/png,image/jpeg,image/webp,image/gif','user-agent':'DSH-Writing-Asset/0.5'}},response=>{
      if([301,302,303,307,308].includes(response.statusCode)){
        const location=response.headers.location;response.resume();if(!location)return reject(Error('IMAGE_REDIRECT'));
        downloadImage(new URL(location,url).href,hops+1,kind).then(resolve,reject);return;
      }
      if(response.statusCode!==200){response.resume();reject(Error('IMAGE_HTTP'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>(kind==='style'?2:8)*1024*1024){req.destroy(Error('IMAGE_SIZE'));return;}chunks.push(chunk);});
      response.on('end',()=>{const bytes=Buffer.concat(chunks),mime=kind==='style'&&/^text\/css(?:;|$)/i.test(String(response.headers['content-type']??''))?'text/css':kind==='image'?imageMime(bytes):null;mime?resolve({bytes,mime}):reject(Error('IMAGE_FORMAT'));});
      response.on('error',reject);
    });
    const timer=setTimeout(()=>req.destroy(Error('IMAGE_TIMEOUT')),12000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);
  });
}
export class ReadingAssets{
  constructor(root,{download=downloadImage,downloadStyle=address=>downloadImage(address,0,'style')}={}){this.root=path.join(root,'reading-images');this.styleRoot=path.join(root,'reading-styles');this.download=download;this.downloadStyle=downloadStyle;this.pending=new Map();this.failed=new Map();this.lastFailure=null;}
  async stylesheet(address){
    const url=publicImageUrl(address);if(!url)return null;
    const key='style:'+url.href;if((this.failed.get(key)??0)>Date.now())return null;if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      const file=path.join(this.styleRoot,createHash('sha256').update(url.href).digest('hex')+'.css');let bytes;
      try{bytes=await fs.readFile(file);}catch{}
      if(!bytes){const result=await this.downloadStyle(url.href);if(result.mime!=='text/css')throw Error('STYLE_FORMAT');bytes=result.bytes;if(bytes.length>2*1024*1024)throw Error('STYLE_SIZE');await fs.mkdir(this.styleRoot,{recursive:true});await fs.writeFile(file,bytes);}
      if(bytes.length>2*1024*1024)throw Error('STYLE_SIZE');
      // Main layout CSS is retained. Secondary network resources remain blocked.
      return bytes.toString('utf8').replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi,'').replace(/<\/style/gi,'<\\/style');
    })().catch(()=>{this.failed.set(key,Date.now()+60000);return null;}).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
  }
  async image(address){
    const url=publicImageUrl(address);if(!url)return null;
    if((this.failed.get(url.href)??0)>Date.now())return null;
    if(this.pending.has(url.href))return this.pending.get(url.href);
    const task=this.load(url.href).catch(error=>{this.lastFailure=/^(?:IMAGE_[A-Z_]+|E[A-Z_]+)$/.test(error.code??error.message)?error.code??error.message:'IMAGE_UNAVAILABLE';this.failed.set(url.href,Date.now()+60000);return null;}).finally(()=>this.pending.delete(url.href));
    this.pending.set(url.href,task);return task;
  }
  async load(address){
    const file=path.join(this.root,createHash('sha256').update(address).digest('hex')+'.bin');
    let bytes;try{bytes=await fs.readFile(file);}catch{}
    let mime=bytes&&imageMime(bytes);
    if(!mime){const result=await this.download(address);bytes=result.bytes;mime=imageMime(bytes);if(!mime)throw Error('IMAGE_FORMAT');await fs.mkdir(this.root,{recursive:true});await fs.writeFile(file,bytes);}
    if(bytes.length>8*1024*1024)throw Error('IMAGE_SIZE');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
}
