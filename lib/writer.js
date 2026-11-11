/**
 * 写作生成通道的唯一实现（工具与 HTTP 共用）。
 *
 * 预算规则（重要）：
 *   - **只裁作品原始历史**（work 的 chat.jsonl，user/assistant 成对），每次裁剪后重建 plan 重新测量；
 *     预设条目、@D、post-history 指导、本次输入一律不参与裁剪（不按 role 猜来源）。
 *   - contextWindow=0 表示用户/模型都没设限（不裁剪）；context>0 且 available<=0（输出占满）必须拒绝。
 *   - 裁光历史仍超 → 拒绝（`budget/over-context`），不会删预设条目凑数。
 *   - 失败/中止不写正文；同一作品生成中直接拒绝。
 */
import { collectHits } from './lore.js';
import { buildPlan } from './plan.js';
import { streamGeneration } from './generate.js';
import { withLock } from './locks.js';
import { fitHistoryRows } from './history-fit.js';
import { estimateTokens, resolveBudget } from './budget.js';

const active = new Set();

/** 把多条 system 合成一条（顺序保持）；degrade 与预算重建后都要能复原。 */
function mergeSystems(messages) {
  const systems = messages.filter((message) => message.role === 'system');
  if (systems.length <= 1) return messages;
  return [{ role: 'system', content: systems.map((message) => message.content).join('\n\n') },
    ...messages.filter((message) => message.role !== 'system')];
}

export function buildScanText(history, message, depth = 2) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((row) => row && (row.role === 'user' || row.role === 'assistant') && String(row.content ?? '').trim())
    .map((row) => String(row.content));
  if (String(message ?? '').trim()) rows.push(String(message));
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(depth) || 2)));
  return rows.slice(-limit).join('\n');
}

function measureMessages(messages, perMessage) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((sum, message) => sum + estimateTokens(message.content) + perMessage, 0);
}

/** 历史按成对裁剪（最旧的两条一组）；每次裁剪后由调用方重建 plan。 */
export function trimHistoryPairs(history) {
  const rows = Array.isArray(history) ? history.slice() : [];
  return {
    rows,
    /** @returns {{rows:any[], dropped:boolean}} */
    dropOldestPair() {
      if (rows.length === 0) return { rows, dropped: false };
      // 以 user 开头的一对为一个单位；若开头不是 user 也按两条一组丢弃
      const size = Math.min(2, rows.length);
      rows.splice(0, size);
      return { rows, dropped: true };
    },
  };
}

export async function generateForWork({
  store, workStore, workId, message, save = true, llm, model, signal, temperature, maxTokens,
  chatTransport,
}) {
  const id = String(workId ?? '').trim();
  const text = String(message ?? '').trim();
  if (!id) return { ok: false, code: 'work/empty-id', detail: '缺少作品 id' };
  if (!text) return { ok: false, code: 'work/empty-message', detail: '输入为空，未发起请求' };

  if (active.has(id)) return { ok: false, code: 'work/busy', detail: '这个作品正在生成中，等它结束再发' };
  if (signal?.aborted) return { ok: false, code: 'aborted', detail: '已取消，未发起请求' };

  active.add(id);
  try {
    return await withLock(`work:${id}`, async () => {
      const meta = await workStore.load(id);
      if (!meta) return { ok: false, code: 'work/not-found', detail: `没有这个作品：${id}` };
      const route = meta.route?.provider && meta.route?.model ? meta.route : model;
      if (!route?.provider || !route?.model) return { ok: false, code: 'model/unavailable', detail: '没有可用模型：请先在宿主里选默认模型' };

      const settings = await store.loadSettings();
      const history = await workStore.chat(id);
      const scanText = buildScanText(history, text, settings.scanDepth);

      const injectEnabled = settings.enabled === true;
      const includeWorlds = settings.includeWorlds !== false;
      const includePreset = settings.includePreset !== false;

      let worlds = [];
      if (injectEnabled && includeWorlds) {
        worlds = await store.listWorlds();
        if (meta.worldIds?.length) worlds = worlds.filter((world) => meta.worldIds.includes(world.id));
      }
      const preset = injectEnabled && includePreset && meta.presetId
        ? await store.getPreset(meta.presetId)
        : null;

      const notes = [];
      if (!injectEnabled) notes.push('注入总开关关闭：本次不注入预设与世界书');
      if (!includeWorlds) notes.push('includeWorlds=false：跳过世界书');
      if (!includePreset) notes.push('includePreset=false：跳过预设');

      const hits = worlds.length
        ? collectHits({ books: worlds, scanText, decisions: new Map(), maxRecursionSteps: Number(settings.maxRecursionSteps ?? 0) })
        : { buckets: { before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [], atDepth: [], outlet: {} }, count: 0, decisions: new Map() };

      let modelContext = 0;
      let inHistorySystem = false;
      try {
        const info = await llm.resolveModelInfo?.(route.provider, route.model);
        modelContext = Number(info?.context?.contextWindow ?? 0) || 0;
        // 运行时事实：dsh-llm-deepseek#1679 无条件把 system 覆盖到顶部，metadata 不可信；
        // 非 deepseek 系（pi-ai）只有在适配器真正声明 in-history
        //（= provider 配了 compat.supportsMidConvoSystemMessages）时才保序。
        const deepseekFamily = /^deepseek/i.test(String(route.provider ?? ''));
        inHistorySystem = !deepseekFamily && info?.systemPromptUpdate === 'in-history';
      } catch { /* 取不到就按不支持处理 */ }

      const budget = resolveBudget({
        contextWindow: modelContext,
        userContextWindow: Number(settings.contextWindow ?? 0),
        maxOutput: Number(settings.maxTokens ?? 0),
        percent: Number(settings.worldBudgetPercent ?? 25),
      });
      const worldBudget = Number(settings.worldBudgetTokens ?? 0) > 0
        ? Number(settings.worldBudgetTokens)
        : budget.worldTokens;

      const deepseekFamily = /^deepseek/i.test(String(route.provider ?? ''));
      let degraded = false;
      const build = (historySlice) => buildPlan({
        preset: preset ?? { id: '', name: '', prompts: [], prompt_order: [{ order: [] }] },
        hits,
        vars: settings.vars ?? {},
        authorNote: injectEnabled ? (meta.authorNote ?? '') : '',
        conversation: [...historySlice, { role: 'user', content: text }],
        budgetTokens: worldBudget,
        maxChars: Number(settings.maxChars ?? 0),
        // deepseek 系：多条 system 会被覆盖，必须先合并；pi-ai：保留原样，由适配器决定
        mergeSystem: deepseekFamily,
      });

      // 先建一次，处理适配器顺序（可能拒绝）
      let historySlice = history.slice();
      let plan = build(historySlice);
      for (const note of notes) plan.meta.notes.push(note);

      if (deepseekFamily && plan.meta.postHistorySystemCount > 0) {
        if (settings.degradeOrder === true) {
          degraded = true;
          plan.messages = mergeSystems(plan.messages);
          plan.meta.orderDegraded = true;
          plan.meta.notes.push('适配器不支持 in-history：历史后的 system 已并入顶部唯一 system（顺序退化，已显式开启 degradeOrder）');
        } else {
          return {
            ok: false,
            code: 'adapter/no-in-history-system',
            detail: `当前 route ${route.provider}/${route.model} 的适配器不支持 in-history system（会把多条 system 合并或提前到顶部）；预设里有 ${plan.meta.postHistorySystemCount} 条历史后 system（PHI/@D）会丢位置。请改用支持 in-history 的 route，或在设置里显式开启 degradeOrder。未发起请求。`,
            adapter: { provider: route.provider, model: route.model, systemPromptUpdate: inHistorySystem ? 'in-history' : 'leading-only' },
          };
        }
      }

      if (!deepseekFamily && plan.meta.postHistorySystemCount > 0) {
        plan.meta.notes.push('pi-ai 适配器会把历史后的 system 包成 <system-reminder> user 消息：位置保留、角色降级为 user');
      }

      // ---- 预算准入：只裁作品原始历史，不碰预设/@D/本次输入
      let budgetInfo = null;
      if (budget.context > 0) {
        if (budget.available <= 0) {
          return {
            ok: false,
            code: 'budget/context-exhausted',
            detail: `上下文 ${budget.context} 已被输出预留 ${budget.outputReserve} 占满（可用 0），未发起请求`,
          };
        }
        const inputCost = estimateTokens(text) + budget.perMessage;
        if (inputCost > budget.available) {
          return {
            ok: false,
            code: 'budget/input-too-large',
            detail: `当前输入约 ${inputCost} token，超出可用预算 ${budget.available}（上下文 ${budget.context} − 输出预留 ${budget.outputReserve}），未发起请求`,
          };
        }
        const fit = await fitHistoryRows({
          history: historySlice,
          build: (rows) => build(rows),
          measure: (candidate) => measureMessages(candidate.messages, budget.perMessage),
          budget,
        });
        plan = fit.plan;
        if (degraded) { plan.messages = mergeSystems(plan.messages); plan.meta.orderDegraded = true; }
        const used = fit.used;
        const droppedPairs = fit.droppedPairs;
        if (fit.rejected) {
          return {
            ok: false,
            code: 'budget/over-context',
            detail: `裁掉全部 ${droppedPairs} 对历史后仍需 ${used} token > 可用 ${budget.available}：预设/世界书/本次输入本身超出预算，未发起请求`,
            droppedPairs,
          };
        }
        // meta.tokens 只统计消息内容；used 含每条消息开销，单独放在 budget.used
        plan.meta.tokens = plan.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        budgetInfo = {
          context: budget.context,
          available: budget.available,
          outputReserve: budget.outputReserve,
          worldTokens: worldBudget,
          used,
          droppedPairs,
          estimated: true,
        };
        plan.meta.budget = budgetInfo;
        if (droppedPairs) plan.meta.notes.push(`历史按成对裁减 ${droppedPairs} 对（只裁作品历史，不动预设/@D/本次输入）以满足预算 ${budget.available}`);
      }

      // 插件自有的 Chat Completions transport：保留 plan.messages 的 role/顺序
      if (route.transport === 'chat') {
        if (typeof chatTransport !== 'function') {
          return { ok: false, code: 'transport/unavailable', detail: '本机没有可用的 chat-completions transport' };
        }
        const transported = await chatTransport({
          route,
          plan,
          // 与实际预算同一个值：不做"预算预留了输出、请求却不带上限"的事
          maxTokens: maxTokens ?? settings.maxTokens,
          temperature: temperature ?? settings.temperature,
          signal,
        });
        if (!transported?.ok) {
          return {
            ok: false,
            code: signal?.aborted ? 'aborted' : 'chat/not-stop',
            detail: `chat/completions 未正常结束（finish=${transported?.finish ?? 'unknown'}）${transported?.status ? ` status=${transported.status}` : ''}，正文未保存`,
            finish: transported?.finish ?? null,
            evidence: transported?.evidence ?? null,
          };
        }
        // 上游刚返回也要再确认一次：取消后绝不落盘
        if (signal?.aborted) {
          return { ok: false, code: 'aborted', detail: '已取消，正文未保存', evidence: transported.evidence ?? null };
        }
        if (save) {
          await workStore.append(id, [
            { role: 'user', content: text },
            { role: 'assistant', content: transported.content },
          ]);
        }
        return {
          ok: true,
          text: transported.content,
          detail: `work=${id} transport=chat provider=${route.provider} messages=${transported.evidence?.length ?? 0} roles=${(transported.evidence ?? []).map((item) => item.role).join(',')} depthBlocks=${plan.meta.depthBlocks} droppedPairs=${budgetInfo?.droppedPairs ?? 0}`,
          usage: transported.usage ?? null,
          meta: { ...plan.meta, budget: budgetInfo, evidence: transported.evidence ?? null },
        };
      }

      if (!llm || typeof llm.stream !== 'function') {
        return { ok: false, code: 'llm/unavailable', detail: 'llm 服务不可用' };
      }
      const result = await streamGeneration({
        llm,
        provider: route.provider,
        model: route.model,
        plan,
        temperature: temperature ?? settings.temperature,
        maxTokens: maxTokens ?? settings.maxTokens,
        signal,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: signal?.aborted ? 'aborted' : 'finish/not-stop',
          detail: `生成未完成（finish=${JSON.stringify(result.finish)}），正文未保存`,
          finish: result.finish,
          roles: result.request.roles,
        };
      }
      if (save) {
        await workStore.append(id, [
          { role: 'user', content: text },
          { role: 'assistant', content: result.text },
        ]);
      }
      return {
        ok: true,
        text: result.text,
        detail: `work=${id} messages=${result.request.messages} roles=${result.request.roles.join(',')} depthBlocks=${plan.meta.depthBlocks} omitted=${plan.meta.omitted.length} droppedPairs=${budgetInfo?.droppedPairs ?? 0}`,
        usage: result.usage,
        meta: { ...plan.meta, budget: budgetInfo },
      };
    });
  } finally {
    active.delete(id);
  }
}
