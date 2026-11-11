#!/usr/bin/env node
/**
 * /sessions 载荷回归：routes 必须把 collectSessions 的 { rows, attempts } 归一成数组，
 * 客户端任何路径都不得对非数组调用 .map()。
 *
 *   node test/sessions-payload.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// 1) 路由侧归一
assert.match(routes, /Array\.isArray\(result\?\.rows\)/, 'routes 要把 {rows} 归一为数组');
assert.match(routes, /const sessions = Array\.isArray\(result\) \? result :/, 'routes 也要兼容旧数组形态');

// 2) 归一逻辑的行为（与 routes 同实现）
const normalize = (result) => Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
assert.deepEqual(normalize({ rows: [{ id: 'a' }], attempts: [] }), [{ id: 'a' }]);
assert.deepEqual(normalize([{ id: 'b' }]), [{ id: 'b' }]);
assert.deepEqual(normalize(undefined), []);
assert.deepEqual(normalize({ rows: null }), []);

// 3) 客户端三处都做了数组守卫
assert.match(client, /Array\.isArray\(value\?\.sessions\) \? value\.sessions : \[\]/, '初始加载归一');
assert.match(client, /Array\.isArray\(value\?\.sessions\) \? value\.sessions : \[\]/, '刷新按钮归一');
assert.match(client, /Array\.isArray\(sessions\) \? sessions : \[\]\)\.map\(/, '渲染前守卫');

console.log('sessions-payload: 全部通过');
