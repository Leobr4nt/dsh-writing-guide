export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 600;

export function normalizeRequestTimeoutSeconds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_REQUEST_TIMEOUT_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(1, Math.min(3600, Math.floor(seconds)))
    : DEFAULT_REQUEST_TIMEOUT_SECONDS;
}
