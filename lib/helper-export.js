/** Respect Tavern Helper export_with without mutating the stored script tree. */
export function exportHelperFields(extensions) {
  const copy = structuredClone(extensions ?? {});
  const helper = Array.isArray(copy.tavern_helper) ? Object.fromEntries(copy.tavern_helper) : copy.tavern_helper;
  if (!helper || !Array.isArray(helper.scripts)) return copy;
  const clean = items => items.map(node => {
    if (node.type === 'folder') return { ...node, scripts: clean(node.scripts ?? []) };
    const script = { ...node };
    if (node.export_with?.data === false) script.data = {};
    if (node.export_with?.button === false && node.button) script.button = { ...node.button, buttons: [] };
    return script;
  });
  helper.scripts = clean(helper.scripts);
  copy.tavern_helper = Array.isArray(copy.tavern_helper) ? Object.entries(helper) : helper;
  return copy;
}
