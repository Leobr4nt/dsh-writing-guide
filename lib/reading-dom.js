import sanitizeHtml from 'sanitize-html';

/** Runs in the isolated script browser. Export live DOM, never a screenshot of text. */
export function snapshotReadingDom() {
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
    if(node.tagName==='INPUT'){
      if(node.type==='file'){copy.setAttribute('disabled','');copy.removeAttribute('value');}
      else {copy.setAttribute('value',node.value);copy.toggleAttribute('checked',node.checked);}
    }else if(node.tagName==='TEXTAREA')copy.textContent=node.value;
    else if(node.tagName==='OPTION')copy.toggleAttribute('selected',node.selected);
    else if(node.tagName==='CANVAS'){
      try{const img=document.createElement('img');img.src=node.toDataURL('image/png');img.width=node.width;img.height=node.height;img.setAttribute('data-reading-node',state.ids.get(node));copy.replaceWith(img);}catch{copy.replaceWith(document.createTextNode('画布暂无法显示'));}
    }
  });
  const attributes=node=>Object.fromEntries([...node.attributes].filter(a=>['id','class','style','lang','dir','data-theme'].includes(a.name)).map(a=>[a.name,a.value]));
  return {html:body.innerHTML,head:[...document.head.querySelectorAll('style')].map(node=>node.outerHTML).join('\n'),
    bodyAttributes:attributes(document.body),rootAttributes:attributes(document.documentElement)};
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
    +head+'<style>html{min-height:0!important}body{overflow-wrap:anywhere}img{max-width:100%}body,body *{-webkit-user-select:text;user-select:text}button,input,select,textarea{font:inherit}</style></head><body '+attributes(snapshot.bodyAttributes)+'>'+body+'</body></html>';
}
