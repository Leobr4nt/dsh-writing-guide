/**
 * 按 key 串行化：同一作品的生成 / 保存 / 删除不会交错。
 * 进程内实现（插件单实例），失败会释放锁。
 */
const tails = new Map();

export function withLock(key, fn) {
  const name = String(key ?? '');
  const previous = tails.get(name) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  tails.set(name, previous.then(() => gate, () => gate));
  return previous
    .catch(() => undefined)
    .then(async () => {
      try {
        return await fn();
      } finally {
        release();
        // 尾部清理：没有排队者时删掉，避免 Map 无限增长
        if (tails.get(name) === undefined) tails.delete(name);
      }
    });
}

export function lockSize() {
  return tails.size;
}
