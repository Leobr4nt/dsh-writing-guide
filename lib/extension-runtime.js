import { Worker } from 'node:worker_threads';
import ejs from 'ejs';

// Third-party JavaScript runs in a separate QuickJS WASM interpreter in a worker.
// Only JSON data crosses the boundary; no Node functions, credentials or host handles.
export function runExtensionJob(job, { signal, timeoutMs = 2000 } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('扩展执行已取消'), { code: 'aborted' }));
  if (JSON.stringify(job).length > 1_000_000) return Promise.reject(new Error('扩展输入超过 1 MB'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extension-worker.js', import.meta.url), { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('扩展执行已取消'), { code: 'aborted' }));
    const timer = setTimeout(() => finish(Object.assign(new Error('扩展执行超时'), { code: 'extension_timeout' })), timeoutMs);
    worker.once('message', result => result.ok ? finish(null, result.value) : finish(Object.assign(new Error(result.error), { code: 'extension_error' })));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!done) finish(new Error(`扩展执行意外结束 (${code})`)); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runTemplateBatch({ texts, variables = {}, messageVariables = {}, globalVariables = {}, context = {}, seed = '', signal }) {
  if (!Array.isArray(texts) || texts.length > 512 || texts.reduce((sum, s) => sum + String(s).length, 0) > 500_000) throw new Error('模板批次超过限制');
  // EJS compiles trusted grammar to source only; the resulting function is never called in Node.
  const programs = texts.map(text => ejs.compile(String(text), { client: true, compileDebug: false, async: false }).toString());
  return runExtensionJob({ kind: 'template', programs, variables, messageVariables, globalVariables, context, seed }, { signal });
}

export async function runHelperScript({ script, variables = {}, scriptVariables = {}, chatMessages = [], context = {}, signal }) {
  if (!script || typeof script.content !== 'string' || script.content.length > 300_000) throw new Error('脚本内容无效或超过 300 KB');
  return runExtensionJob({ kind: 'helper', code: script.content, scriptId: String(script.id ?? ''), variables, scriptVariables, context: { ...context, chatMessages } }, { signal });
}
