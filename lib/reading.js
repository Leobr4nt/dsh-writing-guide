import {marked,Marked} from 'marked';
import sanitizeHtml from 'sanitize-html';
import {runBatchSafe} from './regex-engine.js';
import {parseDocument,DomUtils} from 'htmlparser2';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let jqueryPromise;
const jquery=()=>jqueryPromise??=readFile(require.resolve('jquery/dist/jquery.min.js'),'utf8');
const mixedParser=new Marked({renderer:{code(token){return /^(?:html)?$/i.test(token.lang??'')&&/^\s*(?:<!doctype|<html|<div|<section)/i.test(token.text)?token.text:false;}}});

export function unwrapReading(text){
  const source=String(text??'').trim();
  const fenced=/^```(?:html)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(source);
  const body=fenced&&/<[a-z][\s\S]*>/i.test(fenced[1])?fenced[1]:source;
  return {source:body,document:/^\s*(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(body)||/^\s*<head[\s>]/i.test(body)};
}
function mixedReadingMarkup(source){
  // Markdown must never interpret indentation/backticks within scripts or CSS.
  const protectedBlocks=[];
  const protectedSource=source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,block=>{
    const index=protectedBlocks.push(block)-1;return `\n<div data-reading-protected="${index}"></div>\n`;
  });
  let html=mixedParser.parse(protectedSource,{async:false,gfm:true});
  html=html.replace(/<div data-reading-protected="(\d+)"><\/div>/g,(_all,index)=>protectedBlocks[Number(index)]??'');
  return html;
}

/** Render inside a script-free iframe, never into the application's document. */
export function readingHtml(text){
  const {source,document}=unwrapReading(text);
  const html=document?source:marked.parse(source,{async:false,gfm:true});
  return sanitizeHtml(html,{
    allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','details','summary','style','section','article','header','footer','main','span','div','button','input','select','option','textarea','label'],
    allowedAttributes:{'*':['id','class','style','title','data-*','aria-*'],a:['href','title'],img:['src','alt','width','height'],details:['open'],td:['colspan','rowspan'],th:['colspan','rowspan'],button:['type','disabled'],input:['type','value','checked','disabled','placeholder','min','max','step'],select:['disabled','multiple'],option:['value','selected'],textarea:['readonly','disabled','placeholder'],label:['for']},
    allowedSchemes:['https','http','data'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,
    allowVulnerableTags:true, // style is isolated by iframe + CSP; no scripts or event attributes survive.
    transformTags:{a:(_tag,attrs)=>({tagName:'span',attribs:{title:attrs.href??''}})},
  });
}

/** Runs only in an opaque-origin iframe with no network, forms, popups or parent privileges. */
export async function interactiveReadingHtml(text,assets){
  const {source,document}=unwrapReading(text);
  if(!document&&!/<script(?:\s|>)/i.test(source))return {html:readingHtml(text),interactive:false,imagesLoaded:0,imagesFailed:0};
  const html=document?source:mixedReadingMarkup(source),doc=parseDocument(html);
  const nodes=DomUtils.findAll(node=>['tag','script','style'].includes(node.type),doc.children);
  let imagesLoaded=0,imagesFailed=0,usedBytes=0;
  const imgNodes=nodes.filter(node=>node.name==='img');
  const unique=[...new Set(imgNodes.map(node=>node.attribs.src).filter(src=>/^https:\/\//i.test(src??'')))].slice(0,20);
  const resolved=new Map();
  for(let offset=0;offset<unique.length;offset+=4)await Promise.all(unique.slice(offset,offset+4).map(async url=>{const value=await assets?.image(url);if(value&&usedBytes+value.length<40*1024*1024){usedBytes+=value.length;resolved.set(url,value);}}));
  for(const node of nodes){
    if(['base','iframe','object','embed','link','meta'].includes(node.name)||(node.name==='script'&&node.attribs.src)){DomUtils.removeElement(node);continue;}
    if(node.name==='form'){node.name='div';delete node.attribs.action;delete node.attribs.method;}
    if(node.name==='input'&&node.attribs.type==='file'){node.attribs.disabled='';node.attribs.type='text';}
    if(node.name==='a'){delete node.attribs.href;delete node.attribs.target;}
    if(node.name==='style')for(const child of node.children??[])if(child.type==='text')child.data=child.data.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi,'');
    if(node.name==='img'){
      const original=node.attribs.src;
      if(/^https?:/i.test(original??'')){
        if(resolved.has(original)){node.attribs.src=resolved.get(original);imagesLoaded++;}
        else{delete node.attribs.src;node.attribs.alt='插图暂无法加载';node.attribs['data-reading-image-failed']='true';imagesFailed++;}
      }else if(original&&!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(original)){delete node.attribs.src;imagesFailed++;}
      delete node.attribs.srcset;node.attribs.referrerpolicy='no-referrer';node.attribs.loading='eager';
    }
  }
  const head=nodes.find(node=>node.name==='head'),body=nodes.find(node=>node.name==='body');
  const bodyAttributes=body?Object.fromEntries(Object.entries(body.attribs).filter(([key])=>['class','id','style','data-theme'].includes(key))):{};
  const lib=(await jquery()).replace(/<\/script/gi,'<\\/script');
  const imageSources=Object.fromEntries(resolved);
  if(document&&nodes.filter(node=>node.name==='body').length===1)return {html:body?DomUtils.getInnerHTML(body):DomUtils.getOuterHTML(doc),head:`<script>${lib}</script>${head?DomUtils.getInnerHTML(head):''}`,bodyAttributes,interactive:true,imagesLoaded,imagesFailed,imageSources};
  for(const node of nodes)if(['html','head','body'].includes(node.name))node.name='div';
  return {html:DomUtils.getOuterHTML(doc),head:`<script>${lib}</script>`,bodyAttributes:{},interactive:true,imagesLoaded,imagesFailed,imageSources};
}

export async function buildReading({messages,scripts,char='',user='用户',signal,assets}){
  const rows=(messages??[]).filter(row=>['user','assistant'].includes(row.role)).map(row=>({...row,content:String(row.content??'')}));
  let current=rows.map(row=>row.content);let applied=0;
  for(const isMarkdown of [false,true]){
    const result=await runBatchSafe({scripts,inputs:current.map((text,index)=>({index,text,scene:{placement:rows[index].role==='user'?1:2,depth:rows.length-1-index,isMarkdown,isPrompt:false}})),scene:{char,user},signal});
    if(!result.ok)throw Object.assign(Error('显示正则执行失败，原始消息保持不变'),{code:result.code??'DISPLAY_REGEX_FAILED'});
    current=result.results.map(row=>{applied+=row.applied?.length??0;return row.output;});
  }
  const messagesOut=[];
  for(let index=0;index<rows.length;index++){
    const row=rows[index],rendered=row.role==='assistant'?await interactiveReadingHtml(current[index],assets):{html:readingHtml(current[index]),interactive:false,imagesLoaded:0,imagesFailed:0};
    messagesOut.push({id:row.id??String(index),role:row.role,original:row.content,text:current[index],...rendered,hidden:!current[index].trim(),changed:current[index]!==row.content});
  }
  return {applied,messages:messagesOut};
}
