import {marked} from 'marked';
import sanitizeHtml from 'sanitize-html';
import {runBatchSafe} from './regex-engine.js';

/** Render inside a script-free iframe, never into the application's document. */
export function readingHtml(text){
  const source=String(text??'');
  const fenced=/^\s*```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i.exec(source);
  const html=marked.parse(fenced&&/<[a-z][\s\S]*>/i.test(fenced[1])?fenced[1]:source,{async:false,gfm:true});
  return sanitizeHtml(html,{
    allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','details','summary','style','section','article','header','footer','main','span','div'],
    allowedAttributes:{'*':['class','style','title'],a:['href','title'],img:['src','alt','width','height'],details:['open'],td:['colspan','rowspan'],th:['colspan','rowspan']},
    allowedSchemes:['https','http','data'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,
    allowVulnerableTags:true, // style is isolated by iframe + CSP; no scripts or event attributes survive.
    transformTags:{a:(_tag,attrs)=>({tagName:'span',attribs:{title:attrs.href??''}})},
  });
}

export async function buildReading({messages,scripts,char='',user='用户',signal}){
  const rows=(messages??[]).filter(row=>['user','assistant'].includes(row.role)).map(row=>({...row,content:String(row.content??'')}));
  let current=rows.map(row=>row.content);let applied=0;
  for(const isMarkdown of [false,true]){
    const result=await runBatchSafe({scripts,inputs:current.map((text,index)=>({index,text,scene:{placement:rows[index].role==='user'?1:2,depth:rows.length-1-index,isMarkdown,isPrompt:false}})),scene:{char,user},signal});
    if(!result.ok)throw Object.assign(Error('显示正则执行失败，原始消息保持不变'),{code:result.code??'DISPLAY_REGEX_FAILED'});
    current=result.results.map(row=>{applied+=row.applied?.length??0;return row.output;});
  }
  return {applied,messages:rows.map((row,index)=>({id:row.id??String(index),role:row.role,original:row.content,text:current[index],html:readingHtml(current[index]),hidden:!current[index].trim(),changed:current[index]!==row.content}))};
}
