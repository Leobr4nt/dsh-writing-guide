import { createHash } from 'node:crypto';
import { normalizeWorld } from './worldinfo.js';
import { bookToSt } from './cards.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queues = new WeakMap();
const transaction = (store, fn) => {
  const next = (queues.get(store) ?? Promise.resolve()).then(fn, fn);
  queues.set(store, next.catch(() => {}));
  return next;
};

/** User-requested automatic equivalent of ST importEmbeddedWorldInfo + character_world. */
export function importCardWithLore({ store, card, overwriteWorld = false }) {
  return transaction(store, async () => {
    if (!card.id) card = { ...card, id: 'card-' + digest([card.name, card.spec]).slice(0, 16) };
    if (!card.characterBook) {
      await store.saveCard(card);
      return { card, world: null, importedWorld: false };
    }
    const rawBook = structuredClone(card.rawCharacterBook ?? bookToSt(card.characterBook));
    const name = rawBook.name || `${card.name}'s Lorebook`;
    const existing = (await store.listWorlds()).find(world => world.name === name);
    const id = existing?.id ?? 'card-world-' + digest(name).slice(0, 20);
    const world = normalizeWorld({
      ...card.characterBook, id, name,
      originalData: rawBook,
    }, id);
    if (existing && digest(existing.entries) !== digest(world.entries) && !overwriteWorld) {
      // Match ST's explicit same-name overwrite decision, never silently destroy edits.
      throw Object.assign(new Error('存在内容不同的同名世界书；请确认覆盖后重新导入'), { status: 409, code: 'WORLD_EXISTS' });
    }
    const linked = { ...card, linkedWorldId: id, extensions: { ...card.extensions, world: name } };
    if (!existing || overwriteWorld) await store.saveWorld(world);
    await store.saveCard(linked);
    return { card: linked, world: existing && !overwriteWorld ? existing : world, importedWorld: !existing || overwriteWorld };
  });
}

/** ST loads the character's linked world separately and skips any already-selected book. */
export function selectWritingWorlds({ allWorlds, binding, card, includeWorlds = true }) {
  const selection = binding.worldSelection ?? ((binding.worldIds ?? []).length ? 'selected' : 'all');
  const ids = binding.worldIds ?? [];
  const selected = selection === 'none' ? [] : selection === 'selected' ? allWorlds.filter(w => ids.includes(w.id)) : allWorlds;
  const missingWorlds = selection === 'selected' ? ids.filter(id => !allWorlds.some(w => w.id === id)) : [];
  if (!includeWorlds) return { books: [], missingWorlds };
  const books = new Map(selected.map(book => [book.id, book]));
  if (card && binding.useCardBook !== false) {
    const linked = card.linkedWorldId
      ? allWorlds.find(w => w.id === card.linkedWorldId)
      : allWorlds.find(w => w.name === card.extensions?.world);
    if (linked) books.set(linked.id, linked);
    else if (card.linkedWorldId || card.extensions?.world) missingWorlds.push(card.linkedWorldId || `card:${card.id}`);
  }
  return { books: [...books.values()], missingWorlds: [...new Set(missingWorlds)] };
}

/** Export the current linked world, so edits in the world editor reach the card export. */
export async function cardWithCurrentLore(store, card) {
  const all = await store.listWorlds();
  const world = card.linkedWorldId ? all.find(w => w.id === card.linkedWorldId) : all.find(w => w.name === card.extensions?.world);
  if (!world) return card;
  return { ...card, characterBook: { ...world, entries: world.entries }, rawCharacterBook: world.originalData ?? card.rawCharacterBook };
}
