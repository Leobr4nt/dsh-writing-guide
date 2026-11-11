/**
 * 本插件自己的写作生成通道。
 *
 * 依据（llm/stream 事件参数说明原文）：AgentLoop 构造的请求 deep-frozen、监听器只读；
 * 插件因此无法在普通会话里做消息级插入。本插件**自己构造** GenerateOptions（不带 loop 身份、不冻结），
 * 复用 `ctx.llm` 的模型服务，于是 @D / role / PHI 位置能真正落到 messages 上。
 *
 * 消息形状来自本机 GenerateOptions 契约：
 *   RequestMessage = Message | RequestUserInput
 *   RequestUserInput = { role:'user', content, id?: never, source?: never }   ← 只有 user 可以省略 id/source
 *   SystemMessage    = { role:'system', source:{kind:'system-prompt'} }        ← 必须带 id + source
 *   AssistantMessage = { role:'assistant', source:{kind:'model', provider, model} }
 * 因此非 user 消息一律补齐 id 与 source；`system` 字段不再使用（内容作为 system 消息保留位置）。
 */

let seq = 0;
const nextId = (role) => `writing-guide-${role}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/**
 * @param {{role:'user'|'assistant'|'system', content:string}} message
 */
export function toRequestMessage(message, { provider, model }) {
  const content = [{ type: 'text', text: String(message.content ?? '') }];
  if (message.role === 'user') return { role: 'user', content };
  if (message.role === 'assistant') {
    return { role: 'assistant', id: nextId('assistant'), source: { kind: 'model', provider, model }, content };
  }
  return { role: 'system', id: nextId('system'), source: { kind: 'system-prompt' }, content };
}

/** finish 只认 stop；error / aborted / max-tokens 都不能被当成成功正文保存。 */
export function isSuccessfulFinish(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  return kind === 'stop';
}

/**
 * @param {{
 *   llm:any, provider:string, model:string,
 *   plan:{ system:string, messages:Array<{role:string,content:string}> },
 *   temperature?:number, maxTokens?:number, signal?:AbortSignal,
 * }} input
 */
export async function streamGeneration({ llm, provider, model, plan, temperature, maxTokens, signal }) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用');
  if (!provider || !model) throw new Error('没有可用的模型：请先在宿主里选好默认模型，或给插件配 provider/model');

  const options = {
    provider,
    model,
    messages: plan.messages.map((message) => toRequestMessage(message, { provider, model })),
    temperature,
    maxTokens,
    signal,
  };

  let text = '';
  let usage = null;
  let finish = null;
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? '';
    else if (chunk?.type === 'usage') usage = chunk.usage ?? null;
    else if (chunk?.type === 'finish') finish = chunk.reason ?? null;
  }
  const ok = isSuccessfulFinish(finish) && text.trim().length > 0;
  return {
    ok,
    text: ok ? text : '',
    discardedText: ok ? '' : text,
    finish,
    usage,
    request: {
      messages: options.messages.length,
      roles: options.messages.map((message) => message.role),
    },
  };
}
