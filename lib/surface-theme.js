/** Runs in the isolated document. Only supply a canvas when the author left it unpainted. */
export function ensureReadingCanvas() {
  let fallback=document.getElementById('dsh-reading-canvas');
  if(fallback)fallback.textContent='';
  const root=getComputedStyle(document.documentElement),body=getComputedStyle(document.body);
  const transparent=color=>color==='transparent'||/^rgba\([^)]*,\s*0\)$/.test(color);
  if(!transparent(root.backgroundColor)||!transparent(body.backgroundColor)||root.backgroundImage!=='none'||body.backgroundImage!=='none')return;
  // Canvas resolves CSS Color 4 values as well as rgb()/rgba() without guessing their syntax.
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const context=canvas.getContext('2d');context.fillStyle=body.color;context.fillRect(0,0,1,1);
  const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3);
  const luminance=rgb.map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  const dark=luminance>.179;
  if(!fallback){fallback=document.createElement('style');fallback.id='dsh-reading-canvas';document.head.append(fallback);}
  fallback.textContent=`:root{background-color:${dark?'#15171c':'#ffffff'}!important;color-scheme:${dark?'dark':'light'}!important}`;
}

// Independent host skin for common public Tavern extension classes; no upstream stylesheet is bundled.
export const tavernSurfaceCss=`
:root{color-scheme:dark;--SmartThemeBodyColor:#e6e9f0;--SmartThemeEmColor:#aab3c5;--SmartThemeQuoteColor:#9eb8ec;--SmartThemeBlurTintColor:#1d2028;--SmartThemeChatTintColor:#15171c;--SmartThemeBorderColor:#3b414f;--SmartThemeShadowColor:#0008;--mainFontFamily:system-ui,"Microsoft YaHei",sans-serif;--mainFontSize:15px}
*{box-sizing:border-box}body{margin:0;padding:20px;background:#15171c;color:var(--SmartThemeBodyColor);font:15px/1.65 var(--mainFontFamily);overflow-wrap:anywhere}
a{color:#9eb8ec}button,input,select,textarea{font:inherit;color:inherit}button,select,textarea,input:not([type=checkbox]):not([type=radio]):not([type=range]),.menu_button{border:1px solid var(--SmartThemeBorderColor);border-radius:7px;background:#252a35;padding:6px 10px;max-width:100%}
button,.menu_button,summary{cursor:pointer}button:hover,.menu_button:hover{background:#343c4c}input[type=checkbox],input[type=radio]{accent-color:#9eb8ec}input[type=number]{width:7em}textarea,.text_pole{width:100%}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #9eb8ec;outline-offset:2px}
label{display:inline-flex;align-items:center;gap:8px}h1,h2,h3,h4,p{margin:0 0 12px}small,.notes{color:var(--SmartThemeEmColor)}hr{border:0;border-top:1px solid var(--SmartThemeBorderColor);margin:16px 0}
#extensions_settings2,#extensions_settings,#extensionsMenu,#tavern_helper{max-width:100%;margin:0 auto 16px}#extensions_settings2:empty,#extensions_settings:empty,#extensionsMenu:empty,#tavern_helper:empty,#chat:empty,#send_textarea{display:none}
.inline-drawer{border:1px solid var(--SmartThemeBorderColor);border-radius:10px;background:#1d2028;margin-bottom:12px;overflow:hidden}.inline-drawer-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;cursor:pointer}.inline-drawer-header::after{content:'▸';color:var(--SmartThemeEmColor)}.inline-drawer-header[aria-expanded=true]::after{content:'▾'}.inline-drawer-content{display:none;padding:4px 16px 16px}.inline-drawer-content>div{margin-bottom:8px}
.flex-container{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.flexFlowColumn{flex-direction:column;align-items:stretch}.flexFlowRow{flex-direction:row}.flex1{flex:1}.flexNoWrap{flex-wrap:nowrap}.alignItemsCenter{align-items:center}.justifyCenter{justify-content:center}.justifySpaceBetween{justify-content:space-between}.gap5{gap:5px}.gap10{gap:10px}.marginTop5{margin-top:5px}.marginTop10{margin-top:10px}.marginBot10{margin-bottom:10px}.width100p{width:100%}.displayNone,.hidden{display:none!important}
iframe[data-dsh-script-frame]{display:block;width:100%;border:0;background:transparent;min-height:1px}iframe[data-dsh-script-frame][hidden]{display:none!important}
`;

/** Hide execution-only frames; observe for UI mounted later without suspending script execution. */
export function watchScriptFrame(frame,css) {
  const doc=frame.contentDocument,style=doc.createElement('style');style.textContent=css;doc.head.prepend(style);
  let scheduled=false;
  const update=()=>{
    scheduled=false;
    frame.hidden=false;
    const candidates=[...doc.body.querySelectorAll('*')].filter(n=>!['SCRIPT','STYLE','LINK','META','TEMPLATE'].includes(n.tagName));
    const hasContent=[...doc.body.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||candidates.some(n=>{
      const s=frame.contentWindow.getComputedStyle(n),rect=n.getBoundingClientRect();
      return rect.width>0&&rect.height>0&&s.visibility!=='hidden'&&Number(s.opacity)>0&&(
        ['IMG','SVG','CANVAS','INPUT','BUTTON','SELECT','TEXTAREA','VIDEO','IFRAME'].includes(n.tagName)||
        [...n.childNodes].some(child=>child.nodeType===3&&child.textContent.trim())||
        s.backgroundImage!=='none'||!['transparent','rgba(0, 0, 0, 0)'].includes(s.backgroundColor));
    });
    frame.hidden=!hasContent;
    if(hasContent){
      // Avoid scrollHeight feedback from the iframe's previous viewport height.
      frame.style.height='1px';
      frame.style.height=Math.min(4000,Math.max(80,doc.documentElement.scrollHeight,doc.body.scrollHeight))+'px';
    }
  };
  const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(update);}};
  new MutationObserver(schedule).observe(doc.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
  let width=frame.clientWidth;
  doc.addEventListener('load',schedule,true);frame.contentWindow.addEventListener('resize',()=>{if(frame.clientWidth!==width){width=frame.clientWidth;schedule();}});update();
  return update;
}

export function installTavernDrawers(){
  document.addEventListener('click',event=>{
    const header=event.target.closest('.inline-drawer-toggle, .inline-drawer-header');
    if(!header||event.target.closest('input,select,textarea,a,button'))return;
    const drawer=header.closest('.inline-drawer'),content=drawer?.querySelector('.inline-drawer-content');
    if(!content)return;
    const open=getComputedStyle(content).display==='none';content.style.display=open?'block':'none';header.setAttribute('aria-expanded',String(open));
    const icon=header.querySelector('.inline-drawer-icon');icon?.classList.toggle('down',!open);icon?.classList.toggle('up',open);
  });
}
