/**
 * 正则 worker（批量版）：一个 worker 跑「多条消息 × 多条规则」，主线程可按整批 deadline 终止。
 * 不联网、不读写文件、不 eval。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runScriptSync } from './regex-engine.js';

const { jobs = [], limits, char = '', user = '' } = workerData ?? {};

const results = [];
for (const job of jobs) {
  let text = String(job.text ?? '');
  const applied = [];
  let failure = null;
  for (const script of job.chain ?? []) {
    const result = runScriptSync(script, text, { char, user, limits });
    if (!result.ok) { failure = result; break; }
    text = result.output;
    applied.push(script.scriptName ?? script.id ?? 'script');
  }
  results.push(failure
    ? { index: job.index, ok: false, code: failure.code, message: failure.message, output: job.text, applied }
    : { index: job.index, ok: true, output: text, applied });
}

parentPort?.postMessage({ ok: results.every((row) => row.ok), results });
