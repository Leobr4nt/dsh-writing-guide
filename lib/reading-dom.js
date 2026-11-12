import sanitizeHtml from 'sanitize-html';

/** Runs in the isolated script browser. Export live DOM, never a screenshot of text. */
export function snapshotReadingDom(folds=[]) {
  const state=window.__dshReadingNodes??={ids:new WeakMap(),next:1};
  for(const node of document.body.querySelectorAll('*')) {
    if(['SCRIPT','STYLE','LINK','META'].includes(node.tagName))continue;
    if(!state.ids.has(node))state.ids.set(node,String(state.next++));
    node.setAttribute('data-reading-node',state.ids.get(node));
  }
  const body=document.body.cloneNode(true);
  const originals=[...document.body.querySelectorAll('*')],copies=[...body.querySelectorAll('*')];
  originals.forEach((node,index)=>{
    const copy=copies[index];
    // A full-height projection cannot use the source viewport's lazy layout.
    // Otherwise content-visibility:auto can report its small intrinsic fallback
    // during a reload, shrinking the iframe and jumping to an earlier section.
    if(getComputedStyle(node).contentVisibility==='auto')copy.style.setProperty('content-visibility','visible','important');
    if(node.tagName==='STYLE'){
      try{copy.textContent=[...node.sheet.cssRules].map(rule=>rule.cssText).join('\n');}catch{}
    }
    if(node.tagName==='INPUT'){
      if(node.type==='file'){copy.setAttribute('disabled','');copy.removeAttribute('value');}
      else {copy.setAttribute('value',node.value);copy.toggleAttribute('checked',node.checked);}
    }else if(node.tagName==='TEXTAREA')copy.textContent=node.value;
    else if(node.tagName==='OPTION')copy.toggleAttribute('selected',node.selected);
    else if(node.tagName==='CANVAS'){
      try{const img=document.createElement('img');img.src=node.toDataURL('image/png');img.width=node.width;img.height=node.height;img.setAttribute('data-reading-node',state.ids.get(node));copy.replaceWith(img);}catch{copy.replaceWith(document.createTextNode('画布暂无法显示'));}
    }
  });
  // Restore only in the projected clone: source scripts keep their stable text tokens.
  // Local fold controls do not have source-node IDs and are handled natively by the reader.
  for(const fold of Array.isArray(folds)?folds:[]){
    const fragment=()=>{
      const template=document.createElement('template');template.innerHTML=fold.html;
      for(const el of template.content.querySelectorAll('*')){el.removeAttribute('data-reading-node');el.removeAttribute('data-reading-local-fold');}
      let nested=0;for(const details of template.content.querySelectorAll('details'))details.setAttribute('data-reading-local-fold',`${fold.index}-${nested++}`);
      return template.content;
    };
    const textNodes=()=>{
      const nodes=[],walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let node;
      while(node=walker.nextNode()){
        if(node.parentElement?.closest('script,style,textarea,pre,code,[data-reading-local-fold]'))continue;
        const id=node.parentElement?.closest('[data-reading-node]')?.dataset.readingNode;
        const live=id?document.querySelector('[data-reading-node="'+id+'"]'):null;
        if(live&&!live.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))continue;
        nodes.push(node);
      }return nodes;
    };
    let restored=false;
    for(;;){
      const nodes=textNodes(),combined=nodes.map(n=>n.data).join(''),start=combined.indexOf(fold.token);if(start<0)break;
      const end=start+fold.token.length,segments=[];let offset=0;
      for(const node of nodes){const next=offset+node.length;if(start<next&&end>offset)segments.push({node,start:Math.max(0,start-offset),end:Math.min(node.length,end-offset)});offset=next;if(offset>=end)break;}
      // Delete token characters only, never the DOM range between them: skipped
      // code/hidden nodes may contain unrelated original content.
      for(const part of segments)part.node.deleteData(part.start,part.end-part.start);
      if(!restored){const first=segments[0],tail=first.node.splitText(first.start);tail.before(fragment());restored=true;}
    }
    // A formatter may discard its source or token altogether. Keep the content
    // accessible as a collapsed appendix instead of silently losing the fold.
    if(!restored){
      const fallback=document.createElement('section');fallback.setAttribute('data-reading-fold-recovered','');
      for(const [key,value]of Object.entries({display:'block',visibility:'visible',opacity:'1',position:'static',height:'auto','max-height':'none',overflow:'visible','content-visibility':'visible'}))fallback.style.setProperty(key,value,'important');
      fallback.append(fragment());
      for(const details of fallback.querySelectorAll('details[data-reading-local-fold]')){
        details.style.setProperty('display','block','important');details.style.setProperty('visibility','visible','important');
        const summary=details.querySelector(':scope > summary');summary?.style.setProperty('display','list-item','important');summary?.style.setProperty('visibility','visible','important');
      }
      body.append(fallback);
    }
  }
  const attributes=node=>Object.fromEntries([...node.attributes].filter(a=>['id','class','style','lang','dir','data-theme'].includes(a.name)).map(a=>[a.name,a.value]));
  const rootAttributes=attributes(document.documentElement);
  const scheme=getComputedStyle(document.documentElement).colorScheme;
  if(scheme==='normal'||scheme==='light dark'||scheme==='dark light')rootAttributes.style=(rootAttributes.style??'')+';color-scheme:'+(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  const styles=[...document.head.querySelectorAll('style')].map(node=>{
    const copy=node.cloneNode(true);try{copy.textContent=[...node.sheet.cssRules].map(rule=>rule.cssText).join('\n');}catch{}return copy.outerHTML;
  });
  for(const sheet of document.adoptedStyleSheets??[]){const style=document.createElement('style');try{style.textContent=[...sheet.cssRules].map(rule=>rule.cssText).join('\n');styles.push(style.outerHTML);}catch{}}
  return {html:body.innerHTML,head:styles.join('\n'),bodyAttributes:attributes(document.body),rootAttributes};
}

const attr=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const attributes=value=>Object.entries(value??{}).filter(([key])=>['id','class','style','lang','dir','data-theme'].includes(key)).map(([k,v])=>`${k}="${attr(v)}"`).join(' ');
const options={
  allowedTags:[...sanitizeHtml.defaults.allowedTags,'img','details','summary','style','main','section','article','header','footer','span','div','button','input','select','option','optgroup','textarea','label','form'],
  allowedAttributes:{'*':['id','class','style','title','lang','dir','data-*','aria-*','hidden','tabindex'],
    img:['src','alt','width','height'],details:['open'],td:['colspan','rowspan'],th:['colspan','rowspan'],
    button:['type','disabled','name','value'],input:['type','value','checked','disabled','readonly','placeholder','min','max','step','name','maxlength'],
    select:['disabled','multiple','name'],option:['value','selected','disabled'],textarea:['readonly','disabled','placeholder','name','rows','cols'],label:['for'],form:[]},
  allowedSchemes:['data'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,allowVulnerableTags:true,
  transformTags:{
    a:(_tag,attrs)=>({tagName:'span',attribs:Object.fromEntries(Object.entries({...attrs,title:attrs.href??attrs.title??''}).filter(([key])=>['id','class','style','title','data-reading-node','role','tabindex'].includes(key)))}),
    input:(_tag,attrs)=>({tagName:'input',attribs:attrs.type==='file'?{...attrs,disabled:'',value:''}:attrs}),
  },
};

/** Same-origin permits the host's control bridge, but sandbox + CSP prohibit source scripts. */
export function readingDomDocument(snapshot) {
  if(JSON.stringify(snapshot).length>8*1024*1024)throw Error('READING_DOM_TOO_LARGE');
  const head=sanitizeHtml(snapshot.head??'',{...options,allowedTags:['style'],allowedAttributes:{style:['id','media']}});
  const body=sanitizeHtml(snapshot.html??'',options);
  return '<!doctype html><html '+attributes(snapshot.rootAttributes)+'><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    +head+'<style>html{min-height:0!important}body{overflow-wrap:anywhere}img{max-width:100%}body,body *{-webkit-user-select:text;user-select:text}button,input,select,textarea{font:inherit}details[data-reading-local-fold]{display:block;padding:8px;border:1px solid #8884;border-radius:8px}details[data-reading-local-fold]>summary{display:list-item;cursor:pointer}details[data-reading-local-fold]:not([open])>:not(summary){display:none!important}</style></head><body '+attributes(snapshot.bodyAttributes)+'>'+body+'</body></html>';
}
