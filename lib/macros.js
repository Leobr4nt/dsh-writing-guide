/**
 * 受限数据宏：{{setvar::k::v}} {{getvar::k}} {{random::a::b}}
 *
 * 只做数据替换，不执行任何 JS。
 * 语义（对齐 ST 传统宏引擎的**可见行为**，属于有意限制）：
 *   - random 从 `::` 分隔的**候选项**选一个（不发明 range）
 *   - getvar 未定义为空；setvar 返回空；同名再 setvar 覆盖
 *   - 求值顺序：**最左最内层**逐个处理，因此 `{{setvar::x::{{random::a::b}}}}` 先内层 random 再赋值，
 *     后面的 `{{getvar::x}}` 能读到；未知/非数据宏原样保留并跳过，不阻塞后续宏
 *   - 作用域每次组装新建；random 用确定性 seed，同一请求重建结果稳定
 *   - char/user/original/if/unless/trim 不在这里处理，仍由 renderStoryString 负责
 */

export const DATA_MACROS = new Set(['setvar', 'getvar', 'random']);

function hashSeed(seed) {
  const text = String(seed ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export function createMacroScope({ seed = '' } = {}) {
  return { vars: new Map(), unknown: new Set(), rng: makeRng(seed), seed: String(seed ?? '') };
}

export function evalMacro(body, scope) {
  const parts = String(body ?? '').split('::');
  const name = parts[0].trim();
  const args = parts.slice(1);
  switch (name) {
    case 'getvar': {
      const key = String(args[0] ?? '').trim();
      return scope.vars.has(key) ? String(scope.vars.get(key)) : '';
    }
    case 'setvar': {
      const key = String(args[0] ?? '').trim();
      const value = args.slice(1).join('::');
      if (key) scope.vars.set(key, value);
      return '';
    }
    case 'random': {
      if (!args.length) return '';
      const index = Math.floor(scope.rng() * args.length);
      return String(args[Math.min(index, args.length - 1)] ?? '');
    }
    default:
      scope.unknown.add(name);
      return `{{${body}}}`;
  }
}

/** 最左最内层逐个执行；非数据宏原样跳过。 */
export function renderMacros(text, scope) {
  let out = String(text ?? '');
  let cursor = 0;
  let replacedThisPass = false;
  for (let guard = 0; guard < 1000; guard += 1) {
    const re = /{{([^{}]*)}}/g;
    re.lastIndex = cursor;
    const match = re.exec(out);
    if (!match) {
      // 一轮扫完没有发生任何替换 → 只剩非数据宏，直接结束（不再空转）
      if (!replacedThisPass) break;
      replacedThisPass = false;
      cursor = 0;
      continue;
    }
    const name = String(match[1]).split('::')[0].trim();
    if (!DATA_MACROS.has(name)) {
      cursor = match.index + match[0].length;
      continue;
    }
    const replacement = evalMacro(match[1], scope);
    out = out.slice(0, match.index) + replacement + out.slice(match.index + match[0].length);
    replacedThisPass = true;
    cursor = 0;   // 替换后从头重扫，保证 setvar 先于其后的 getvar
  }
  return out;
}
