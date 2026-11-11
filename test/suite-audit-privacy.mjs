import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'suite-audit-privacy-'));
try {
  const sentinel='PRIVATE_FIXTURE_MUST_NOT_REACH_AUDIT_OUTPUT';
  const store=new GuideStore(root),ext=new ExtensionStore(root);await store.ensure();await ext.save({});
  const script={type:'script',id:'private-script',name:sentinel,enabled:true,content:`throw Error(${JSON.stringify(sentinel)});`};
  await store.savePreset({id:'p',name:sentinel,prompts:[{identifier:'main',content:`<% throw Error(${JSON.stringify(sentinel)}); %>`},{identifier:'chatHistory',marker:true}],extensions:{tavern_helper:{scripts:[script]}}});
  await store.saveCard({id:'c',name:sentinel,extensions:{},linkedWorldId:'w'});
  await store.saveWorld({id:'w',name:sentinel,entries:[]});await store.saveWorld({id:'style',entries:[]});
  await store.saveSettings({enabled:true,includeWorlds:true,contextWindow:10000,maxTokens:100});
  await store.saveBindings({defaultBinding:{},bindings:{s:{presetId:'p',cardId:'c',worldIds:['style'],worldSelection:'selected',provider:'test',model:'test'}}});
  const manifest=path.join(root,'validation-suite.json'),report=path.join(root,'report.json');
  await fs.writeFile(manifest,JSON.stringify({sessionId:'s',styleWorldId:'style',linkedWorldId:'w',inputs:{}}));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/verify-suite.mjs',import.meta.url)),manifest,report],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,2,'an unsuccessful acceptance has a distinct exit status');
  const saved=await fs.readFile(report,'utf8');
  assert.ok(![result.stdout,result.stderr,saved].some(s=>s.includes(sentinel)),'material, script logs and exception text stay hidden');
  const value=JSON.parse(saved);assert.equal(value.accepted,false);assert.equal(value.inputsAndStateUnchanged,true);
  assert.equal(value.enabledTemplatePath.modelTransportCalls,0);assert.equal(value.enabledTemplatePath.variableCommits,0);
  const missing=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/verify-resident-suite.mjs',import.meta.url)),path.join(root,'missing.json'),path.join(root,'missing-report.json')],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(missing.status,1,'resident validation infrastructure failures cannot report success');
  const missingReport=JSON.parse(await fs.readFile(path.join(root,'missing-report.json'),'utf8'));
  assert.equal(missingReport.corePassed,false);assert.equal(missingReport.fullCompatibility,false);
  assert.ok(!missing.stdout.includes(root),'failure output does not echo private filesystem paths');
  console.log('suite-audit-privacy: protected text/errors omitted, failed acceptance explicit, persistent data unchanged');
} finally { await fs.rm(root,{recursive:true,force:true}); }
