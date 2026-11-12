import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { createGuestApi } from './extension-guest-api.js';
import { createTemplateReaders } from './template-readers.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

let runtime, vm;
try {
  const engine = await newQuickJSWASMModuleFromVariant(variant);
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(24 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 700;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  vm = runtime.newContext();
  const evaluate = source => {
    const result = vm.evalCode(source, 'writing-extension.js');
    if (result.error) {
      const info = vm.dump(result.error);
      result.error.dispose();
      throw new Error(String(info?.message ?? '扩展执行失败').slice(0, 240));
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    return value;
  };
  if (workerData.kind === 'template') {
    // Trusted bundled dependency is evaluated inside QuickJS, never in Node with material.
    const require=createRequire(import.meta.url);
    evaluate(await readFile(require.resolve('lodash/lodash.min.js'),'utf8'));
    evaluate(`globalThis.__templateReaders = (${createTemplateReaders.toString()});`);
  }
  evaluate(`globalThis.__input = ${JSON.stringify(workerData)}; globalThis.__api = (${createGuestApi.toString()})(__input);`);
  const source = workerData.kind === 'spreset'
    ? `const fn=(${workerData.code.trim().replace(/;\s*$/,'')});if(typeof fn!=='function')throw Error('SPRESET_FUNCTION_REQUIRED');Promise.resolve(fn(__input.input)).then(value=>{globalThis.__result={result:value===undefined?__input.input:value};},error=>{globalThis.__failure='SPRESET_SCRIPT_FAILED';});`
    : workerData.kind === 'template'
    ? `const texts = [${workerData.programs.map(fn => `(${fn})(__api, undefined, () => { throw Error('模板 include 尚未支持'); })`).join(',')}]; globalThis.__result = __api.snapshot({ texts });`
    : `Object.assign(globalThis, __api); (async () => {\n${workerData.code}\n})().then(value => { globalThis.__result = __api.snapshot({ result: value ?? null }); }, error => { globalThis.__failure = String(error?.message ?? error); });`;
  evaluate(source + '\n;undefined');
  let jobs = 0;
  while (runtime.hasPendingJob() && jobs++ < 1000) {
    const result = runtime.executePendingJobs(1);
    if (result.error) { result.error.dispose(); throw new Error('扩展异步执行失败'); }
  }
  const failure = evaluate('globalThis.__failure');
  if (failure) throw new Error(String(failure));
  const serialized = evaluate('JSON.stringify(globalThis.__result)');
  if (typeof serialized !== 'string') throw new Error('脚本包含未完成异步任务；网络、定时器和宿主事件尚未支持');
  if (serialized.length > 500_000) throw new Error('扩展输出超过 500 KB');
  const value = JSON.parse(serialized);
  const validate = data => {
    if (!data || typeof data !== 'object') return;
    for (const key of Object.keys(data)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('变量包含不允许的属性名');
      validate(data[key]);
    }
  };
  validate(value);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message ?? error).slice(0, 240) });
} finally {
  vm?.dispose();
  runtime?.dispose();
}
