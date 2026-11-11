import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../test/',import.meta.url)).filter(name=>name.endsWith('.mjs')).sort();
let failures=0;
for(const file of files){const result=spawnSync(process.execPath,['test/'+file],{cwd:root,stdio:'inherit',windowsHide:true});if(result.status!==0)failures++;}
console.log(`${files.length} test files, ${failures} failures`);
process.exitCode=failures?1:0;