/**
 * 插件自有的薄 OpenAI-compatible Chat Completions transport。
 *
 * 只服务「已配置为 api=openai-completions」的作品 route（当前只有 catiecli 经实测）：
 *   - baseURL / 模型列表 / apiKeyEnv **从现有 provider 配置读取**，不复制密钥、不写文件、不打印
 *   - 运行时通过 DSH 的 credentials.resolve(ref) 在内存取 key
 *   - plan.messages 按顺序映射成 {role, content}，**保留** MAIN/WORLD/@D/PHI 的角色与顺序
 *   - 仅文本、无工具；stream:false；finish_reason 必须是 'stop'，否则不产出正文
 *   - redirect:'error'（不跨跳转携带认证）、timeout / abort、无自动重试（不重复计费）
 *   - 失败信息里把内存 key 替换成 [redacted]，不记录请求 headers
 */
import { credentialValue } from './credentials.js';

const MARKER_RE = /\[[A-Z0-9_]+\]/g;

/** OpenAI 的 usage → DSH 的 TokenUsage 字段（宿主按后者落盘）。 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = Number(raw.prompt_tokens ?? raw.inputTokens ?? 0);
  const outputTokens = Number(raw.completion_tokens ?? raw.outputTokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? (inputTokens + outputTokens));
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

/** 只记录角色与标记；输入就是**即将 JSON.stringify 的 body.messages**。 */
export function messageEvidence(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role,
    markers: String(message.content ?? '').match(MARKER_RE) ?? [],
    chars: String(message.content ?? '').length,
  }));
}

/**
 * 读取某 provider 的 chat-completions 端点配置（只取配置字段，不读密钥值）。
 * 模型必须来自作品选择，且属于该 provider 的已配置模型。
 */
export async function resolveChatRoute({ settings, provider = 'catiecli', model }) {
  if (!settings || typeof settings.describe !== 'function') throw new Error('settings 服务不可用');
  const list = settings.describe({ redactSecrets: true }) ?? [];
  const entry = list.find((item) => String(item.ns).includes('pi-ai'));
  const profile = entry?.value?.providers?.[provider];
  if (!profile) throw new Error(`没有已配置的 provider：${provider}`);
  if (profile.api !== 'openai-completions') {
    throw new Error(`provider ${provider} 的 api 是 ${profile.api}，不是 openai-completions`);
  }
  const baseURL = String(profile.baseURL ?? '');
  const apiKeyEnv = String(profile.apiKeyEnv ?? '');
  const models = (profile.models ?? []).map((item) => String(item.id ?? '')).filter(Boolean);
  if (!baseURL) throw new Error(`provider ${provider} 缺少 baseURL`);
  if (!apiKeyEnv) throw new Error(`provider ${provider} 没有 apiKeyEnv（本 transport 只接受凭证引用）`);
  const chosen = String(model ?? '');
  if (!chosen) throw new Error('作品没有指定模型');
  if (!models.includes(chosen)) {
    throw new Error(`模型 ${chosen} 不在 provider ${provider} 的已配置模型里（${models.join(', ') || '空'}）`);
  }
  return { provider, baseURL, model: chosen, apiKeyEnv };
}

/** 运行时取 key（内存，不落盘）。 */
export async function resolveTransportKey({ credentials, apiKeyEnv }) {
  const value = await credentialValue(credentials, apiKeyEnv);
  if (!value) throw new Error(`没有可用凭证：${apiKeyEnv}（请先在模型页配置）`);
  return value;
}

/** 构造最终 body（顺序即 plan.messages 顺序）。 */
export function buildChatBody({ model, messages, maxTokens, temperature }) {
  const body = {
    model,
    messages: (Array.isArray(messages) ? messages : []).map((message) => ({
      role: message.role,
      content: String(message.content ?? ''),
      ...(message.tool_calls?{tool_calls:message.tool_calls}:{}),
      ...(message.tool_call_id?{tool_call_id:message.tool_call_id}:{}),
    })),
    stream: false,
  };
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
  if (Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  return body;
}

/**
 * 发一次 chat completions（不重试）。
 * @returns {Promise<{ok:boolean, content:string, finish:string|null, usage:any, status:number, evidence:any[], body:any}>}
 */
export async function postChatCompletion({
  baseURL, apiKey, body, timeoutMs = 180000, signal, onRequest,
}) {
  if (signal?.aborted) throw Object.assign(new Error('已取消，未发起请求'), { code: 'aborted' });
  const evidence = messageEvidence(body?.messages);
  const payload = JSON.stringify(body);
  const url = new URL(`${baseURL.replace(/\/+$/, '')}/chat/completions`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('写作端点必须使用 HTTP 或 HTTPS');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => { try { controller.abort(signal?.reason); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const redact = (text) => String(text).split(apiKey).join('[redacted]');
  try {
    onRequest?.(evidence);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      redirect: 'error',
      signal: controller.signal,
    });
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw Object.assign(new Error(`读取响应失败：${redact(error?.message ?? error)}`), { code: 'network' });
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(`chat/completions ${response.status}: ${redact(text.slice(0, 400))}`),
        { status: response.status },
      );
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('chat/completions 返回了非 JSON'); }
    const choice = json?.choices?.[0];
    const content = String(choice?.message?.content ?? '');
    const finish = choice?.finish_reason ?? null;
    return {
      ok: finish === 'stop' && content.trim().length > 0,
      content,
      finish,
      toolCalls:Array.isArray(choice?.message?.tool_calls)?choice.message.tool_calls:[],
      usage: normalizeUsage(json?.usage),
      status: response.status,
      evidence,
      body,
    };
  } catch (error) {
    // 用户取消 vs 端点超时：分开报，都不重试
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'aborted' });
    if (timedOut) {
      const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
      throw Object.assign(
        new Error(`写作端点超时（${seconds}s 无响应）`),
        { code: 'timeout', status: null },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
