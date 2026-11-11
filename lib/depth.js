/**
 * ST 的 @D（depth）插入语义 —— 参考实现，**当前未接入真实请求**。
 *
 * 依据 SillyTavern `release` 分支 commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127：
 *   public/scripts/openai.js#L810-875  populationInjectionPrompts
 *     - 入参 messages 是「最新 → 最旧」（同文件 #L1320 的 `messages.shift()` 取到最后一条可证）
 *     - `messages.splice(i + totalInsertedMessages, 0, ...roleMessages)`，#L866-870
 *     - 出口 `messages = messages.reverse()`，#L873，恢复成「最旧 → 最新」交给请求
 *     - 同一 depth 内 role 顺序 system → user → assistant（#L847），reverse 后 system 最靠近输出
 *   public/scripts/world-info.js#L855  world_info_position（atDepth = 4）
 *   public/scripts/world-info.js#L96   DEFAULT_DEPTH = 4
 *
 * 结论（以 [user U1, assistant A1, user U2] 为例，内部数组为 [U2, A1, U1]）：
 *   depth 0 → splice(0) → 内部 [I0, U2, A1, U1] → 反转 → [U1, A1, U2, I0]   （最后一条之后）
 *   depth 1 → splice(1) → 内部 [U2, I1, A1, U1] → 反转 → [U1, A1, I1, U2]   （最后一条之前）
 *   depth 2 → splice(2) → 内部 [U2, A1, I2, U1] → 反转 → [U1, I2, A1, U2]   （倒数第二条之前）
 *
 * 也就是说：depth 0 在提示词底部，depth 越大越靠近历史开头。这与官方文档一致。
 */

/** ST 同一 depth 内的 role 优先级：数字越小越靠后（越接近输出）。 */
export const DEPTH_ROLE_ORDER = ['system', 'user', 'assistant'];

/**
 * 按 ST 语义把深度注入插进「最旧 → 最新」的 messages 副本。
 * 只用于测试与将来接入；不修改入参。
 *
 * @param {Array<{role: string, content: string}>} messages 最旧 → 最新
 * @param {Array<{depth: number, role: string, content: string, order?: number}>} blocks
 * @returns {Array<{role: string, content: string}>}
 */
export function insertAtDepth(messages, blocks) {
  // 内部数组方向：最新 → 最旧
  const internal = messages.slice().reverse();
  let totalInserted = 0;
  const depths = [...new Set(blocks.map((block) => Math.max(0, Math.trunc(block.depth))))].sort((a, b) => a - b);
  for (const depth of depths) {
    const atDepth = blocks.filter((block) => Math.max(0, Math.trunc(block.depth)) === depth);
    // ST：同 depth 内 injection_order 从大到小处理，再按 role system→user→assistant
    const orders = [...new Set(atDepth.map((block) => Number(block.order ?? 100)))].sort((a, b) => b - a);
    const roleMessages = [];
    for (const order of orders) {
      for (const role of DEPTH_ROLE_ORDER) {
        const content = atDepth
          .filter((block) => Number(block.order ?? 100) === order && block.role === role)
          .map((block) => block.content)
          .filter(Boolean)
          .join('\n');
        if (content) roleMessages.push({ role, content });
      }
    }
    if (!roleMessages.length) continue;
    // 越界时贴到最旧一侧（ST 的 splice 越界行为也是追加到末尾）
    const index = Math.min(depth + totalInserted, internal.length);
    internal.splice(index, 0, ...roleMessages);
    totalInserted += roleMessages.length;
  }
  return internal.reverse();
}
