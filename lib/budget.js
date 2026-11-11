/**
 * 请求预算准入（生成入口用）。
 *
 * 规则：
 *   - 上下文 = min(模型元数据 contextWindow, 用户设置 contextWindow)（用户更严格时听用户的）
 *   - 可用 = 上下文 − 输出预留 − 每条消息开销
 *   - 中文按保守估算（CJK 1 字 ≈ 1.5 token，ASCII ≈ 0.25 token），不称精确
 *   - 系统段与当前输入必须完整；历史按 **user+assistant 成对**从旧到新裁减并记录原因
 *   - 系统段 + 当前输入都放不下 → 明确拒绝，不发请求
 */

function isCjk(codePoint) {
  return codePoint > 0x2e7f; // 大致覆盖 CJK/全角标点
}

/** 保守 token 估算（不是精确 tokenizer）。 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  let tokens = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    tokens += isCjk(code) ? 1.5 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}

export function minPositive(...values) {
  const list = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return list.length ? Math.min(...list) : 0;
}

/**
 * @param {{contextWindow?:number, userContextWindow?:number, maxOutput?:number, percent?:number, perMessage?:number}} input
 */
export function resolveBudget({ contextWindow = 0, userContextWindow = 0, maxOutput = 0, percent = 25, perMessage = 4 }) {
  const context = minPositive(contextWindow, userContextWindow);
  const outputReserve = Math.max(0, Math.trunc(Number(maxOutput) || 0));
  const available = context > 0 ? context - outputReserve : 0;
  const worldPercent = Math.max(0, Math.min(100, Math.trunc(Number(percent) || 0)));
  return {
    context,
    outputReserve,
    perMessage,
    available: Math.max(0, available),
    worldPercent,
    /** 世界书预算：上下文的 percent（0 = 不额外限制） */
    worldTokens: context > 0 && worldPercent > 0 ? Math.max(64, Math.floor((context * worldPercent) / 100)) : 0,
    estimated: true,
  };
}

function pairKey(messages, index) {
  const message = messages[index];
  return `${message?.role ?? '?'}@${index}`;
}

/**
 * 在预算内装配消息：system 与最后一条 user 必留，历史按对裁减。
 * @param {{messages:Array<{role:string,content:string}>, budget:number, countTokens?:(text:string)=>number, perMessage?:number}} input
 */
export function fitMessages({ messages, budget, countTokens = estimateTokens, perMessage = 4 }) {
  const list = (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
  const cost = (message) => countTokens(message.content) + perMessage;
  const total = (rows) => rows.reduce((sum, message) => sum + cost(message), 0);
  const start = { used: total(list), droppedPairs: 0, droppedMessages: 0, reason: '' };
  if (budget <= 0 || start.used <= budget) return { messages: list, ...start, rejected: false };

  const lastUser = (() => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].role === 'user') return i;
    return -1;
  })();
  if (lastUser < 0) {
    return { messages: [], used: 0, droppedPairs: 0, droppedMessages: 0, reason: '没有可发送的用户消息', rejected: true };
  }

  // 可裁区间：最后一条 user 之前的 user/assistant（system 条目不可裁）
  const droppable = [];
  for (let i = 0; i < lastUser; i += 1) {
    if (list[i].role === 'user' || list[i].role === 'assistant') droppable.push(i);
  }

  const dropped = new Set();
  let used = start.used;
  let droppedPairs = 0;
  for (let cursor = 0; cursor < droppable.length && used > budget; cursor += 1) {
    const index = droppable[cursor];
    if (dropped.has(index)) continue;
    const message = list[index];
    // 成对：user 后紧跟 assistant 时一起删
    const nextIndex = droppable[cursor + 1];
    const isPair = message.role === 'user' && nextIndex !== undefined && list[nextIndex]?.role === 'assistant' && !dropped.has(nextIndex);
    used -= cost(message);
    dropped.add(index);
    if (isPair) {
      used -= cost(list[nextIndex]);
      dropped.add(nextIndex);
      droppedPairs += 1;
      cursor += 1;
    } else if (message.role === 'assistant') {
      // 孤儿 assistant 单独删，也算半对
      droppedPairs += 0;
    }
  }

  const kept = list.filter((_message, index) => !dropped.has(index));
  const result = {
    messages: kept,
    used: total(kept),
    droppedPairs,
    droppedMessages: dropped.size,
    reason: dropped.size ? `历史按成对裁减 ${dropped.size} 条（约 ${droppedPairs} 对）以满足预算 ${budget}` : '',
    rejected: false,
  };
  if (result.used > budget) {
    return {
      ...result,
      messages: [],
      rejected: true,
      reason: `系统段 + 当前输入仍超出预算（需要 ${result.used}，可用 ${budget}）`,
    };
  }
  return result;
}
