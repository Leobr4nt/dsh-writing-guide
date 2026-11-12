import {parseDocument,DomUtils,Parser} from 'htmlparser2';
import {randomUUID} from 'node:crypto';
import {readingHtml} from './reading.js';

/** Keep display-rule folds out of frontend scripts that reparse text and drop tags.
 * Only explicit display folds are protected; authored scripts/ordinary details stay intact.
 */
export function protectReadingFolds(html) {
  const source=String(html??''),doc=parseDocument(source,{withStartIndices:true,withEndIndices:true});
  const closed=new Map(),stack=[];
  const parser=new Parser({
    onopentag(name){if(name==='details')stack.push(parser.startIndex);},
    onclosetag(name,implied){if(name==='details'){const start=stack.pop();if(start!==undefined&&!implied)closed.set(start,parser.endIndex);}},
  });parser.end(source);
  const marked=node=>node.name==='details'&&['draft','writing_covenant'].includes(node.attribs?.['data-writing-fold']);
  const nodes=DomUtils.findAll(marked,doc.children).filter(node=>{
    for(let parent=node.parent;parent;parent=parent.parent)if(marked(parent)||['script','style','textarea','pre','code','template'].includes(parent.name))return false;
    return Number.isInteger(node.startIndex)&&closed.get(node.startIndex)===node.endIndex;
  }).sort((a,b)=>a.startIndex-b.startIndex);
  if(!nodes.length)return {html:source,folds:[]};
  const prefix='DSHWRITINGFOLD'+randomUUID().replaceAll('-',''),folds=[];let cursor=0,out='';
  for(const [index,node]of nodes.entries()){
    const token=prefix+'X'+index+'END';
    // This content is projected as inert HTML. It never executes in the script browser.
    folds.push({token,html:readingHtml(source.slice(node.startIndex,node.endIndex+1)),index});
    out+=source.slice(cursor,node.startIndex)+token;cursor=node.endIndex+1;
  }
  return {html:out+source.slice(cursor),folds};
}
