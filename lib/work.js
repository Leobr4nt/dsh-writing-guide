/**
 * 作品（work）：写作生成入口的隔离单位。
 *
 * 同一 DSH 模式下，不同「作品」各自绑定自己的预设 / 世界书 / 作者注 / 对话历史；
 * 聊天记录只存真实对话，**不存任何注入内容**，所以重试、热重载、多步生成都不会重复累加。
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeJoin } from './store.js';
import { withLock } from './locks.js';

/** 作品 id 白名单：不能为空、不能是 . / ..、不能带路径分隔符。 */
export const WORK_ID = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;

/** 没有指定 id 时生成 ASCII 稳定 id（标题可以随便写中文）。 */
export function newWorkId() {
  return `work-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export class WorkStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  get worksDir() { return safeJoin(this.root, 'works'); }

  workDir(id) { return safeJoin(this.worksDir, path.basename(String(id))); }

  async ensure() { await mkdir(this.worksDir, { recursive: true }); }

  async list() {
    await this.ensure();
    const names = await readdir(this.worksDir).catch(() => []);
    const out = [];
    for (const name of names) {
      const meta = await this.load(name).catch(() => null);
      if (!meta) continue;
      const dir = this.workDir(name);
      const stat = await readFile(path.join(dir, 'chat.jsonl'), 'utf8').catch(() => '');
      meta.messages = stat.split(/\r?\n/).filter(Boolean).length;
      out.push(meta);
    }
    out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return out;
  }

  async load(id) {
    const raw = await readFile(path.join(this.workDir(id), 'meta.json'), 'utf8').catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async save(meta) {
    const raw = String(meta?.id ?? '').trim();
    if (raw && !WORK_ID.test(raw)) throw new Error('作品 id 只能包含字母、数字、-、_、.，且不能是 . 或 ..');
    const id = raw || newWorkId();
    if (!WORK_ID.test(id)) throw new Error('作品 id 不合法（只允许 ASCII 字母/数字/-/_/.）');
    const clean = {
      id,
      title: String(meta?.title ?? id),
      mode: String(meta?.mode ?? 'writer'),
      presetId: String(meta?.presetId ?? ''),
      worldIds: Array.isArray(meta?.worldIds) ? meta.worldIds.map(String) : [],
      authorNote: String(meta?.authorNote ?? ''),
      /** 可选：本作品专用的 provider/model（不改用户全局默认模型）。 */
      route: meta?.route && typeof meta.route === 'object'
        ? {
          provider: String(meta.route.provider ?? ''),
          model: String(meta.route.model ?? ''),
          transport: meta.route.transport === 'chat' ? 'chat' : 'llm',
        }
        : null,
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.workDir(id), { recursive: true });
    await writeFile(path.join(this.workDir(id), 'meta.json'), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    return clean;
  }

  async remove(id) {
    const key = String(id ?? '');
    return withLock(`work:${key}`, async () => {
      await rm(this.workDir(key), { recursive: true, force: true });
      return true;
    });
  }

  async chat(id) {
    const raw = await readFile(path.join(this.workDir(id), 'chat.jsonl'), 'utf8').catch(() => '');
    const messages = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string') messages.push(row);
      } catch { /* 坏行跳过 */ }
    }
    return messages;
  }

  async append(id, messages) {
    const rows = (Array.isArray(messages) ? messages : [])
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && String(message.content ?? '').trim())
      .map((message) => ({ role: message.role, content: String(message.content), time: new Date().toISOString() }));
    if (!rows.length) return 0;
    await mkdir(this.workDir(id), { recursive: true });
    await appendFile(path.join(this.workDir(id), 'chat.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    return rows.length;
  }

  async recentText(id, depth = 2) {
    const messages = await this.chat(id);
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(depth) || 2)));
    return messages.slice(-limit).map((message) => message.content).join('\n');
  }
}
