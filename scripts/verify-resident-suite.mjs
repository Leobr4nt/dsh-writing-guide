/** Read private material in memory; publish only counts, flags and fixed error categories. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TavernBrowser, safeRuntimeIssue } from '../lib/tavern-browser.js';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';
import { ExtensionScopes } from '../lib/extension-scopes.js';
import { createSessionHook } from '../lib/session-hook.js';
import { selectWritingWorlds } from '../lib/card-lore.js';

const [manifestFile, reportFile] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let runtime, stage = 'manifest';
let report = { materialTextExposed: false, modelRequests: 0, corePassed: false, fullCompatibility: false };
try {
  if (!manifestFile || !reportFile) throw Error('ARGUMENTS');
  const root = path.dirname(path.resolve(manifestFile));
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const store = new GuideStore(root), extensionStore = new ExtensionStore(root);
  const scopes = new ExtensionScopes({ store, extensionStore });
  const watched = [manifestFile, ...Object.values(manifest.inputs ?? {}).map(input => input.path)];
  for (const name of ['settings.json', 'bindings.json', 'extensions.json']) watched.push(path.join(root, name));
  for (const dir of ['presets', 'worlds', 'cards']) {
    for (const file of await fs.readdir(path.join(root, dir))) if (file.endsWith('.json')) watched.push(path.join(root, dir, file));
  }
  const before = new Map(await Promise.all(watched.map(async file => [file, hash(await fs.readFile(file))])));
  stage = 'prepare';
  const binding = (await store.loadBindings()).bindings?.[manifest.sessionId];
  if (!binding) throw Error('BINDING_MISSING');
  const card = await store.getCard(binding.cardId), preset = await store.getPreset(binding.presetId);
  if (!card || !preset) throw Error('MATERIAL_MISSING');
  const worlds = selectWritingWorlds({ allWorlds: await store.listWorlds(), binding, card }).books;
  const scripts = (await scopes.resolve(binding)).scripts.map(script => ({ ...script, id: JSON.stringify([script.scopeType, script.scopeId, script.id]) }));
  runtime = new TavernBrowser({ cacheDir: path.join(root, 'runtime-modules') });
  stage = 'start';
  await runtime.start({ sessionId: manifest.sessionId, card, preset, worlds,
    globalWorlds: worlds.filter(world => world.id === manifest.styleWorldId).map(world => world.name),
    chat: [{ is_user: false, is_system: false, name: card.name, mes: card.firstMes }], scripts,
    variables: { chat: {}, global: {}, messages: {}, scripts: {} } });
  stage = 'scripts'; await runtime.loadScripts(scripts);
  stage = 'settle'; await runtime.settle(5000);
  report = { ...report, ...await runtime.status() };
  if (report.mvu) {
    stage = 'mvu-update'; report.updateProbe = await runtime.verifyMvuUpdate();
    stage = 'assemble';
    let captured;
    // Assembly probe has read access only: its synthetic transport must never persist macros.
    const previewVariables={load:()=>extensionStore.load(),sessionVars:id=>extensionStore.sessionVars(id)};
    const hook = createSessionHook({ store, extensionStore:previewVariables, scopes, diagnostics: new Map(),
      transport: async ({ plan }) => { captured = plan; return { ok: true, content: 'ACK', finish: 'stop' }; } });
    for await (const _ of hook({ messages: [{ id: 'opaque-test', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '兼容性验收' }] }] }, manifest.sessionId, binding)) {}
    if (!captured) throw Error('ASSEMBLY_FAILED');
    stage = 'template';
    try {
      const texts = captured.meta.templateIndexes.map(index => captured.messages[index].content);
      const output = await runtime.render(texts, { char: card.name, user: '用户' });
      report.templates = { ok: true, messages: output.length, remainingMarkers: output.filter(text => text.includes('<%')).length };
    } catch (error) { report.templates = { ok: false, ...safeRuntimeIssue(error) }; }
  }
  stage = 'verify-state';
  report.inputsAndStateUnchanged = (await Promise.all([...before].map(async ([file, value]) => hash(await fs.readFile(file)) === value))).every(Boolean);
  report.corePassed = !!(report.mvu && report.updateProbe?.eventUpdateVerified && report.templates?.ok && report.templates.remainingMarkers === 0 && report.inputsAndStateUnchanged);
  // Core MVU/template acceptance does not establish full script UI or host API compatibility.
  report.fullCompatibility = false;
  process.exitCode = report.corePassed ? 0 : 2;
} catch (error) {
  report = { ...report, ok: false, stage, ...safeRuntimeIssue(error) };
  process.exitCode = 1;
} finally { await runtime?.close(); }
if (reportFile) {
  try { await fs.writeFile(reportFile, JSON.stringify(report, null, 2)); }
  catch { report = { ok: false, stage: 'report', category: 'REPORT_WRITE_FAILED' }; process.exitCode = 1; }
}
console.log(JSON.stringify(report, null, 2));
