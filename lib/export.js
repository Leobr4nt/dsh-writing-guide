/**
 * 导出：把内部实体转成 **SillyTavern 可导入**的结构。
 *
 * - 世界书：ST 的 `{ name, entries: { <uid>: {...} } }`（entries 字典形态，ST 两种都吃）
 * - 预设：ST 的 `{ name, prompts[], prompt_order[] }`
 * - 内部字段（id / modes / updatedAt）不导出；未知扩展字段（extensions 等）原层级保留
 */

const ENTRY_INTERNAL = new Set(['raw']);

const WORLD_INTERNAL = new Set(['id', 'modes', 'updatedAt', 'entries', 'raw']);

export function toStWorld(world) {
  const entries = {};
  for (const entry of world?.entries ?? []) {
    const row = {};
    for (const [key, value] of Object.entries(entry)) {
      if (ENTRY_INTERNAL.has(key)) continue;
      row[key] = value;
    }
    row.uid = entry.uid;
    entries[String(entry.uid)] = row;
  }
  // 顶层未知字段（extensions 等）原层级保留
  const out = {};
  for (const [key, value] of Object.entries(world ?? {})) {
    if (WORLD_INTERNAL.has(key)) continue;
    out[key] = value;
  }
  if (!out.name) out.name = 'world';
  out.entries = entries;
  return out;
}

const PRESET_INTERNAL = new Set(['id', 'modes', 'updatedAt', 'prompts', 'prompt_order', 'raw']);

export function toStPreset(preset) {
  // 顶层未知字段（temperature / top_p / extensions …）原层级保留
  const out = {};
  for (const [key, value] of Object.entries(preset ?? {})) {
    if (PRESET_INTERNAL.has(key)) continue;
    out[key] = value;
  }
  if (!out.name) out.name = 'preset';
  out.prompts = (preset?.prompts ?? []).map((prompt) => {
    const row = {};
    for (const [key, value] of Object.entries(prompt)) {
      if (key === 'raw') continue;
      row[key] = value;
    }
    return row;
  });
  out.prompt_order = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [{ character_id: 100000, order: [] }];
  if (preset?.settings && typeof preset.settings === 'object') out.settings = preset.settings;
  return out;
}
