export function normalizeUserName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '用户';
}

/** ST legacy name markers and current name macros; names are literal values.
 * Self-contained so the browser host can use the same implementation.
 */
export function replaceNameMacros(input, {user = '', char = ''} = {}) {
  return String(input ?? '').replace(/<(user|char|bot)>|{{\s*(user|char)\s*}}/gi,
    (_match, legacy, macro) => String((legacy ?? macro).toLowerCase() === 'user' ? user : char));
}
