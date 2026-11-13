/** Full writing routing is separate from the legacy system-section targets. */
export const DEFAULT_WRITING_MODES = ['writer'];

export function normalizeWritingModes(value) {
  if (value === undefined) return [...DEFAULT_WRITING_MODES];
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string').map(id => id.trim()).filter(id => id && id !== '*'))] : [];
}

export function isWritingMode(settings, mode) {
  return typeof mode === 'string' && !!mode && normalizeWritingModes(settings?.writingModes).includes(mode);
}
