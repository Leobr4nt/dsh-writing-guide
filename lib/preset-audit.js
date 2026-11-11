/**
 * 预设兼容性审计（只读、不执行任何脚本）。
 *
 * 目的：导入 ST 社区预设时，告诉用户哪些能用、哪些只是保留数据。
 * 绝不执行 regex_scripts / tavern_helper / SPreset 里的任何逻辑。
 */

import { DATA_MACROS } from './macros.js';
const MACRO_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=::|\}\})/g;

/** 我们真实支持的宏（其余保留原文）。 */
export const SUPPORTED_MACROS = new Set(['char', 'user', 'original', ...DATA_MACROS, 'trim']);

/** 已实现的 marker（与 preset.js 的 SUPPORTED_MARKERS 对齐）。 */
const SUPPORTED_MARKERS = new Set([
  'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario',
  'personaDescription', 'dialogueExamples', 'chatHistory',
]);

export function auditPreset(payload) {
  const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
  const order = payload?.prompt_order?.[0]?.order ?? [];
  const enabled = order.filter((row) => row?.enabled !== false);
  const orderIds = new Set(order.map((row) => row.identifier));
  const promptIds = new Set(prompts.map((prompt) => prompt.identifier));

  const macroCounts = {};
  let macroHits = 0;
  for (const prompt of prompts) {
    const text = String(prompt?.content ?? '');
    let match;
    MACRO_RE.lastIndex = 0;
    while ((match = MACRO_RE.exec(text))) {
      macroHits += 1;
      const name = match[1].split('::')[0].trim();
      macroCounts[name] = (macroCounts[name] ?? 0) + 1;
    }
  }
  const macros = Object.entries(macroCounts).sort((a, b) => b[1] - a[1]);
  const unsupportedMacros = macros.filter(([name]) => !SUPPORTED_MACROS.has(name));

  const markers = prompts.filter((prompt) => prompt?.marker).map((prompt) => prompt.identifier);
  const unsupportedMarkers = markers.filter((id) => !SUPPORTED_MARKERS.has(id));

  const ext = payload?.extensions ?? {};
  const regexScripts = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
  const helper = ext.tavern_helper ?? {};
  const helperScripts = Array.isArray(helper.scripts) ? helper.scripts : [];
  const helperCodeBytes = helperScripts.reduce((sum, script) => sum + Buffer.byteLength(String(script?.content ?? ''), 'utf8'), 0);
  const spreset = ext.SPreset ?? {};

  return {
    counts: {
      prompts: prompts.length,
      ordered: order.length,
      enabled: enabled.length,
      disabled: order.length - enabled.length,
      unlisted: [...promptIds].filter((id) => !orderIds.has(id)).length,
      missing: [...orderIds].filter((id) => !promptIds.has(id)).length,
    },
    markers: { supported: markers.filter((id) => SUPPORTED_MARKERS.has(id)), unsupported: unsupportedMarkers },
    macros: {
      hits: macroHits,
      supported: macros.filter(([name]) => SUPPORTED_MACROS.has(name)),
      unsupported: unsupportedMacros,
    },
    extensions: {
      present: Object.keys(ext),
      regexScripts: { count: regexScripts.length, enabled: regexScripts.filter((s) => s?.disabled !== true).length },
      tavernHelper: { scripts: helperScripts.length, codeBytes: helperCodeBytes, variables: Object.keys(helper.variables ?? {}).length },
      spreset: Object.keys(spreset),
    },
    /** 直接可用的部分 */
    usable: ['prompts 文本（按 prompt_order/enabled 执行）', '8 个 marker 位置', 'role 与 injection_position', '普通宏的聊天变量在正常写作会话中持久化；生成成功后保存，失败/取消不提交'],
    /** 只有部分语义 */
    partial: [
      ...(unsupportedMacros.length ? [`宏 ${unsupportedMacros.map(([name]) => name).join('/')}：保留原文，不解析变量`] : []),
      '聊天本地宏变量已持久化，成功生成后保存；跨聊天全局宏、变量简写和索引宏尚未实现',
      ...(helperScripts.length ? ['酒馆助手：开启常驻运行及对应来源后支持部分脚本、事件、MVU 和按钮；仍有未实现接口，非完整酒馆兼容'] : []),
      ...(regexScripts.length ? ['正则：发送处理与显示处理分开；在同一会话的“写作阅读”查看隐藏、美化效果，原始对话保持不变'] : []),
      'EJS 模板需在扩展页为当前预设启用；仅处理配置材料，不执行用户或助手历史中的代码',
      '采样参数：保存但不照搬（请求上限取写作配置，只发 temperature）',
    ],
    /** 仅保留数据，不执行 */
    unsupported: [
      ...(spreset.LogUpload?.enabled ? ['SPreset LogUpload：不自动上传聊天或脚本日志'] : []),
      ...(spreset.ForcedPostProcessing?.enabled&&!['','merge','merge_tools','claude','single','semi','semi_tools','strict','strict_tools'].includes(spreset.ForcedPostProcessing.mode)?['SPreset 所选角色后处理模式尚未实现，启用时明确报错']:[]),
    ],
    spreset: Object.keys(spreset).length?{
      supported:['RegexBinding','ChatSquash','MacroNest（受支持的数据宏）','MessageInjections（OpenAI兼容工具历史）','OutputPreprocessing（整段）','ToolBindings（隔离纯函数）','FixedPresetName','ForcedPostProcessing（merge/semi/strict/single）','FinalRequestProcessing'],
      limitations:['处理脚本不能访问网络、文件或DSH凭证','流式输出、条目条件脚本、内联HyperPrompt正则、完整工具生命周期和所有provider签名转换未实现'],
    }:null,
  };
}

/** 给导入结果附加一段人类可读提示。 */
export function describeCompat(compat) {
  const lines = [];
  lines.push(`可用：${compat.usable.join('；')}`);
  if (compat.partial.length) lines.push(`部分：${compat.partial.join('；')}`);
  if (compat.unsupported.length) lines.push(`仅保留数据：${compat.unsupported.join('；')}`);
  return lines.join('\n');
}
