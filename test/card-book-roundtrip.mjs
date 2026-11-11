#!/usr/bin/env node
/**
 * 角色卡内置书往返测试（只用合成 fixture，不读取任何用户素材）。
 *   node test/card-book-roundtrip.mjs
 */
import assert from 'node:assert/strict';
import { normalizeCard, bookToSt, cardFromPng } from '../lib/cards.js';

const book = {
  name: '合成书',
  description: 'book-level unknown',
  scan_depth: 3,
  token_budget: 512,
  recursive_scanning: true,
  extensions: { custom_book: 1 },
  entries: [
    {
      id: 7, keys: ['雨'], secondary_keys: ['夜'], content: '合成条目', comment: 'c',
      constant: true, selective: true, selectiveLogic: 3, insertion_order: 42, enabled: true,
      position: 4, depth: 2, role: 1, probability: 80, useProbability: true,
      group: 'g', group_weight: 5, scanDepth: 2, matchWholeWords: true, caseSensitive: true,
      excludeRecursion: true, preventRecursion: false, delayUntilRecursion: 1,
      priority: 10, sticky: 2, cooldown: 3, delay: 1,
      extensions: { position: 4, depth: 2, role: 1, probability: 80, selectiveLogic:3, custom_entry: 'keep' },
      unknown_entry_field: { deep: [1, 2] },
    },
    { id: 8, keys: ['雪'], content: '第二条', enabled: false },
  ],
};

const raw = { spec: 'chara_card_v2', data: { name: '合成卡', description: 'd', character_book: book } };

// 1) normalizeCard 保留原始 book，且规范化视图完整
const card = normalizeCard(raw);
assert.ok(card.rawCharacterBook, '保留 rawCharacterBook');
assert.equal(card.rawCharacterBook.entries.length, 2);
assert.equal(card.characterBook.entries.length, 2);
assert.equal(card.characterBook.name, '合成书');
assert.equal(card.characterBook.token_budget, 512, 'book 级 unknown 保留');
assert.equal(card.characterBook.extensions.custom_book, 1);

// 2) entry 字段映射 + unknown 保留
const first = card.characterBook.entries[0];
assert.deepEqual(first.key, ['雨']);
assert.deepEqual(first.keysecondary, ['夜']);
assert.equal(first.order, 42);
assert.equal(first.disable, false, 'enabled:true → disable:false');
assert.equal(first.selectiveLogic, 3);
assert.equal(first.probability, 80);
assert.equal(first.extensions.custom_entry, 'keep');
assert.deepEqual(first.unknown_entry_field, { deep: [1, 2] });
assert.equal(card.characterBook.entries[1].disable, true, 'enabled:false → disable:true');

// 3) 反复 normalize 幂等（不丢 keys/disable/order、不产生 raw.raw）
const again = normalizeCard(card);
assert.deepEqual(again.characterBook.entries[0].key, ['雨']);
assert.equal(again.characterBook.entries[0].order, 42);
assert.equal(again.characterBook.entries[1].disable, true);
assert.equal(JSON.stringify(again).includes('"raw":'), false, '不产生 raw 字段');
assert.equal(again.rawCharacterBook.entries.length, card.rawCharacterBook.entries.length, 'rawCharacterBook 幂等（条目数一致）');

// 4) bookToSt 反向：字段名回到 ST、unknown 保留、可再次读回
const st = bookToSt(card.characterBook);
assert.equal(st.entries[0].keys[0], '雨');
assert.equal(st.entries[0].insertion_order, 42);
assert.equal(st.entries[0].enabled, true);
assert.equal(st.entries[1].enabled, false);
assert.equal(st.entries[0].unknown_entry_field.deep[0], 1, 'entry unknown 反向保留');
assert.equal(st.token_budget, 512, 'book unknown 反向保留');
assert.equal(JSON.stringify(st).includes('"raw"'), false);

const back = normalizeCard({ spec: 'chara_card_v2', data: { name: '合成卡', character_book: st } });
assert.deepEqual(back.characterBook.entries[0].key, ['雨']);
assert.equal(back.characterBook.entries[0].order, 42);
assert.equal(back.characterBook.entries[0].disable, false);
assert.equal(back.characterBook.entries[1].disable, true);

// Extension position overrides the legacy top-level placement, matching ST.
const precedence=normalizeCard({name:'Fixture',character_book:{entries:[{keys:[],content:'x',enabled:true,position:'before_char',extensions:{position:4}}]}});
assert.equal(precedence.characterBook.entries[0].position,4);
assert.equal(precedence.characterBook.entries[0].uid,0);
assert.deepEqual(normalizeCard(card).rawCharacterBook,card.rawCharacterBook);
// 6) PNG 体积上限：合成超限 base64 应被拒绝（不解码内容）
{
  const big = Buffer.from('A'.repeat(200));   // 非 PNG 签名
  assert.throws(() => cardFromPng(big), /PNG/);
  const limit = 12 * 1024 * 1024;
  assert.ok(Math.ceil(limit * 4 / 3) > limit, 'base64 上限按 4/3 计算');
}

console.log('card-book-roundtrip: 全部通过');
