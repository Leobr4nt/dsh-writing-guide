/**
 * 历史裁剪的唯一实现（writer 与 session-hook 共用，避免两份逻辑分叉）。
 *
 * 规则：
 *   - 只裁调用方给的 `history`（作品历史 / 当前输入之前的对话），**当前输入不在这里**
 *   - 从最旧开始按两条一组删除（user+assistant 对）
 *   - 每删一次由 `build(rows)` 重建计划，重新测量
 *   - 裁空仍超 → rejected（调用方负责拒绝，不许发空上下文）
 */
export async function fitHistoryRows({ history, build, measure, budget }) {
  let rows = Array.isArray(history) ? history.slice() : [];
  let plan = await build(rows);
  let used = measure(plan);
  let dropped = 0;
  const limit = Number(budget?.available ?? 0);
  const limited = Number(budget?.context ?? 0) > 0;
  while (limited && used > limit && rows.length > 0) {
    rows = rows.slice(Math.min(2, rows.length));
    dropped += 1;
    plan = await build(rows);
    used = measure(plan);
  }
  return { plan, used, droppedPairs: dropped, rejected: limited && used > limit };
}
