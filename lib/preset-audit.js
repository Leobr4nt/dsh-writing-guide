/**
 * 预设兼容性审计（只读、不执行任何脚本）。
 *
 * 目的：导入 ST 社区预设时，告诉用户哪些能用、哪些只是保留数据。
 * 绝不执行 regex_scripts / tavern_helper / SPreset 里的任何逻辑。
 */

const MACRO_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=::|\}\})/g;

/** 我们真实支持的宏（其余保留原文）。 */
export const SUPPORTED_MACROS = new Set(['char', 'user', 'original', 'setvar', 'getvar', 'random', 'trim']);

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
    usable: ['prompts 文本（按 prompt_order/enabled 执行）', '8 个 marker 位置', 'role 与 injection_position', 'setvar/getvar/random 数据宏（含嵌套）'],
    /** 只有部分语义 */
    partial: [
      ...(unsupportedMacros.length ? [`宏 ${unsupportedMacros.map(([name]) => name).join('/')}：保留原文，不解析变量`] : []),
      '数据宏变量仅在本次组装内有效，不等同于酒馆的会话持久变量',
      ...(regexScripts.length ? ['正则：发送副本支持用户/助手消息；显示正则可预览，尚未接管正常会话正文渲染'] : []),
      'EJS 模板需在扩展页为当前预设启用；仅处理配置材料，不执行用户或助手历史中的代码',
      '采样参数：保存但不照搬（请求上限取写作配置，只发 temperature）',
    ],
    /** 仅保留数据，不执行 */
    unsupported: [
      ...(helperScripts.length ? [`tavern_helper.scripts ×${helperScripts.length}（${helperCodeBytes} 字节 JS）：导入不自动运行。可在扩展页单独导入并手动启用；仅支持隔离环境中的变量与消息读取 API，DOM/事件/网络尚未支持`] : []),
      ...(Object.keys(spreset).length ? [`SPreset（${Object.keys(spreset).join('/')}）：不执行`] : []),
    ],
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
