import { selectWritingWorlds } from './card-lore.js';
import { ExtensionScopes } from './extension-scopes.js';
/**
 * 写作模式的会话内接管（llm/stream）。
 *
 * 与 writer 共用的原则：预算与请求用**同一个**输出上限；当前输入固定不裁；
 * 只裁当前输入之前的完整 user/assistant 对；取消在开始/读数据后/返回前各查一次。
 */
import { collectHits } from './lore.js';
import { buildPlan } from './plan.js';
import { messageEvidence } from './chat-transport.js';
import { estimateTokens, resolveBudget } from './budget.js';
import { resolveCardPrompts, parseExampleMessages, pickGreeting } from './cards.js';
import { createMacroScope, macroVariables } from './macros.js';
import { PLACEMENT, runBatchSafe } from './regex-engine.js';
import { fitHistoryRows } from './history-fit.js';
import {applySPresetRequest} from './spreset.js';
import {normalizeRequestTimeoutSeconds} from './request-timeout.js';
import {normalizeUserName} from './name-macros.js';

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('');
  return '';
};

export function detectToolHistory(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (message?.role === 'tool') return true;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return blocks.some((block) => block?.type === 'tool-call');
  });
}

/** 只保留真实用户输入与普通助手文本（按 DSH 的 message.source 过滤）。 */
export function conversationOf(messages) {
  const rows = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role === 'user') {
      if (message?.source?.kind !== 'user') continue;
      const text = textOf(message).trim();
      if (text) rows.push({ role: 'user', content: text });
      continue;
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      if (blocks.some((block) => block?.type === 'tool-call')) continue;
      const text = textOf(message).trim();
      if (text) rows.push({ role: 'assistant', content: text });
    }
  }
  return rows;
}

export function isAuxiliaryRequest(purpose) {
  const value = String(purpose ?? '');
  if (!value) return false;
  return !['agent-loop', 'chat', 'conversation'].includes(value);
}

/** 有效输出上限：写作设置与实际请求取更严格的一侧（0/缺省表示不限）。 */
export function effectiveMaxTokens(...values) {
  const list = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return list.length ? Math.min(...list) : 0;
}

const DECISIONS_LIMIT = 32;

export function createSessionHook({ store, bindings, transport, log, diagnostics, llm, extensionStore = null, runTemplateBatch = null, scopes = null, residentManager = null }) {
  const scopeService = scopes ?? (extensionStore ? new ExtensionScopes({store,extensionStore}) : null);
  /** 决策缓存：key = sessionId|userMessageId|绑定版本；有界，会话销毁时清理。 */
  const decisionsCache = new Map();
  // Private transaction state must never be serialized into plan.meta or preview diagnostics.
  const pendingVariables = new WeakMap();
  const decisionsFor = (sessionId, binding, options) => {
    const lastUser = (options?.messages ?? []).filter((message) => message?.role === 'user' && message?.source?.kind === 'user').at(-1);
    const version = JSON.stringify([binding.presetId, binding.worldIds, binding.cardId, binding.provider, binding.model, binding.userName]);
    const key = `${sessionId}|${lastUser?.id ?? 'anon'}|?v=${version}`;
    if (decisionsCache.has(key)) return decisionsCache.get(key);
    const fresh = new Map();
    if (decisionsCache.size >= DECISIONS_LIMIT) decisionsCache.delete(decisionsCache.keys().next().value);
    decisionsCache.set(key, fresh);
    return fresh;
  };
  /**
   * 正则只作用于**真实对话**（conversationOf 之后的 user/assistant 楼层），
   * 预设里的 user/assistant 提示词、system 段都不参与。
   * 两阶段：
   *   source/raw 阶段 → 只跑 neither-only 规则（既不 promptOnly 也不 markdownOnly）
   *   prompt 阶段     → 只跑 promptOnly 规则（isPrompt=true）
   * 每阶段顺序执行、结果作为下一阶段输入，单次转换不重复累积。
   * depth 按真实消息数从末尾计（最后一条 = 0）。
   * 世界书条目（placement 5）本次不处理，明确标注未支持。
   */
  async function applyRegexToConversation(conversation, { preset, card, user, signal }) {
    if(!extensionStore)return {conversation,applied:0,notes:[]};
    const {regex:scripts}=await scopeService.resolve({presetId:preset?.id??'',cardId:card?.id??''});
    if(!scripts.some(s=>!s.disabled))return {conversation,applied:0,notes:[]};
    let rows=conversation.map(m=>({...m})),applied=0;
    for(const isPrompt of [false,true]) {
      const inputs=rows.map((m,index)=>({index,text:m.content,scene:{placement:m.role==='user'?1:2,depth:rows.length-1-index,isPrompt}}));
      const result=await runBatchSafe({scripts,inputs,scene:{char:card?.name??'',user},signal});
      if(!result.ok) { const bad=result.results?.find(r=>!r.ok);throw new Error('正则处理失败：'+(result.message??bad?.message??result.code)); }
      rows=result.results.map(r=>{applied+=r.applied?.length??0;return {...rows[r.index],content:r.output};});
    }
    return {conversation:rows,applied,notes:[]};
  }

  async function buildPlanFor({ binding, settings, card, conversation, decisions, macroSeed, macroSeedSession, templateSnapshot = null, signal, resident = null }) {
    const user = normalizeUserName(binding.userName);
    const includeWorlds = settings.includeWorlds !== false;
    const includePreset = settings.includePreset !== false;
    const selection = binding.worldSelection ?? ((binding.worldIds ?? []).length ? 'selected' : 'all');
    const basePreset = includePreset && binding.presetId ? await store.getPreset(binding.presetId) : null;
    const mainPrompt = basePreset?.prompts?.find((prompt) => prompt.identifier === 'main');
    const phiPrompt = basePreset?.prompts?.find((prompt) => prompt.identifier === 'jailbreak' || prompt.identifier === 'phi');
    const resolved = resolveCardPrompts(card, {
      user,
      originalSystem: mainPrompt?.content ?? '',
      originalPostHistory: phiPrompt?.content ?? '',
    });

    const allWorlds = resident?.worlds ?? await store.listWorlds();
    const {books,missingWorlds}=selectWritingWorlds({allWorlds,binding,card,includeWorlds});

    const scanText = conversation.slice(-Math.max(1, Number(settings.scanDepth) || 2))
      .map((row) => row.content).join('\n');
    const hits = books.length
      ? collectHits({ books, scanText, decisions, maxRecursionSteps: Number(settings.maxRecursionSteps ?? 0) })
      : { buckets: { before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [], atDepth: [], outlet: {} }, count: 0, decisions: new Map() };

    let preset = basePreset;
    if (preset && (resolved.replacedSystem || resolved.replacedPostHistory)) {
      preset = {
        ...preset,
        prompts: preset.prompts.map((prompt) => {
          if (prompt.identifier === 'main' && resolved.replacedSystem) return { ...prompt, content: resolved.system };
          if ((prompt.identifier === 'jailbreak' || prompt.identifier === 'phi') && resolved.replacedPostHistory) {
            return { ...prompt, content: resolved.postHistory };
          }
          return prompt;
        }),
      };
    }

    // 卡片字段由预设 marker 控制顺序（charDescription / charPersonality / scenario）
    const examples = card ? parseExampleMessages(card.mesExample, { char: card.name, user }) : [];
    const vars = {
      ...(settings.vars ?? {}),
      char: card?.name ?? '',
      user,

      ...(card?.description ? { description: card.description } : {}),
      ...(card?.personality ? { personality: card.personality } : {}),
      ...(card?.scenario ? { scenario: card.scenario } : {}),
    };

    const macroScope=createMacroScope({seed:macroSeed??'',variables:resident?.chatVariables??templateSnapshot?.vars??{}});
    const plan = buildPlan({
      preset: preset ?? { id: '', name: '', prompts: [], prompt_order: [{ order: [] }] },
      hits,
      vars,
      authorNote: binding.authorNote ?? settings.authorNote ?? '',
      conversation,
      exampleMessages: examples,
      // 每次 build 都用同一 seed 新建作用域：同一请求内重建（预算裁剪）random 稳定，
      // 不同请求（不同 user 消息）各自独立。
      macroScope,
      budgetTokens: Number(settings.worldBudgetTokens ?? 0),
      maxChars: Number(settings.maxChars ?? 0),
      mergeSystem: false,
    });
    const macroVars=macroVariables(macroScope);
    if(resident)await resident.stageVariables(macroVars);
    else if(macroScope.mutations)pendingVariables.set(plan,{variables:macroVars,messageVariables:templateSnapshot?.messageVars??{}});
    plan.meta.worldBookIds=books.map(book=>book.id);
    plan.meta.missingWorlds = missingWorlds;
    if (missingWorlds.length) plan.meta.notes.push(`绑定的世界书不存在：${missingWorlds.join(', ')}（不会自动换成全部）`);
    plan.meta.usedEntries = [...new Set(
      Object.values(hits.buckets ?? {})
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map((ref) => String(ref?.key ?? ''))
        .filter(Boolean),
    )];

    // 模板：只对 templateIndexes（预设/卡片/世界书生成的消息）渲染，真实历史不参与
    if (typeof runTemplateBatch === 'function' && extensionStore && typeof extensionStore.load === 'function') {
      let templateState = null;
      try { templateState = (await extensionStore.load())?.template ?? null; } catch { templateState = null; }
      const allowed = Array.isArray(templateState?.allowedPresetIds) ? templateState.allowedPresetIds : [];
      const enabled = templateState?.enabled === true && allowed.includes(binding.presetId ?? '');
      const indexes = Array.isArray(plan.meta.templateIndexes) ? plan.meta.templateIndexes : [];
      if (enabled && indexes.length) {
        try {
          // 用 handle 开始时读到的**同一份快照**（含 version），预算重建不重新 load
          const snapshot = macroVars;
          const texts = indexes.map((index) => plan.messages[index]?.content ?? '');
          const result = resident
            ? { texts: await resident.render(texts,{char:card?.name??'',user,model:binding.model??''},macroVars) }
            : await runTemplateBatch({
            texts,
            variables: snapshot ?? {},
            messageVariables: templateSnapshot?.messageVars ?? {},
            globalVariables: templateSnapshot?.residentState?.variables?.global ?? {},
            context: {
              char: card?.name ?? '',
              user,
              model: binding.model ?? '',
              chatMessages: conversation,
            },
            seed: macroSeed ?? '',
            signal,
          });
          if (Array.isArray(result?.texts)) {
            indexes.forEach((index, offset) => {
              if (typeof result.texts[offset] === 'string') {
                const original=plan.messages[index],updated={...original,content:result.texts[offset]};
                if(original.promptId!==undefined)Object.defineProperty(updated,'promptId',{value:original.promptId});
                plan.messages[index]=updated;
              }
            });
            plan.meta.templateRendered = indexes.length;
            if (!resident) pendingVariables.set(plan,{
              variables: result.variables ?? {},
              messageVariables: result.messageVariables ?? {},
            });
            plan.meta.notes.push(`已渲染 ${indexes.length} 条模板（真实历史不参与）`);
          }
        } catch (error) {
          // 失败必须终止本次生成，不能把原始 EJS 发给模型
          plan.meta.templateError = String(error?.message ?? error).slice(0, 160);
          plan.meta.notes.push(`模板渲染失败：${plan.meta.templateError}`);
        }
      }
    }
    await applySPresetRequest(plan,basePreset,{char:card?.name??'',user,signal});
    return plan;
  }

  /**
   * 有效输出上限/上下文：只认**实际写作 route** 的 metadata；
   * 用户设置更小则取更小；都没有 → 产品保守默认 4096，不拿宿主的 256000。
   */
  async function resolveCaps(binding, settings) {
    let info = null;
    try { info = (await llm?.resolveModelInfo?.(binding.provider, binding.model)) ?? null; } catch { info = null; }
    const modelMax = Number(info?.defaultMaxTokens ?? 0) || 0;
    const modelContext = Number(info?.context?.contextWindow ?? 0) || 0;
    // The writing configuration is saved on the binding, independently of global settings.
    const bindingMax = Number(binding.maxTokens);
    const bindingContext = Number(binding.contextWindow);
    const userMax = Number.isFinite(bindingMax) && bindingMax > 0
      ? bindingMax : Number(settings.maxTokens ?? 0) || 0;
    const userContext = Number.isFinite(bindingContext) && bindingContext > 0
      ? bindingContext : Number(settings.contextWindow ?? 0) || 0;
    const pick = (...values) => {
      const list = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
      return list.length ? Math.min(...list) : 0;
    };
    // 0/未设 = 产品默认 4096；模型声明更小则取更小，声明更大也不放大到模型上限
    const base = userMax > 0 ? userMax : 4096;
    const cap = modelMax > 0 ? Math.min(base, modelMax) : base;
    const context = pick(userContext, modelContext);
    return {
      cap,
      context,
      contextKnown: context > 0,
      source: { modelMax, modelContext, userMax, userContext },
    };
  }

  const measure = (plan, budget) => plan.messages
    .reduce((sum, message) => sum + estimateTokens(message.content) + budget.perMessage, 0);

  const handle = async function* (options, sessionId, binding) {
    const aborted = () => Boolean(options?.signal?.aborted);
    const user = normalizeUserName(binding.userName);
    const requestTimeoutSeconds = normalizeRequestTimeoutSeconds(binding.requestTimeoutSeconds);
    diagnostics.set(sessionId, { at: new Date().toISOString(), source: 'session-hook', writingRoute: `${binding.provider}/${binding.model}`, requestTimeoutSeconds, ok: null, phase: 'preparing', requestSent: false });
    const bail = (code, message, kind = 'error') => {
      diagnostics.set(sessionId, { ...diagnostics.get(sessionId), ok: false, phase: kind === 'aborted' ? 'aborted' : 'failed', error: { code, message }, finishedAt: new Date().toISOString() });
      return {
      type: 'finish',
      reason: kind === 'aborted'
        ? { kind: 'aborted', failure: { message, code } }
        : { kind: 'error', failure: { message, code } },
      };
    };

    let resident = null;
    try {
    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }
    if (binding.presetId && !(await store.getPreset(binding.presetId))) {
      yield bail('WRITING_GUIDE_BAD_BINDING', `写作配置无效：找不到预设 ${binding.presetId}`);
      return;
    }
    if (!binding.provider || !binding.model) {
      yield bail('WRITING_GUIDE_BAD_BINDING', '写作配置无效：缺少端点模型');
      return;
    }
    if (binding.cardId && !(await store.getCard(binding.cardId))) {
      yield bail('WRITING_GUIDE_BAD_BINDING', `写作配置无效：找不到角色卡 ${binding.cardId}`);
      return;
    }
    if (detectToolHistory(options?.messages)) {
      yield bail('WRITING_GUIDE_TOOL_HISTORY', '写作模式不支持含工具调用的历史；请在新会话里继续');
      return;
    }
    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }

    const settings = await store.loadSettings();
    const card = binding.cardId ? await store.getCard(binding.cardId) : null;
    let conversation = conversationOf(options?.messages);
    if(residentManager)resident=await residentManager.prepare({sessionId,binding,card,conversation,signal:options?.signal});
    const regexNotes = [];
    try {
      const regexed = await applyRegexToConversation(conversation, { preset: await (binding.presetId ? store.getPreset(binding.presetId) : null), card: binding.cardId ? await store.getCard(binding.cardId) : null, user, signal: options?.signal });
      conversation = regexed.conversation;
      regexNotes.push(...regexed.notes);
      if (regexed.applied) regexNotes.push(`已应用 ${regexed.applied} 条正则（仅真实对话的发送副本）`);
    } catch (error) {
      const message=String(error?.message??error).slice(0,160);
      diagnostics.set(sessionId,{...diagnostics.get(sessionId),finish:'error'});
      yield bail('WRITING_GUIDE_REGEX', message); return;
    }

    // 开场白：明确的开场白上下文种子，只在历史最前出现一次；示例对话走 dialogueExamples marker
    const seeds = [];
    if (card) {
      const greeting = pickGreeting(card, {user});
      if (greeting) seeds.push({ role: 'assistant', content: greeting });
    }
    const decisions = decisionsFor(sessionId, binding, options);
    const lastUserMessage = (options?.messages ?? []).filter((message) => message?.role === 'user' && message?.source?.kind === 'user').at(-1);
    const macroSeed = [
      sessionId,
      String(lastUserMessage?.id ?? ''),
      binding.presetId ?? '',
      binding.model ?? '',
    ].join('|');
    let templateSnapshot = null;
    if (extensionStore && typeof extensionStore.sessionVars === 'function') {
      try { templateSnapshot = await extensionStore.sessionVars(sessionId); } catch(error) { yield bail('WRITING_GUIDE_VARIABLES',String(error?.message??error));return; }
    }
    const buildWith = (rows) => buildPlanFor({ binding, settings, card, conversation: [...seeds, ...rows], decisions, macroSeed, macroSeedSession: sessionId, templateSnapshot, signal: options?.signal, resident });

    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }

    // 当前输入固定：只有它之前的历史可以成对裁减
    const last = conversation.at(-1);
    const current = last && last.role === 'user' ? last : null;
    const historyRows = current ? conversation.slice(0, -1) : conversation.slice();

    const caps = await resolveCaps(binding, settings);
    const outputCap = caps.cap;
    const budget = resolveBudget({
      contextWindow: caps.context,
      maxOutput: outputCap,
      percent: Number(settings.worldBudgetPercent ?? 25),
    });

    let plan = await buildWith(historyRows.concat(current ? [current] : []));
    if (regexNotes.length) plan.meta.notes.push(...regexNotes);
    if (plan.meta.templateError) {
      diagnostics.set(sessionId, { ...diagnostics.get(sessionId), finish: 'error' });
      yield bail('WRITING_GUIDE_TEMPLATE', `模板渲染失败，已终止本次生成：${plan.meta.templateError}`);
      return;
    }
    if (budget.context > 0) {
      if (budget.available <= 0) {
        yield bail('WRITING_GUIDE_BUDGET', `上下文 ${budget.context} 已被输出预留 ${outputCap} 占满`);
        return;
      }
      if (current) {
        const inputCost = estimateTokens(current.content) + budget.perMessage;
        if (inputCost > budget.available) {
          yield bail('WRITING_GUIDE_BUDGET', `本次输入约 ${inputCost} token，超出可用预算 ${budget.available}；未发起请求`);
          return;
        }
      }
      const fit = await fitHistoryRows({
        history: historyRows,
        build: (rows) => buildWith(rows.concat(current ? [current] : [])),
        measure: (candidate) => measure(candidate, budget),
        budget,
      });
      plan = fit.plan;
      const used = fit.used;
      const droppedPairs = fit.droppedPairs;
      if (fit.rejected) {
        yield bail('WRITING_GUIDE_BUDGET', `预设/世界书/本次输入本身超出预算（需要 ${used} > ${budget.available}）`);
        return;
      }
      plan.meta.budget = { context: budget.context, available: budget.available, used, droppedPairs, outputCap, estimated: true };
    }

    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }

    if (plan.meta.templateError) { yield bail('WRITING_GUIDE_TEMPLATE', plan.meta.templateError); return; }
    const evidence = messageEvidence(plan.messages);
    const baseDiagnostics = {
      at: new Date().toISOString(),
      source: 'session-hook',
      hostRoute: `${options?.provider ?? ''}/${options?.model ?? ''}`,
      writingRoute: `${binding.provider}/${binding.model}`,
      presetId: binding.presetId || null,
      worldIds: binding.worldIds,
      effectiveWorldIds: plan.meta.worldBookIds ?? [],
      missingWorlds: plan.meta.missingWorlds ?? [],
      entries: (plan.meta.usedEntries ?? []).slice(0, 40),
      roles: evidence.map((item) => item.role),
      messages: evidence.length,
      depthBlocks: plan.meta.depthBlocks,
      droppedPairs: plan.meta.budget?.droppedPairs ?? 0,
      outputCap,
      requestTimeoutSeconds,
      requestSent: false,
      contextKnown: caps.contextKnown,
      context: caps.context,
      card: card ? `${card.name}（${card.spec}）` : null,
    };
    // 请求发出前先落 pending：超时/异常也能看到这次发生过什么
    diagnostics.set(sessionId, { ...baseDiagnostics, ok: null, finish: 'pending', phase: 'preparing' });

    let result;
    try {
      result = await transport({
        route: { provider: binding.provider, model: binding.model },
        plan,
        maxTokens: outputCap || undefined,
        timeoutMs: requestTimeoutSeconds * 1000,
        temperature: options?.temperature ?? settings.temperature,
        signal: options?.signal,
        onRequest: (sentEvidence) => {
          baseDiagnostics.requestSent = true;
          baseDiagnostics.roles = sentEvidence.map(item => item.role);
          baseDiagnostics.messages = sentEvidence.length;
          diagnostics.set(sessionId, { ...baseDiagnostics, ok: null, finish: 'pending', phase: 'requesting' });
        },
      });
    } catch (error) {
      const code = String(error?.code ?? 'WRITING_GUIDE_FAILED');
      const message = String(error?.message ?? '写作端点失败').slice(0, 160);
      diagnostics.set(sessionId, {
        ...baseDiagnostics,
        ok: false,
        finish: 'error',
        phase: 'failed',
        error: { code, message },
        finishedAt: new Date().toISOString(),
      });
      yield bail(code, message, code.toUpperCase() === 'ABORTED' ? 'aborted' : 'error');
      return;
    }

    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }
    let residentStatus=null;
    if(result?.ok&&resident){const completed=await resident.complete(result.content);residentStatus=completed.status;result={...result,content:completed.content};}
    const usedEntries = plan.meta.usedEntries ?? [];

    // Ordinary macros and EJS share one commit and one optimistic version check.
    const pending=pendingVariables.get(plan);
    if (result?.ok && pending && extensionStore && typeof extensionStore.saveSessionVars === 'function') {
      try {
        await extensionStore.saveSessionVars(sessionId, {
          vars: pending.variables ?? templateSnapshot?.vars ?? {},
          messageVars: pending.messageVariables ?? templateSnapshot?.messageVars ?? {},
          scriptVars: templateSnapshot?.scriptVars ?? {},
          expectedVersion: templateSnapshot?.version,
          signal: options?.signal,
        });
      } catch (error) {
        yield bail(aborted()?'ABORTED':'WRITING_GUIDE_VARIABLE_CONFLICT',aborted()?'已取消，变量未保存':'会话变量保存失败或已被修改，请重试',aborted()?'aborted':'error');
        return;
      }
    }

    diagnostics.set(sessionId, {
      ...baseDiagnostics,
      at: new Date().toISOString(),
      source: 'session-hook',
      hostRoute: `${options?.provider ?? ''}/${options?.model ?? ''}`,
      writingRoute: `${binding.provider}/${binding.model}`,
      presetId: binding.presetId || null,
      worldIds: binding.worldIds,
      missingWorlds: plan.meta.missingWorlds ?? [],
      entries: usedEntries.slice(0, 40),
      cardFields: card ? {
        description: Boolean(card.description),
        personality: Boolean(card.personality),
        scenario: Boolean(card.scenario),
        mesExample: Boolean(card.mesExample),
        systemPrompt: Boolean(card.systemPrompt),
        postHistory: Boolean(card.postHistoryInstructions),
        book: Boolean(card.characterBook),
        greeting: Boolean(pickGreeting(card)),
      } : null,
      contextKnown: caps.contextKnown,
      context: caps.context,
      card: card ? `${card.name}（${card.spec}）` : null,
      roles: baseDiagnostics.roles,
      messages: baseDiagnostics.messages,
      depthBlocks: plan.meta.depthBlocks,
      droppedPairs: plan.meta.budget?.droppedPairs ?? 0,
      outputCap,
      spreset:plan.meta.spreset,
      finish: result?.finish ?? null,
      ok: Boolean(result?.ok),
      phase: result?.ok ? 'completed' : 'failed',
      resident: residentStatus,
      templateRendered: plan.meta.templateRendered ?? 0,
    });

    if (aborted()) { yield bail('ABORTED', '已取消', 'aborted'); return; }
    if (!result?.ok) {
      const failure = result?.finish === 'length'
        ? { code: 'WRITING_GUIDE_OUTPUT_LIMIT', message: `输出达到当前上限（${outputCap} token），本轮未保存。请在写作配置中提高输出长度后重试。` }
        : { code: 'WRITING_GUIDE_FAILED', message: `写作端点未正常结束（finish=${result?.finish ?? 'unknown'}）` };
      diagnostics.set(sessionId, { ...diagnostics.get(sessionId), phase: 'failed', error: failure });
      yield bail(failure.code, failure.message);
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: result.content };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: result.content } };
    if (result.usage) yield { type: 'usage', usage: result.usage };
    yield { type: 'finish', reason: { kind: 'stop' } };
    } catch(error) { yield aborted()?bail('ABORTED','已取消','aborted'):bail('WRITING_EXTENSION_FAILED','扩展运行未完成，请查看兼容性状态'); }
    finally { await resident?.finish(); }
  };

  /** 会话销毁时清理该会话的决策缓存；返回清理条数。 */
  handle.clearSession = (sessionId) => {
    const id = String(sessionId ?? '');
    if (!id) return 0;
    void residentManager?.close(id);
    let removed = 0;
    for (const key of [...decisionsCache.keys()]) {
      if (key.startsWith(`${id}|`)) { decisionsCache.delete(key); removed += 1; }
    }
    return removed;
  };

  return handle;
}

export function registerSessionHook({ ctx, store, bindings, transport, log, diagnostics, sessions, agentPresets, isEnabled, llm, extensionStore = null, runTemplateBatch = null, scopes = null, residentManager = null }) {
  const handler = createSessionHook({ store, bindings, transport, log, diagnostics, llm, extensionStore, runTemplateBatch, scopes, residentManager });

  const presetOf = (sessionId) => {
    let presetId = null;
    try {
      const session = sessions?.get?.(sessionId);
      if (session && typeof agentPresets?.presetForSession === 'function') {
        presetId = agentPresets.presetForSession(session) ?? null;
      }
    } catch (error) {
      log?.(`presetForSession failed for ${sessionId}: ${error?.message ?? error}`);
    }
    return presetId;
  };

  ctx.on?.('session/disposed', (session) => {
    const id = String(session?.id ?? '');
    if (!id) return;
    try {
      handler.clearSession?.(id);
    } catch (error) {
      log?.(`clearSession failed for ${id}: ${error?.message ?? error}`);
    }
  });

  return ctx.on('llm/stream', (options, next) => {
    let sessionId = '';
    try { sessionId = options?.sessionId ? String(options.sessionId) : ''; } catch { /* frozen */ }
    if (!sessionId) return next();
    if (typeof isEnabled === 'function' && !isEnabled()) return next();
    if (isAuxiliaryRequest(options?.purpose)) return next();
    if (presetOf(sessionId) !== 'writer') return next();
    const binding = bindings.get(sessionId) ?? bindings.defaults();
    if (!binding || binding.enabled === false) return next();
    try {
      return handler(options, sessionId, binding);
    } catch (error) {
      log?.(`session hook failed for ${sessionId}: ${error?.message ?? error}`);
      return next();
    }
  });
}
