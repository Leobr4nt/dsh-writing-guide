/** Shared by the UI and model tool; never serialize the internal diagnostic object. */
import { normalizeRequestTimeoutSeconds } from './request-timeout.js';

export function writingDiagnostic(record) {
  if (!record) return null;
  const safeCodes = ['ABORTED', 'aborted', 'timeout', 'WRITING_GUIDE_BAD_BINDING', 'WRITING_GUIDE_TOOL_HISTORY', 'WRITING_GUIDE_VARIABLES', 'WRITING_GUIDE_BUDGET', 'WRITING_GUIDE_TEMPLATE', 'WRITING_GUIDE_REGEX', 'WRITING_GUIDE_VARIABLE_CONFLICT', 'WRITING_GUIDE_OUTPUT_LIMIT', 'WRITING_GUIDE_FAILED', 'WRITING_EXTENSION_FAILED'];
  const roles = { system: 0, user: 0, assistant: 0 };
  for (const role of record.roles ?? []) if (Object.hasOwn(roles, role)) roles[role]++;
  return {
    at: record.at,
    phase: record.phase,
    requestSent: record.requestSent === true,
    writingRoute: record.writingRoute ?? '',
    messages: record.messages ?? 0,
    roles,
    worlds: record.effectiveWorldIds?.length ?? 0,
    outputCap: record.outputCap ?? 0,
    requestTimeoutSeconds: normalizeRequestTimeoutSeconds(record.requestTimeoutSeconds),
    errorCode: record.error ? (safeCodes.includes(record.error.code) ? record.error.code : 'WRITING_GUIDE_FAILED') : null,
  };
}

export function writingBindingSummary(binding) {
  if (!binding) return null;
  return {
    presetId: binding.presetId, cardId: binding.cardId, worldIds: binding.worldIds,
    provider: binding.provider, model: binding.model, maxTokens: binding.maxTokens,
    contextWindow: binding.contextWindow, worldSelection: binding.worldSelection,
    requestTimeoutSeconds: normalizeRequestTimeoutSeconds(binding.requestTimeoutSeconds),
    useCardBook: binding.useCardBook, enabled: binding.enabled,
    hasAuthorNote: Boolean(binding.authorNote),
  };
}
