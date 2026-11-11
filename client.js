window.__ModuleLoader__.load({
  id: '@local/dsh-writing-guide',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/api/writing-guide';

    const FALLBACK_POSITIONS = [
      { value: 0, key: 'before', label: '↑Char（角色设定之前）' },
      { value: 1, key: 'after', label: '↓Char（角色设定之后）' },
      { value: 2, key: 'ANTop', label: "↑AT（Author's Note 之前）" },
      { value: 3, key: 'ANBottom', label: "↓AT（Author's Note 之后）" },
      { value: 4, key: 'atDepth', label: '@D（插进对话倒数第 N 条）' },
      { value: 5, key: 'EMTop', label: '↑EM（示例对话之前）' },
      { value: 6, key: 'EMBottom', label: '↓EM（示例对话之后）' },
      { value: 7, key: 'outlet', label: 'outlet（按名字取用）' },
    ];
    const ROLES = ['system', 'user', 'assistant'];

    /** 明确方法的请求：payload 只序列化一次，DELETE 不会被写成 POST。 */
    async function api(method, path, body) {
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${API}${path}`, init);
      const raw = await res.text();
      let value = null;
      try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
      if (!res.ok || value?.ok === false) throw new Error(value?.error || raw || `HTTP ${res.status}`);
      return value;
    }

    async function call(path, body) {
      const init = { method: body === undefined ? 'GET' : 'POST', headers: {} };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${API}${path}`, init);
      const text = await res.text();
      let value = null;
      try { value = text ? JSON.parse(text) : null; } catch { value = null; }
      if (!res.ok || value?.ok === false) throw new Error(value?.error || text || `HTTP ${res.status}`);
      return value;
    }

    const CSS = `
.wg-glyph { display: inline-flex; align-items: center; justify-content: center; }
.wg-root { width: 100%; height: 100%; min-height: 0; min-width: 0; display: flex; }
.wg-app { width: 100%; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; container-type: inline-size;
  background: var(--dsw-alias-bg-base, #f7f5ef); color: var(--dsw-alias-label-primary, #16140f);
  font: 13px/1.55 system-ui, "Microsoft YaHei UI", sans-serif; }
.wg-head { display: flex; align-items: center; gap: 22px; padding: 12px 24px; flex: none; border-bottom: 1px solid var(--dsw-alias-border-l1, #c9c3b6);
  background: var(--dsw-alias-bg-layer-1, #fffcf7); }
.wg-title { font-weight: 650; font-size: 14px; white-space: nowrap; }
.wg-tabs { display: flex; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.wg-tabs button { font: inherit; font-size: 12.5px; padding: 7px 11px; flex: none; white-space: nowrap; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #5c564c); border-radius: 7px; }
.wg-tabs button[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2, #efe9df); color: var(--dsw-alias-label-primary, #16140f); font-weight: 600; }
.wg-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 28px; display: flex; flex-direction: column; gap: 12px; }
.wg-body:not(.wg-body-config) { align-items: stretch; padding: 24px; gap: 18px; }
.wg-body:not(.wg-body-config) > * { flex-shrink: 0; box-sizing: border-box; width: 100%; max-width: 1100px; margin-left: auto; margin-right: auto; }
.wg-body > .wg-body { overflow: visible; padding: 0; flex: none; }
.wg-collection { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.wg-page-heading h2 { font-size: 22px; margin: 0 0 5px; }
.wg-page-heading p { margin: 0; color: var(--dsw-alias-label-secondary, #777); font-size: 12px; }
.wg-search { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #ccc); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font: inherit; }
.wg-item-ops { display: flex; gap: 8px; flex-wrap: wrap; }
.wg-body:not(.wg-body-config) .wg-card { padding: 16px; gap: 12px; }
.wg-body:not(.wg-body-config) .wg-field input, .wg-body:not(.wg-body-config) .wg-field select, .wg-body:not(.wg-body-config) .wg-field textarea { min-width: 0; max-width: 100%; box-sizing: border-box; }
.wg-item { min-width: 0; flex-wrap: wrap; }
.wg-card { border: 1px solid var(--dsw-alias-border-l1, #d8d2c6); border-radius: 11px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1, #fffdf9); }
.wg-card h4 { margin: 0; font-size: 12.5px; }
.wg-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wg-btn { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 13px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); background: var(--dsw-alias-bg-layer-2, #efe9df); color: inherit; }
.wg-btn:disabled { opacity: .5; cursor: not-allowed; }
/* 反色填充：label-primary 当底、bg-base 当字，浅色/深色主题都保证对比 */
.wg-btn-primary { background: var(--dsw-alias-label-primary, #16140f); border-color: transparent; color: var(--dsw-alias-bg-base, #fff); }
.wg-btn-primary:disabled { opacity: .45; }
.wg-btn-primary:hover:not(:disabled) { opacity: .86; }
.wg-btn-mini { font-size: 11px; padding: 2px 7px; border-radius: 6px; font-weight: 500; background: transparent; }
.wg-btn-mini:hover { background: var(--dsw-alias-bg-layer-2, #efe9df); }
.wg-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6d675c); line-height: 1.6; }
.wg-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #1f7a45); }
.wg-err { font-size: 12px; color: var(--dsw-alias-state-error-primary, #c33); }
.wg-field { display: flex; flex-direction: column; gap: 4px; }
.wg-field > label { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6d675c); }
.wg-field input, .wg-field select, .wg-field textarea { font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); background: var(--dsw-alias-bg-base, #fdfbf6); color: inherit; }
.wg-field textarea { min-height: 90px; resize: vertical; line-height: 1.6; }
.wg-world-picker { min-width: 0; border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); border-radius: 8px; background: var(--dsw-alias-bg-base, #fdfbf6); }
.wg-world-picker > summary { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; list-style: none; }
.wg-world-picker > summary::-webkit-details-marker { display: none; }
.wg-world-picker > summary::after { content: '⌄'; margin-left: auto; flex: none; }
.wg-world-picker[open] > summary::after { content: '⌃'; }
.wg-world-picker summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wg-world-picker-body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.wg-world-picker-body input[type="search"] { box-sizing: border-box; width: 100%; }
.wg-world-options { max-height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.wg-world-option { display: flex; gap: 8px; align-items: center; padding: 7px 4px; border-radius: 5px; cursor: pointer; }
.wg-world-option:hover { background: var(--dsw-alias-bg-layer-2, #efe9df); }
.wg-world-option input[type="checkbox"] { width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--dsw-alias-label-primary, #555); }
.wg-world-option span { min-width: 0; overflow-wrap: anywhere; }
.wg-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wg-row > label { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6d675c); display: inline-flex; align-items: center; gap: 4px; }
.wg-row input[type="number"], .wg-row input[type="text"], .wg-row select { font: inherit; font-size: 12px; padding: 4px 7px;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); background: var(--dsw-alias-bg-base, #fdfbf6); color: inherit; }
.wg-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.wg-chip { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer; color: inherit; opacity: .6;
  border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); background: transparent; }
.wg-chip[data-on="true"] { opacity: 1; border-color: transparent; background: var(--dsw-alias-label-primary, #16140f); color: var(--dsw-alias-bg-base, #fff); }
.wg-chip[data-missing="true"] { border-style: dashed; }
.wg-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, #d8d2c6);
  border-radius: 9px; font-size: 12px; background: var(--dsw-alias-bg-layer-1, #fffdf9); }
.wg-item[data-active="true"] { border-color: var(--dsw-alias-border-l2, #8a8478); background: var(--dsw-alias-bg-layer-2, #efe9df); }
.wg-item-main { min-width: 0; flex: 1 1 auto; }
.wg-item-main b { display: inline-block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.wg-item-main b { font-weight: 600; }
.wg-item-main div { font-size: 11px; color: var(--dsw-alias-label-secondary, #6d675c); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wg-entry { border: 1px solid var(--dsw-alias-border-l1, #d8d2c6); border-radius: 10px; padding: 9px 11px;
  display: flex; flex-direction: column; gap: 7px; background: var(--dsw-alias-bg-layer-1, #fffdf9); }
.wg-entry[data-disabled="true"] { opacity: .58; }
.wg-entry[data-marker="true"] { border-style: dashed; }
.wg-pre { margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px;
  line-height: 1.6; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, #d8d2c6);
  background: var(--dsw-alias-bg-base, #fdfbf6); }
.wg-empty { color: var(--dsw-alias-label-secondary, #6d675c); font-size: 12.5px; padding: 18px; text-align: center; }
.wg-sub { display: flex; align-items: center; gap: 8px; }
.wg-sub button { font: inherit; font-size: 12px; border: 0; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary, #6d675c); }
.wg-sub b { font-size: 13px; }
.wg-mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.wg-tag { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #c9c3b6); }
.wg-body-config { overflow: hidden; padding: 0; gap: 0; }
.wg-body-config > .wg-ok, .wg-body-config > .wg-err { margin: 10px 24px 0; flex: none; }
.wg-config { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.wg-config-scroll { flex: 1; min-height: 0; overflow: auto; padding: 24px; scrollbar-gutter: stable; }
.wg-config-page { width: 100%; max-width: 1100px; min-width: 0; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.wg-config-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.wg-config-heading h2 { margin: 0 0 4px; font-size: 22px; line-height: 1.35; font-weight: 650; letter-spacing: -.4px; }
.wg-config-lead { margin: 0; color: var(--dsw-alias-label-secondary, #6d675c); font-size: 12px; }
.wg-status-toggle { display: inline-flex; align-items: center; gap: 7px; flex: none; }
.wg-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #45a778); }
.wg-status-dot[data-off="true"] { background: var(--dsw-alias-label-tertiary, #8a8478); }
.wg-config-scope { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; column-gap: 12px; row-gap: 7px; padding-bottom: 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, #d8d2c6); }
.wg-config-scope .wg-hint { grid-column: 1 / -1; }
.wg-config-grid { display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,1fr); align-items: start; gap: 18px; }
.wg-config-column { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.wg-config-section { min-width: 0; padding: 18px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #d8d2c6); background: var(--dsw-alias-bg-layer-1, #fffdf9); display: flex; flex-direction: column; gap: 14px; }
.wg-config-section h3 { font-size: 14px; font-weight: 650; margin: 0; }
.wg-config .wg-field { min-width: 0; gap: 5px; }
.wg-config .wg-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6d675c); }
.wg-config .wg-field > select, .wg-config .wg-field > input, .wg-config .wg-field > textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 7px 10px; }
.wg-config .wg-field select { text-overflow: ellipsis; }
.wg-config .wg-field > textarea { min-height: 90px; }
.wg-config .wg-hint { font-size: 11.5px; overflow-wrap: anywhere; }
.wg-config-divider { border: 0; border-top: 1px solid var(--dsw-alias-border-l1, #d8d2c6); width: 100%; margin: 0; }
.wg-disclosure { min-width: 0; border: 1px solid var(--dsw-alias-border-l1, #d8d2c6); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fffdf9); }
.wg-disclosure > summary { cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; padding: 15px 18px; font-size: 12.5px; font-weight: 600; }
.wg-disclosure > summary::-webkit-details-marker { display: none; }
.wg-disclosure > summary::after { content: '+'; margin-left: auto; font-size: 17px; font-weight: 400; color: var(--dsw-alias-label-secondary, #6d675c); }
.wg-disclosure[open] > summary::after { content: '−'; }
.wg-disclosure-body { padding: 0 18px 18px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wg-compat-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }
.wg-config-help { color: var(--dsw-alias-label-secondary, #6d675c); }
.wg-config-help summary { cursor: pointer; font-size: 12px; }
.wg-config-help p { margin: 8px 0 0; max-width: 70ch; }
.wg-config-footer { flex: none; padding: 14px 24px; border-top: 1px solid var(--dsw-alias-border-l1, #d8d2c6); background: var(--dsw-alias-bg-layer-1, #fffdf9); }
.wg-config-footer-inner { max-width: 1100px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wg-config-save-state { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wg-config-save-state strong { font-size: 12px; font-weight: 550; }
.wg-config-save-state[data-dirty="true"] strong { color: var(--dsw-alias-label-primary, #16140f); }
.wg-config-footer .wg-btn-primary { padding: 9px 20px; }
.wg-config-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; }
@container (max-width: 760px) {
  .wg-config-grid { grid-template-columns: minmax(0,1fr); }
  .wg-config-scroll { padding: 18px 16px; }
  .wg-head { padding: 10px 16px; gap: 14px; flex-wrap: wrap; }
  .wg-tabs { width: 100%; }
  .wg-config-footer { padding: 12px 16px; }
}
@container (max-width: 420px) {
  .wg-config-heading { align-items: flex-start; }
  .wg-config-heading h2 { font-size: 20px; }
  .wg-config-section { padding: 16px; }
  .wg-config-footer-inner { align-items: stretch; flex-direction: column; gap: 8px; }
  .wg-config-actions { justify-content: flex-end; }
  .wg-config-footer .wg-hint { display: none; }
}
`;

    function Styles() {
      return h('style', { 'data-writing-guide-style': 'true' }, CSS);
    }
    function SearchInput({query,onChange,label}){return h('input',{className:'wg-search',type:'search',value:query,'aria-label':label,placeholder:label,onChange:event=>onChange(event.target.value)});}
    const matchesSearch=(item,query)=>`${item.name??item.title??''} ${item.id??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

    function Field({ label, children }) {
      const id=React.useId();
      let controlId;
      const content=React.Children.map(children,child=>{
        if(React.isValidElement(child)&&['input','select','textarea'].includes(child.type)){
          controlId=child.props.id||id;return React.cloneElement(child,{id:controlId});
        }
        return child;
      });
      return h('div', { className: 'wg-field' }, [h('label', { key: 'l',htmlFor:controlId }, label), content]);
    }

    function toListText(list) {
      return Array.isArray(list) ? list.join(', ') : '';
    }

    function parseList(text) {
      return String(text ?? '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    }

    function Chips({ modes, selected, onChange, allowEmptyHint }) {
      const list = Array.isArray(selected) ? selected : [];
      const nodes = (modes ?? []).map((mode) => {
        const on = list.includes(mode.id);
        return h('button', {
          key: mode.id,
          className: 'wg-chip',
          'data-on': String(on),
          'data-missing': String(mode.declared === false),
          title: mode.broken ? `加载失败：${mode.broken}` : (mode.description || `${mode.name} · ${mode.id}`),
          onClick: () => onChange(on ? list.filter((id) => id !== mode.id) : [...list, mode.id]),
        }, mode.declared === false ? `${mode.name} · 未声明` : mode.name);
      });
      if (allowEmptyHint) nodes.push(h('span', { key: '__hint', className: 'wg-hint' }, '不选 = 跟随目标模式'));
      return h('div', { className: 'wg-chips' }, nodes);
    }

    // ------------------------------------------------------------- 注入页
    function InjectPanel({ data, reload, notify, fail }) {
      const [draft, setDraft] = useState(data.settings);
      const [preview, setPreview] = useState({ mode: '', scan: '', systemText: '', depthBlocks: [], meta: null });
      const [busy, setBusy] = useState(false);
      const dirty = useRef(false);

      useEffect(() => { if (!dirty.current) setDraft(data.settings); }, [data.settings]);

      const patch = (value) => { dirty.current = true; setDraft((prev) => ({ ...prev, ...value })); };
      const patchVars = (value) => { dirty.current = true; setDraft((prev) => ({ ...prev, vars: { ...(prev.vars ?? {}), ...value } })); };
      const save = async () => {
        setBusy(true);
        try {
          await call('/settings', { patch: draft });
          dirty.current = false;
          notify('注入设置已保存');
          await reload();
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const runPreview = async () => {
        setBusy(true);
        try {
          const result = await call('/preview', { mode: preview.mode, scanText: preview.scan });
          setPreview((prev) => ({
            ...prev,
            systemText: result.systemText ?? '',
            depthBlocks: result.depthBlocks ?? [],
            meta: result.meta ?? null,
          }));
        } catch (error) { fail(error); } finally { setBusy(false); }
      };

      const last = data.last ?? {};
      const modes = data.modes ?? [];
      const presets = data.presets ?? [];
      const vars = draft.vars ?? {};

      return h(React.Fragment, null, [
        h('div', { key: 'bar', className: 'wg-bar' }, [
          h('label', { key: 'en' }, h('input', {
            type: 'checkbox', checked: draft.enabled === true,
            onChange: (event) => patch({ enabled: event.target.checked }),
          }), ' 启用注入'),
          h('button', { key: 'save', className: 'wg-btn wg-btn-primary', disabled: busy, onClick: save }, '保存'),
          h('button', { key: 'rf', className: 'wg-btn', disabled: busy, onClick: () => { dirty.current = false; reload(); } }, '重新读取'),
          h('span', { key: 'root', className: 'wg-hint' }, data.dataRoot ?? ''),
        ]),

        h('div', { key: 'targets', className: 'wg-card' }, [
          h('h4', { key: 'h' }, '注入到哪些 DSH 模式'),
          h(Chips, { key: 'c', modes, selected: draft.targets, onChange: (list) => patch({ targets: list }) }),
          h('div', { key: 'd', className: 'wg-hint' },
            `最近一次真实请求：模式 ${last.mode || '未知'} · ${last.injected ? `已注入 ${last.chars} 字（估算）` : '未注入'}`
            + `${last.reason && last.reason !== 'ok' ? ` · ${last.reason}` : ''}`
            + `${last.presetName ? ` · 预设 ${last.presetName}` : ''}`
            + `${last.depthBlocks ? ` · @D ${last.depthBlocks} 块（仅并入系统段）` : ''}`),
          last.roles ? h('div', { key: 'r', className: 'wg-hint' },
            `条目角色：system ${last.roles.system} / user ${last.roles.user} / assistant ${last.roles.assistant}`
            + `${last.coercedRoles ? ` · ${last.coercedRoles} 条被强制并入系统段` : ''}`) : null,
          last.omitted?.length ? h('div', { key: 'o', className: 'wg-hint' },
            `超预算整块省略：${last.omitted.map((item) => `${item.label}(${item.chars}字)`).join('、')}`) : null,
          last.notes?.length ? h('div', { key: 'n', className: 'wg-hint' }, `要点：${last.notes.join('；')}`) : null,
        ]),

        h('div', { key: 'content', className: 'wg-card' }, [
          h('h4', { key: 'h' }, '注入内容'),
          h('div', { key: 'sw', className: 'wg-row' }, [
            h('label', { key: 'p' }, h('input', {
              type: 'checkbox', checked: draft.includePreset !== false,
              onChange: (event) => patch({ includePreset: event.target.checked }),
            }), ' 预设（按 prompt_order 组装）'),
            h('label', { key: 'w' }, h('input', {
              type: 'checkbox', checked: draft.includeWorlds !== false,
              onChange: (event) => patch({ includeWorlds: event.target.checked }),
            }), ' 世界书条目'),
          ]),
          h(Field, { key: 'preset', label: '用哪份预设' },
            h('select', { value: draft.presetId ?? '', onChange: (event) => patch({ presetId: event.target.value }) }, [
              h('option', { key: '', value: '' }, '自动：第一份模式命中的预设'),
              ...presets.map((preset) => h('option', { key: preset.id, value: preset.id }, `${preset.name}（${preset.enabled ?? 0} 条启用）`)),
            ])),
          h('div', { key: 'nums', className: 'wg-row' }, [
            h('label', { key: 'd' }, '扫描最近', h('input', {
              type: 'number', min: 1, max: 60, style: { width: '64px' },
              value: draft.scanDepth, onChange: (event) => patch({ scanDepth: Number(event.target.value) }),
            }), '条消息'),
            h('label', { key: 'c' }, '上限', h('input', {
              type: 'number', min: 200, max: 60000, step: 200, style: { width: '84px' },
              value: draft.maxChars, onChange: (event) => patch({ maxChars: Number(event.target.value) }),
            }), '字'),
            h('label', { key: 'h' }, '段标题', h('input', {
              type: 'text', style: { width: '160px' }, value: draft.header ?? '',
              placeholder: '留空则不加',
              onChange: (event) => patch({ header: event.target.value }),
            })),
          ]),
          h('div', { key: 'vtip', className: 'wg-hint' },
            '角色卡在「角色卡」页导入（JSON / PNG），其 description / personality / scenario 会通过下面的变量与预设 marker 注入；这里的手工填写会覆盖卡片值（预设里对应 marker 的位置照样生效）。'),
          h('div', { key: 'vars1', className: 'wg-row' }, [
            h('label', { key: 'u' }, '{{user}}', h('input', {
              type: 'text', style: { width: '110px' }, value: vars.user ?? '',
              onChange: (event) => patchVars({ user: event.target.value }),
            })),
            h('label', { key: 'c' }, '{{char}}', h('input', {
              type: 'text', style: { width: '110px' }, value: vars.char ?? '',
              onChange: (event) => patchVars({ char: event.target.value }),
            })),
            h('label', { key: 'p' }, '{{persona}}', h('input', {
              type: 'text', style: { width: '160px' }, value: vars.persona ?? '',
              onChange: (event) => patchVars({ persona: event.target.value }),
            })),
          ]),
          h('div', { key: 'vars2', className: 'wg-row' }, [
            h('label', { key: 'd' }, '{{description}}', h('input', {
              type: 'text', style: { width: '200px' }, value: vars.description ?? '',
              onChange: (event) => patchVars({ description: event.target.value }),
            })),
            h('label', { key: 'p' }, '{{personality}}', h('input', {
              type: 'text', style: { width: '200px' }, value: vars.personality ?? '',
              onChange: (event) => patchVars({ personality: event.target.value }),
            })),
          ]),
          h('div', { key: 'vars3', className: 'wg-row' }, [
            h('label', { key: 's' }, '{{scenario}}', h('input', {
              type: 'text', style: { width: '240px' }, value: vars.scenario ?? '',
              onChange: (event) => patchVars({ scenario: event.target.value }),
            })),
            h('label', { key: 'e' }, '{{examples}}', h('input', {
              type: 'text', style: { width: '240px' }, value: vars.examples ?? '',
              onChange: (event) => patchVars({ examples: event.target.value }),
            })),
          ]),
        ]),

          h('details', { key: 'adv', className: 'wg-card', style: { padding: '8px 12px' } }, [
            h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12.5px', fontWeight: '600' } },
              `高级：预算 / 作者注 / 递归（模型 ${(data.model?.provider || '?') + ' / ' + (data.model?.model || '?')}）`),
            h('div', { key: 'b1', className: 'wg-row' }, [
              h('label', { key: 'cw' }, '上下文窗口', h('input', {
                type: 'number', min: 0, step: 512, style: { width: '96px' }, value: draft.contextWindow ?? 0,
                onChange: (event) => patch({ contextWindow: Number(event.target.value) }),
              })),
              h('label', { key: 'mt' }, '输出预留', h('input', {
                type: 'number', min: 0, step: 16, style: { width: '80px' }, value: draft.maxTokens ?? '',
                onChange: (event) => patch({ maxTokens: Number(event.target.value) || 0 }),
              })),
              h('label', { key: 'tp' }, '温度', h('input', {
                type: 'number', min: 0, max: 2, step: 0.05, style: { width: '70px' }, value: draft.temperature ?? '',
                onChange: (event) => patch({ temperature: event.target.value === '' ? undefined : Number(event.target.value) }),
              })),
            ]),
            h('div', { key: 'b2', className: 'wg-row' }, [
              h('label', { key: 'wp' }, '世界书预算 %', h('input', {
                type: 'number', min: 0, max: 100, style: { width: '70px' }, value: draft.worldBudgetPercent ?? 25,
                onChange: (event) => patch({ worldBudgetPercent: Number(event.target.value) }),
              })),
              h('label', { key: 'wt' }, '世界书预算 token（0=按上面 %）', h('input', {
                type: 'number', min: 0, step: 64, style: { width: '96px' }, value: draft.worldBudgetTokens ?? 0,
                onChange: (event) => patch({ worldBudgetTokens: Number(event.target.value) }),
              })),
              h('label', { key: 'mr' }, '递归轮数上限（0=不限）', h('input', {
                type: 'number', min: 0, max: 100, style: { width: '70px' }, value: draft.maxRecursionSteps ?? 0,
                onChange: (event) => patch({ maxRecursionSteps: Number(event.target.value) }),
              })),
            ]),
            h(Field, { key: 'an', label: `作者注（没有 authorsNote marker 时按 depth ${data.authorNotePlacement?.depth ?? 4} / ${data.authorNotePlacement?.role ?? 'system'} 插入）` },
              h('textarea', {
                style: { minHeight: '60px' },
                value: draft.authorNote ?? '',
                onChange: (event) => patch({ authorNote: event.target.value }),
              })),
            h('label', { key: 'dg', className: 'wg-row' }, h('input', {
              type: 'checkbox', checked: draft.degradeOrder === true,
              onChange: (event) => patch({ degradeOrder: event.target.checked }),
            }), ' 允许顺序退化（适配器不支持 in-history 时，把历史后的 system 并到顶部唯一 system；默认关闭 = 直接拒绝生成）'),
            h('div', { key: 'tip', className: 'wg-hint' },
              'token 是保守估算（中文 1 字 ≈ 1.5 token），不是精确 tokenizer；超出上下文会拒绝请求而不是截断。'
              + ' 默认 route deepseek-account 的适配器不支持 in-history，预设里有 PHI/@D(system) 时会拒绝生成；改用 pi-ai 系 route 可保真。'),
          ]),

        h('div', { key: 'preview', className: 'wg-card' }, [
          h('h4', { key: 'h' }, '预览（不发模型请求；跳过概率抽样）'),
          h('div', { key: 'bar', className: 'wg-row' }, [
            h('label', { key: 'm' }, '按模式',
              h('select', { value: preview.mode, onChange: (event) => setPreview((prev) => ({ ...prev, mode: event.target.value })) }, [
                h('option', { key: '', value: '' }, '最近一次真实请求的模式'),
                ...modes.map((mode) => h('option', { key: mode.id, value: mode.id }, mode.name)),
              ])),
            h('button', { key: 'go', className: 'wg-btn', disabled: busy, onClick: runPreview }, '生成预览'),
          ]),
          h('div', { key: 'ph', className: 'wg-hint' },
            '预览把 probability<100 的条目全部视为命中（不做掷骰），所以命中数可能多于真实请求；真实命中以顶部「最近一次真实请求」为准。'),
          h(Field, { key: 'scan', label: '扫描文本（世界书按它命中；留空只跑常驻条目）' },
            h('textarea', {
              value: preview.scan,
              onChange: (event) => setPreview((prev) => ({ ...prev, scan: event.target.value })),
              placeholder: '例如：她把湿透的伞收起来，雨声还在。',
            })),
          preview.meta ? h('div', { key: 'meta', className: 'wg-hint' },
            `[预览] injected=${preview.meta.injected} · chars=${preview.meta.chars}（字符估算）`
            + ` · preset=${preview.meta.preset || '-'} · worlds=${(preview.meta.worlds ?? []).join(',') || '-'}`
            + ` · 命中 ${preview.meta.entries ?? 0} 条 · @D ${preview.meta.depthBlocks ?? 0} 块（不支持真注入）`
            + ` · roles=${JSON.stringify(preview.meta.roles)} · ${preview.meta.reason || ''}`) : null,
          preview.meta?.omitted?.length ? h('div', { key: 'omit', className: 'wg-hint' },
            `超预算整块省略：${preview.meta.omitted.map((item) => `${item.label}(${item.chars}字, ${item.reason})`).join('；')}`) : null,
          preview.meta?.notes?.length ? h('div', { key: 'notes', className: 'wg-hint' }, `要点：${preview.meta.notes.join('；')}`) : null,
          preview.depthBlocks.length
            ? h('div', { key: 'depth', className: 'wg-hint' },
              `@D 深度块：${preview.depthBlocks.map((block) => `${block.depth}/${block.role}`).join(' · ')}（已并入系统段末尾，不是消息级注入）`)
            : null,
          preview.systemText ? h('pre', { key: 'out', className: 'wg-pre' }, preview.systemText)
            : h('div', { key: 'none', className: 'wg-hint' }, '点「生成预览」看最终塞进系统提示词的文本。'),
        ]),
      ]);
    }

    // --------------------------------------------------------- 世界书编辑
    function WorldEditor({ world, data, onClose, onSaved, fail }) {
      const [draft, setDraft] = useState(world);
      const positions = data.positions ?? FALLBACK_POSITIONS;
      const set = (value) => setDraft((prev) => ({ ...prev, ...value }));
      const setEntry = (index, value) => setDraft((prev) => {
        const entries = prev.entries.slice();
        entries[index] = { ...entries[index], ...value };
        return { ...prev, entries };
      });
      const addEntry = () => setDraft((prev) => ({
        ...prev,
        entries: [...prev.entries, {
          uid: Date.now() % 100000,
          comment: '',
          key: [],
          keysecondary: [],
          content: '',
          constant: false,
          disable: false,
          order: 100,
          position: 0,
          depth: 4,
          role: 0,
          probability: 100,
          useProbability: true,
          selective: false,
          selectiveLogic: 0,
          matchWholeWords: false,
          caseSensitive: false,
          outletName: '',
        }],
      }));
      const removeEntry = (index) => setDraft((prev) => ({ ...prev, entries: prev.entries.filter((_e, i) => i !== index) }));
      const save = async () => {
        try {
          await call('/world/save', { world: draft });
          onSaved();
        } catch (error) { fail(error); }
      };

      return h(React.Fragment, null, [
        h('div', { key: 'sub', className: 'wg-sub' }, [
          h('button', { key: 'back', onClick: onClose }, '← 返回列表'),
          h('b', { key: 't' }, draft.name || draft.id),
          h('span', { key: 'n', className: 'wg-hint' }, `${draft.entries.length} 条`),
          h('button', { key: 'save', className: 'wg-btn wg-btn-primary', style: { marginLeft: 'auto' }, onClick: save }, '保存这本'),
        ]),
        h('div', { key: 'head', className: 'wg-card' }, [
          h('div', { key: 'nm', className: 'wg-row' }, [
            h('label', null, '名字',
              h('input', {
                type: 'text', style: { width: '240px' }, value: draft.name,
                onChange: (event) => set({ name: event.target.value }),
              })),
            h('span', { className: 'wg-hint' }, `id: ${draft.id}`),
            h('label', null, h('input', {
              type: 'checkbox', checked: draft.modes?.length > 0,
              onChange: (event) => set({ modes: event.target.checked ? (draft.modes.length ? draft.modes : ['writer']) : [] }),
            }), ' 限定模式'),
          ]),
          h(Chips, {
            key: 'modes', modes: data.modes, selected: draft.modes, allowEmptyHint: true,
            onChange: (list) => set({ modes: list }),
          }),
        ]),
        h('div', { key: 'add', className: 'wg-bar' }, [
          h('button', { key: 'a', className: 'wg-btn', onClick: addEntry }, '+ 新增条目'),
          h('span', { key: 'h', className: 'wg-hint' },
            '位置语义与 ST 一致：↑Char / ↓Char / ↑AT / ↓AT / @D / ↑EM / ↓EM / outlet。'
            + ' 注意 @D（depth 0 = 最后一条消息之后）在 DSH 里没有消息级注入，只会并入系统提示词末尾。'),
        ]),
        ...draft.entries.map((entry, index) => h('div', {
          key: `${entry.uid}-${index}`,
          className: 'wg-entry',
          'data-disabled': String(entry.disable === true),
        }, [
          h('div', { key: 'r1', className: 'wg-row' }, [
            h('span', { key: 'uid', className: 'wg-tag wg-mono' }, `#${entry.uid}`),
            h('label', null, '备注',
              h('input', {
                type: 'text', style: { width: '170px' }, value: entry.comment,
                onChange: (event) => setEntry(index, { comment: event.target.value }),
              })),
            h('label', null, '关键词',
              h('input', {
                type: 'text', style: { width: '210px' }, value: toListText(entry.key),
                placeholder: '逗号分隔',
                onChange: (event) => setEntry(index, { key: parseList(event.target.value) }),
              })),
            h('label', null, '次级键',
              h('input', {
                type: 'text', style: { width: '150px' }, value: toListText(entry.keysecondary),
                onChange: (event) => setEntry(index, { keysecondary: parseList(event.target.value) }),
              })),
            h('button', { key: 'del', className: 'wg-btn wg-btn-mini', onClick: () => removeEntry(index) }, '删除'),
          ]),
          h('div', { key: 'r2', className: 'wg-row' }, [
            h('label', null, '位置',
              h('select', {
                value: entry.position,
                onChange: (event) => setEntry(index, { position: Number(event.target.value) }),
              }, positions.map((position) => h('option', { key: position.value, value: position.value }, position.label)))),
            entry.position === 4 ? h('label', { key: 'depth' }, '深度',
              h('input', {
                type: 'number', min: 0, max: 60, style: { width: '64px' }, value: entry.depth,
                onChange: (event) => setEntry(index, { depth: Number(event.target.value) }),
              })) : null,
            entry.position === 4 ? h('label', { key: 'role' }, '角色',
              h('select', {
                value: entry.role,
                onChange: (event) => setEntry(index, { role: Number(event.target.value) }),
              }, ROLES.map((role, value) => h('option', { key: role, value }, role)))) : null,
            entry.position === 7 ? h('label', { key: 'outlet' }, '插座名',
              h('input', {
                type: 'text', style: { width: '110px' }, value: entry.outletName ?? '',
                onChange: (event) => setEntry(index, { outletName: event.target.value }),
              })) : null,
            h('label', null, '顺序',
              h('input', {
                type: 'number', style: { width: '70px' }, value: entry.order,
                onChange: (event) => setEntry(index, { order: Number(event.target.value) }),
              })),
            h('label', null, '概率',
              h('input', {
                type: 'number', min: 0, max: 100, style: { width: '66px' }, value: entry.probability,
                onChange: (event) => setEntry(index, { probability: Number(event.target.value) }),
              })),
            h('label', null, h('input', {
              type: 'checkbox', checked: entry.constant === true,
              onChange: (event) => setEntry(index, { constant: event.target.checked }),
            }), ' 常驻'),
            h('label', null, h('input', {
              type: 'checkbox', checked: entry.disable === true,
              onChange: (event) => setEntry(index, { disable: event.target.checked }),
            }), ' 禁用'),
            h('label', null, h('input', {
              type: 'checkbox', checked: entry.selective === true,
              disabled: !(entry.keysecondary ?? []).length,
              onChange: (event) => setEntry(index, { selective: event.target.checked }),
            }), ' 次级键生效'),
          ]),
          h('textarea', {
            key: 'content',
            style: {
              minHeight: '76px', width: '100%', resize: 'vertical', font: 'inherit', fontSize: '12.5px', padding: '7px 9px',
              borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1, #c9c3b6)',
              background: 'var(--dsw-alias-bg-base, #fdfbf6)', color: 'inherit',
            },
            value: entry.content,
            placeholder: '命中后原样塞进提示词的内容',
            onChange: (event) => setEntry(index, { content: event.target.value }),
          }),
        ])),
        draft.entries.length === 0 ? h('div', { key: 'empty', className: 'wg-empty' }, '还没有条目，点「+ 新增条目」。') : null,
      ]);
    }

    // ----------------------------------------------------------- 预设编辑
    function SPresetEditor({value,onChange}){
      const config=value??{};
      const section=(key,patch)=>onChange({...config,[key]:{...config[key],...patch}});
      return h('details',{className:'wg-disclosure'},[
        h('summary',{key:'summary'},'SPreset 扩展设置'),
        h('div',{key:'body',className:'wg-disclosure-body'},[
          h('label',{key:'nested'},[h('input',{type:'checkbox',checked:config.MacroNest===true,onChange:e=>onChange({...config,MacroNest:e.target.checked})}),' 嵌套数据宏']),
          h(Field,{key:'name',label:'导入固定名称'},h('input',{value:config.FixedPresetName??'',onChange:e=>onChange({...config,FixedPresetName:e.target.value})})),
          h('label',{key:'squash'},[h('input',{type:'checkbox',checked:config.ChatSquash?.enabled===true,onChange:e=>section('ChatSquash',{enabled:e.target.checked})}),' 合并聊天消息']),
          config.ChatSquash?.enabled?h(Field,{key:'role',label:'合并后的角色'},h('select',{value:config.ChatSquash.role??'assistant',onChange:e=>section('ChatSquash',{role:e.target.value})},['assistant','user','system','follow'].map(role=>h('option',{key:role,value:role},role)))):null,
          h('label',{key:'output'},[h('input',{type:'checkbox',checked:config.OutputPreprocessing?.enabled===true,onChange:e=>section('OutputPreprocessing',{enabled:e.target.checked})}),' 启用输出处理函数']),
          config.OutputPreprocessing?.enabled?h(Field,{key:'script',label:'输出处理函数'},h('textarea',{value:config.OutputPreprocessing.script??'',placeholder:'({buffer}) => buffer',onChange:e=>section('OutputPreprocessing',{script:e.target.value})})):null,
          h('label',{key:'forced'},[h('input',{type:'checkbox',checked:config.ForcedPostProcessing?.enabled===true,onChange:e=>section('ForcedPostProcessing',{enabled:e.target.checked})}),' 强制消息后处理']),
          config.ForcedPostProcessing?.enabled?h(Field,{key:'mode',label:'后处理方式'},h('select',{value:config.ForcedPostProcessing.mode??'',onChange:e=>section('ForcedPostProcessing',{mode:e.target.value})},[['','不变'],['merge','合并相邻同角色'],['single','单条用户消息']].map(([value,label])=>h('option',{key:value,value},label)))):null,
          h('div',{key:'hint',className:'wg-hint'},'绑定正则在扩展页编辑；导入的结构化消息和纯函数工具绑定按预设启用条目执行。脚本不会获得网络、文件或凭证。'),
        ]),
      ]);
    }

    function PresetEditor({ preset, data, onClose, onSaved, fail }) {
      const [draft, setDraft] = useState(preset);
      const order = draft.prompt_order?.[0]?.order ?? [];
      const byId = new Map((draft.prompts ?? []).map((prompt) => [prompt.identifier, prompt]));

      const setDraftValue = (value) => setDraft((prev) => ({ ...prev, ...value }));
      const setPrompt = (identifier, value) => setDraft((prev) => ({
        ...prev,
        prompts: prev.prompts.map((prompt) => (prompt.identifier === identifier ? { ...prompt, ...value } : prompt)),
      }));
      const setOrder = (nextOrder) => setDraft((prev) => ({
        ...prev,
        prompt_order: [{ ...(prev.prompt_order?.[0] ?? {}), order: nextOrder }],
      }));
      const toggle = (identifier) => setOrder(order.map((row) => (
        row.identifier === identifier ? { ...row, enabled: !row.enabled } : row
      )));
      const move = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= order.length) return;
        const next = order.slice();
        const [row] = next.splice(index, 1);
        next.splice(target, 0, row);
        setOrder(next);
      };
      const addPrompt = () => {
        const identifier = `custom_${Date.now().toString(36)}`;
        setDraft((prev) => ({
          ...prev,
          prompts: [...prev.prompts, {
            identifier,
            name: '新条目',
            system_prompt: true,
            role: 'system',
            content: '',
            marker: false,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
          }],
          prompt_order: [{ ...(prev.prompt_order?.[0] ?? {}), order: [...(prev.prompt_order?.[0]?.order ?? []), { identifier, enabled: true }] }],
        }));
      };
      const save = async () => {
        try {
          await call('/preset/save', { preset: draft });
          onSaved();
        } catch (error) { fail(error); }
      };

      return h(React.Fragment, null, [
        h('div', { key: 'sub', className: 'wg-sub' }, [
          h('button', { key: 'back', onClick: onClose }, '← 返回列表'),
          h('b', { key: 't' }, draft.name || draft.id),
          h('span', { key: 'n', className: 'wg-hint' }, `${order.filter((row) => row.enabled).length}/${order.length} 条启用`),
          h('button', { key: 'save', className: 'wg-btn wg-btn-primary', style: { marginLeft: 'auto' }, onClick: save }, '保存这份'),
        ]),
        h('div', { key: 'head', className: 'wg-card' }, [
          h('div', { key: 'nm', className: 'wg-row' }, [
            h('label', null, '名字',
              h('input', {
                type: 'text', style: { width: '240px' }, value: draft.name,
                onChange: (event) => setDraftValue({ name: event.target.value }),
              })),
            h('span', { className: 'wg-hint' }, `id: ${draft.id}`),
            h('label', null, h('input', {
              type: 'checkbox', checked: draft.modes?.length > 0,
              onChange: (event) => setDraftValue({ modes: event.target.checked ? (draft.modes.length ? draft.modes : ['writer']) : [] }),
            }), ' 限定模式'),
          ]),
          h(Chips, {
            key: 'modes', modes: data.modes, selected: draft.modes, allowEmptyHint: true,
            onChange: (list) => setDraftValue({ modes: list }),
          }),
          h('div', { key: 'tip', className: 'wg-hint' },
            '顺序就是 ST 的 prompt_order：世界书 / 角色卡字段 / 示例对话 / 聊天记录 这些 marker 决定了它们插在哪。'),
        ]),
        h('div', { key: 'add', className: 'wg-bar' }, [
          h('button', { key: 'a', className: 'wg-btn', onClick: addPrompt }, '+ 新增条目'),
        ]),
        h(SPresetEditor,{key:'spreset',value:draft.extensions?.SPreset,onChange:SPreset=>setDraftValue({extensions:{...draft.extensions,SPreset}})}),
        ...order.map((row, index) => {
          const prompt = byId.get(row.identifier);
          if (!prompt) return null;
          const isMarker = prompt.marker === true || ['worldInfoBefore', 'worldInfoAfter', 'charDescription',
            'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory'].includes(prompt.identifier);
          return h('div', {
            key: row.identifier,
            className: 'wg-entry',
            'data-disabled': String(!row.enabled),
            'data-marker': String(isMarker),
          }, [
            h('div', { key: 'r1', className: 'wg-row' }, [
              h('label', { key: 'on' }, h('input', {
                type: 'checkbox', checked: row.enabled, onChange: () => toggle(row.identifier),
              }), ' 启用'),
              h('input', {
                key: 'name', type: 'text', style: { width: '190px' }, value: prompt.name,
                onChange: (event) => setPrompt(prompt.identifier, { name: event.target.value }),
              }),
              h('span', { key: 'id', className: 'wg-tag wg-mono' }, prompt.identifier),
              isMarker ? h('span', { key: 'mk', className: 'wg-tag' }, 'marker') : h('label', { key: 'role' }, '角色',
                h('select', {
                  value: prompt.role,
                  onChange: (event) => setPrompt(prompt.identifier, { role: event.target.value }),
                }, ROLES.map((role) => h('option', { key: role, value: role }, role)))),
              h('button', { key: 'up', className: 'wg-btn wg-btn-mini', disabled: index === 0, onClick: () => move(index, -1) }, '↑'),
              h('button', { key: 'dn', className: 'wg-btn wg-btn-mini', disabled: index === order.length - 1, onClick: () => move(index, 1) }, '↓'),
            ]),
            isMarker
              ? h('div', { key: 'body', className: 'wg-hint' }, markerHint(prompt.identifier))
              : h('textarea', {
                key: 'body',
                style: {
                  minHeight: '64px', width: '100%', resize: 'vertical', font: 'inherit', fontSize: '12.5px', padding: '7px 9px',
                  borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1, #c9c3b6)',
                  background: 'var(--dsw-alias-bg-base, #fdfbf6)', color: 'inherit',
                },
                value: prompt.content ?? '',
                placeholder: '这条提示词的内容（可用 {{user}} {{char}} {{persona}} …）',
                onChange: (event) => setPrompt(prompt.identifier, { content: event.target.value }),
              }),
            isMarker ? null : h('div', { key: 'r2', className: 'wg-row' }, [
              h('label', null, '注入方式',
                h('select', {
                  value: prompt.injection_position,
                  onChange: (event) => setPrompt(prompt.identifier, { injection_position: Number(event.target.value) }),
                }, [
                  h('option', { key: 0, value: 0 }, '相对（跟 prompt_order 走）'),
                  h('option', { key: 1, value: 1 }, '绝对（按深度插对话）'),
                ])),
              prompt.injection_position === 1 ? h('label', { key: 'd' }, '深度',
                h('input', {
                  type: 'number', min: 0, max: 60, style: { width: '64px' }, value: prompt.injection_depth,
                  onChange: (event) => setPrompt(prompt.identifier, { injection_depth: Number(event.target.value) }),
                })) : null,
              prompt.injection_position === 1 ? h('label', { key: 'o' }, '优先级',
                h('input', {
                  type: 'number', style: { width: '70px' }, value: prompt.injection_order,
                  onChange: (event) => setPrompt(prompt.identifier, { injection_order: Number(event.target.value) }),
                })) : null,
            ]),
          ]);
        }),
      ]);
    }

    function markerHint(identifier) {
      switch (identifier) {
        case 'worldInfoBefore': return '占位：世界书 ↑Char + ↑AT 条目在这里展开';
        case 'worldInfoAfter': return '占位：世界书 ↓Char + ↓AT 条目在这里展开';
        case 'charDescription': return '占位：注入页 {{description}}';
        case 'charPersonality': return '占位：注入页 {{personality}}';
        case 'scenario': return '占位：注入页 {{scenario}}';
        case 'personaDescription': return '占位：注入页 {{persona}}';
        case 'dialogueExamples': return '占位：世界书 ↑EM/↓EM + {{examples}}';
        case 'chatHistory': return '占位：对话本身（DSH 无消息级阶段，后面的条目仍会进系统提示词）';
        default: return '占位';
      }
    }

    // --------------------------------------------------------------- 列表页
    function WorldsPanel({ data, reload, notify, fail }) {
      const [query,setQuery]=useState('');
      const [creating, setCreating] = useState(false);
      const downloadJson = async (path, name, pick) => {
        try {
          const value = await call(path);
          // 导出本体（ST 结构），不是 { ok, world } 这种包装
          const body = pick ? pick(value) : value;
          const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = name;
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (error) { fail(error); }
      };
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const fileRef = useRef(null);
      const positions = data.positions ?? FALLBACK_POSITIONS;

      const open = async (id) => {
        try {
          const result = await call(`/world/${encodeURIComponent(id)}`);
          setEditing(result.world);
        } catch (error) { fail(error); }
      };
      const create = async (name) => {
        setBusy(true);
        try {
          const result = await call('/world/create', { name });
          setCreating(false);
          notify('已创建');
          await reload();
          setEditing(result.world);
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const remove = async (world) => {
        if (!window.confirm(`删除世界书「${world.name}」？`)) return;
        setBusy(true);
        try {
          await call('/world/delete', { id: world.id });
          notify('已删除');
          await reload();
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const importFiles = async (files) => {
        if (!files?.length) return;
        setBusy(true);
        try {
          const payload = [];
          for (const file of files) {
            const text = await file.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { parsed = null; }
            if (parsed) payload.push({ name: file.name, data: parsed });
          }
          if (!payload.length) throw new Error('没读到合法的 JSON');
          const result = await call('/world/import', { files: payload });
          notify(`已导入 ${result.imported?.length ?? 0} 本`);
          await reload();
        } catch (error) { fail(error); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
      };

      if (editing) {
        return h(WorldEditor, {
          world: editing,
          data,
          onClose: () => setEditing(null),
          onSaved: async () => { notify('世界书已保存'); await reload(); setEditing(null); },
          fail,
        });
      }

      return h(React.Fragment, null, [
        h('div', { key: 'bar', className: 'wg-bar' }, [
          h('button', { key: 'new', className: 'wg-btn', disabled: busy, onClick: () => setCreating((v) => !v) }, '+ 新建'),
          creating ? h(NewNameRow, {
            key: 'newrow', label: '世界书名称', placeholder: '例如：雨城设定',
            busy, onCreate: create, onCancel: () => setCreating(false),
          }) : null,
          h('button', { key: 'imp', className: 'wg-btn', disabled: busy, onClick: () => fileRef.current?.click() }, '导入酒馆世界书 JSON'),
          h('input', {
            key: 'file', ref: fileRef, type: 'file', accept: '.json,application/json', multiple: true,
            style: { display: 'none' },
            onChange: (event) => importFiles(event.target.files),
          }),
          h('span', { key: 'n', className: 'wg-hint' }, `${data.worlds.length} 本 · 吃 ST 的 worlds/*.json（entries 数组或字典都行）`),
        ]),
        h(SearchInput,{key:'search',query,onChange:setQuery,label:'搜索世界书名称'}),
        ...data.worlds.filter(world=>matchesSearch(world,query)).map((world) => h('div', { key: world.id, className: 'wg-item' }, [
          h('div', { key: 'm', className: 'wg-item-main' }, [
            h('b', { key: 'b' }, world.name),
            h('div', { key: 'd' }, [
              `${world.entries} 条`,
              world.positions ? ` · ` + positions
                .filter((position) => world.positions[position.value])
                .map((position) => `${position.key}×${world.positions[position.value]}`)
                .join(' ') : '',
              ` · ${world.id}`,
            ].join('')),
          ]),
          h(Chips, {
            key: 'c', modes: data.modes, selected: world.modes, allowEmptyHint: true,
            onChange: async (list) => {
              try {
                const full = await call(`/world/${encodeURIComponent(world.id)}`);
                await call('/world/save', { world: { ...full.world, modes: list } });
                await reload();
              } catch (error) { fail(error); }
            },
          }),
          h('div', { key: 'o', className: 'wg-bar' }, [
            h('button', { key: 'e', className: 'wg-btn wg-btn-mini', onClick: () => open(world.id) }, '编辑条目'),
            h('button', { key: 'x', className: 'wg-btn wg-btn-mini', onClick: () => downloadJson(`/world/${encodeURIComponent(world.id)}/export`, `${world.id}.json`, (v) => v.world) }, '导出'),
            h('button', { key: 'd', className: 'wg-btn wg-btn-mini', onClick: () => remove(world) }, '删除'),
          ]),
        ])),
        data.worlds.length === 0 ? h('div', { key: 'empty', className: 'wg-empty' }, '还没有世界书。导入 ST 的 worlds/*.json，或点「+ 新建」。') : null,
      ]);
    }

    function PresetsPanel({ data, reload, notify, fail }) {
      const [query,setQuery]=useState('');
      const [creating, setCreating] = useState(false);
      const downloadJson = async (path, name, pick) => {
        try {
          const value = await call(path);
          // 导出本体（ST 结构），不是 { ok, world } 这种包装
          const body = pick ? pick(value) : value;
          const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = name;
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (error) { fail(error); }
      };
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const fileRef = useRef(null);

      const open = async (id) => {
        try {
          const result = await call(`/preset/${encodeURIComponent(id)}`);
          setEditing(result.preset);
        } catch (error) { fail(error); }
      };
      const create = async (name) => {
        setBusy(true);
        try {
          const result = await call('/preset/create', { name });
          setCreating(false);
          notify('已创建');
          await reload();
          setEditing(result.preset);
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const remove = async (preset) => {
        if (!window.confirm(`删除预设「${preset.name}」？`)) return;
        setBusy(true);
        try {
          await call('/preset/delete', { id: preset.id });
          notify('已删除');
          await reload();
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const importFiles = async (files) => {
        if (!files?.length) return;
        setBusy(true);
        try {
          const payload = [];
          for (const file of files) {
            const text = await file.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { parsed = null; }
            if (parsed) payload.push({ name: file.name, data: parsed });
          }
          if (!payload.length) throw new Error('没读到合法的 JSON');
          const result = await call('/preset/import', { files: payload });
          notify(`已导入 ${result.imported?.length ?? 0} 份`);
          await reload();
        } catch (error) { fail(error); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
      };

      if (editing) {
        return h(PresetEditor, {
          preset: editing,
          data,
          onClose: () => setEditing(null),
          onSaved: async () => { notify('预设已保存'); await reload(); setEditing(null); },
          fail,
        });
      }

      return h(React.Fragment, null, [
        h('div', { key: 'bar', className: 'wg-bar' }, [
          h('button', { key: 'new', className: 'wg-btn', disabled: busy, onClick: () => setCreating((v) => !v) }, '+ 新建'),
          creating ? h(NewNameRow, {
            key: 'newrow', label: '预设名称', placeholder: '例如：写作基础',
            busy, onCreate: create, onCancel: () => setCreating(false),
          }) : null,
          h('button', { key: 'imp', className: 'wg-btn', disabled: busy, onClick: () => fileRef.current?.click() }, '导入酒馆预设 JSON'),
          h('input', {
            key: 'file', ref: fileRef, type: 'file', accept: '.json,application/json', multiple: true,
            style: { display: 'none' },
            onChange: (event) => importFiles(event.target.files),
          }),
          h('span', { key: 'n', className: 'wg-hint' }, `${data.presets.length} 份 · 吃 ST 预设（prompts + prompt_order）/ 整份 settings.json`),
        ]),
        h(SearchInput,{key:'search',query,onChange:setQuery,label:'搜索预设名称'}),
        ...data.presets.filter(preset=>matchesSearch(preset,query)).map((preset) => h('div', { key: preset.id, className: 'wg-item', 'data-active': String(data.settings.presetId === preset.id) }, [
          h('div', { key: 'm', className: 'wg-item-main' }, [
            h('b', { key: 'b' }, preset.name),
            h('div', { key: 'd' }, [
              `${preset.enabled ?? 0}/${preset.prompts ?? 0} 条启用`,
              preset.markers?.length ? ` · marker ${preset.markers.join(' ')}` : '',
              data.settings.presetId === preset.id ? ' · 注入中' : '',
              ` · ${preset.id}`,
            ].filter(Boolean).join('')),
          ]),
          h(Chips, {
            key: 'c', modes: data.modes, selected: preset.modes, allowEmptyHint: true,
            onChange: async (list) => {
              try {
                const full = await call(`/preset/${encodeURIComponent(preset.id)}`);
                await call('/preset/save', { preset: { ...full.preset, modes: list } });
                await reload();
              } catch (error) { fail(error); }
            },
          }),
          h('div', { key: 'o', className: 'wg-bar' }, [
            h('button', { key: 'e', className: 'wg-btn wg-btn-mini', onClick: () => open(preset.id) }, '编辑'),
            h('button', { key: 'x', className: 'wg-btn wg-btn-mini', onClick: () => downloadJson(`/preset/${encodeURIComponent(preset.id)}/export`, `${preset.id}.json`, (v) => v.preset) }, '导出'),
            h('button', { key: 'd', className: 'wg-btn wg-btn-mini', onClick: () => remove(preset) }, '删除'),
          ]),
        ])),
        data.presets.length === 0 ? h('div', { key: 'empty', className: 'wg-empty' }, '还没有预设。导入 ST 预设 JSON，或点「+ 新建」。') : null,
      ]);
    }


    /** 内联新建行：Electron 没有 window.prompt，改用插件内输入框。 */
    function NewNameRow({ label, placeholder, busy, onCreate, onCancel }) {
      const [value, setValue] = useState('');
      const submit = () => {
        const name = value.trim();
        if (!name) return;
        onCreate(name);
        setValue('');
      };
      return h('div', { className: 'wg-row' }, [
        h('span', { key: 'l', className: 'wg-hint' }, label),
        h('input', {
          key: 'i', type: 'text', autoFocus: true, style: { width: '220px' }, value,
          placeholder: placeholder || '名称（可中文）',
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit();
            if (event.key === 'Escape') onCancel();
          },
        }),
        h('button', { key: 'ok', className: 'wg-btn wg-btn-primary', disabled: busy || !value.trim(), onClick: submit }, '确定'),
        h('button', { key: 'no', className: 'wg-btn', onClick: onCancel }, '取消'),
      ]);
    }

    // ------------------------------------------------------------ 作品 / 生成

    function WorldbookMultiSelect({ worlds, value, onChange, disabled }) {
      const [query,setQuery]=useState('');
      const selected=[...new Set(value??[])];
      const known=new Map((worlds??[]).map(world=>[world.id,world]));
      const choices=[...(worlds??[]),...selected.filter(id=>!known.has(id)).map(id=>({id,name:`已不存在：${id}`,missing:true}))];
      const names=selected.map(id=>known.get(id)?.name||id);
      const filtered=choices.filter(world=>(world.name||world.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      return h('details',{className:'wg-world-picker','data-world-multiselect':true},[
        h('summary',{key:'summary','aria-label':'指定世界书（可多选）',title:names.join('、')},[
          h('b',{key:'count'},`已选 ${selected.length} 本`),h('span',{key:'names'},names.join('、')||'点击选择世界书'),
        ]),
        h('div',{key:'body',className:'wg-world-picker-body'},[
          h('input',{key:'search',type:'search',value:query,placeholder:'搜索世界书','aria-label':'搜索世界书',onChange:event=>setQuery(event.target.value)}),
          h('div',{key:'options',className:'wg-world-options',role:'group','aria-label':'可选世界书'},filtered.map(world=>h('label',{key:world.id,className:'wg-world-option'},[
            h('input',{key:'check',type:'checkbox',checked:selected.includes(world.id),disabled,onChange:event=>onChange(event.target.checked?[...selected,world.id]:selected.filter(id=>id!==world.id))}),
            h('span',{key:'label',className:world.missing?'wg-err':undefined},world.name||world.id),
          ]))),
          !filtered.length?h('div',{key:'empty',className:'wg-hint'},choices.length?'没有匹配的世界书':'请先导入世界书'):null,
          h('div',{key:'actions',className:'wg-bar'},[
            h('button',{key:'clear',type:'button',className:'wg-btn wg-btn-mini',disabled:disabled||!selected.length,onClick:()=>onChange([])},'清空选择'),
            h('span',{key:'hint',className:'wg-hint'},'可勾选多本，点击下方“保存”后生效。'),
          ]),
        ]),
      ]);
    }

    /** 写作配置：默认值与会话绑定**分开编辑**，字段改动只进 draft，点保存才发请求。 */
    function ConfigPanel({ data, notify, fail, scopeSession, onScopeSessionChange }) {
      const [bindings, setBindings] = useState(null);
      const [cards, setCards] = useState([]);
      const [sessions, setSessions] = useState([]);
      const target=scopeSession; const setTarget=onScopeSessionChange;
      const [draft, setDraft] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);

      const loadBindings = useCallback(async () => {
        const state = await call('/bindings');
        setBindings(state);
        return state;
      }, []);

      useEffect(() => {
        loadBindings().then((state) => setDraft({ ...(state.defaults ?? {}) })).catch(fail);
        call('/cards').then((value) => setCards(value.cards ?? [])).catch(() => setCards([]));
        call('/sessions')
          .then((value) => setSessions(Array.isArray(value?.sessions) ? value.sessions : []))
          .catch(() => setSessions([]));
      }, [fail, loadBindings]);

      // 切换目标就重新装载：会话 → 其绑定（缺则默认副本）；默认 → defaults 副本
      useEffect(() => {
        if (!bindings) return;
        const source = target
          ? (bindings.bindings?.[target] ?? bindings.defaults ?? {})
          : (bindings.defaults ?? {});
        setDraft({ ...source });
        setDirty(false);
      }, [target, bindings]);

      if (!bindings || !draft) return h('div', { className: 'wg-empty' }, '读取写作配置…');

      const set = (patchValue) => {
        setDraft((prev) => ({ ...prev, ...patchValue }));
        setDirty(true);
      };

      const save = async () => {
        setSaving(true);
        try {
          const body = target ? { sessionId: target, binding: draft } : { defaults: draft };
          const state = await api('POST', '/bindings', body);
          setBindings(state);
          setDirty(false);
          notify(target ? '已保存到该会话（默认配置未变）' : '默认写作配置已保存');
        } catch (error) { fail(error); } finally { setSaving(false); }
      };

      const resetToDefault = async () => {
        if (!target) return;
        setSaving(true);
        try {
          const state = await api('POST', '/bindings', { sessionId: target, remove: true });
          setBindings(state);
          setDirty(false);
          notify('该会话已恢复为默认配置');
        } catch (error) { fail(error); } finally { setSaving(false); }
      };

      const worldMode = draft.worldSelection ?? ((draft.worldIds ?? []).length ? 'selected' : 'all');
      const sessionLabel = (session) => `${session.title || '（无标题）'} · ${String(session.id).slice(-6)}${session.preset === 'writer' ? '' : '（非写作模式）'}`;

      const currentPreset=(data.presets??[]).find(preset=>preset.id===draft.presetId);
      const compat=currentPreset?.compat;
      const compatGroups=[
        {label:'部分支持',items:compat?.partial??[]},
        {label:'SPreset 已接入',items:compat?.spreset?.supported??[]},
        {label:'SPreset 适配边界',items:compat?.spreset?.limitations??[]},
        {label:'暂未执行',items:compat?.unsupported??[]},
      ].filter(group=>group.items.length);
      const compatCount=compatGroups.reduce((count,group)=>count+group.items.length,0);
      const refreshSessions=async()=>{
        try{const value=await call('/sessions');setSessions(Array.isArray(value?.sessions)?value.sessions:[]);notify('会话已刷新');}
        catch(error){fail(error);}
      };
      const toggleEnabled=async()=>{
        try{const state=await api('POST','/bindings',{enabled:!bindings.enabled});setBindings(state);notify(state.enabled?'写作模式已启用':'写作模式已停用');}
        catch(error){fail(error);}
      };

      return h('div',{className:'wg-config'},[
        h('div',{key:'scroll',className:'wg-config-scroll'},h('div',{className:'wg-config-page'},[
          h('header',{key:'heading',className:'wg-config-heading'},[
            h('div',{key:'title'},[h('h2',{key:'h'},'写作配置'),h('p',{key:'p',className:'wg-config-lead'},'搭配素材与模型，回到写作模式会话开始创作。')]),
            h('button',{key:'enabled',type:'button',className:'wg-btn wg-status-toggle',disabled:saving||dirty,onClick:toggleEnabled,title:dirty?'先保存配置再切换启用状态':bindings.enabled?'点击停用写作模式':'点击启用写作模式','aria-label':bindings.enabled?'停用写作模式':'启用写作模式'},[
              h('span',{key:'dot',className:'wg-status-dot','data-off':String(!bindings.enabled),'aria-hidden':true}),bindings.enabled?'已启用':'已停用',
            ]),
          ]),
          h('div',{key:'scope',className:'wg-config-scope'},[
            h(Field,{key:'target',label:'配置应用于'},h('select',{value:target,disabled:saving,onChange:event=>setTarget(event.target.value)},[
              h('option',{key:'default',value:''},'默认配置'),
              ...(Array.isArray(sessions) ? sessions : []).map(session=>h('option',{key:session.id,value:session.id,disabled:session.preset!=='writer'},sessionLabel(session))),
            ])),
            h('button',{key:'refresh',type:'button',className:'wg-btn',disabled:saving,onClick:refreshSessions},'刷新会话'),
            h('div',{key:'hint',className:'wg-hint'},target?'仅影响所选会话；其他会话继续使用原来的配置。':'用于未设置独立配置的写作会话。'),
          ]),
          h('div',{key:'grid',className:'wg-config-grid'},[
            h('section',{key:'materials',className:'wg-config-section','aria-label':'写作素材'},[
              h('h3',{key:'heading'},'写作素材'),
              h(Field,{key:'preset',label:'预设'},h('select',{value:draft.presetId??'',disabled:saving,onChange:event=>set({presetId:event.target.value})},[
                h('option',{key:'none',value:''},'不使用预设'),
                ...(data.presets??[]).map(preset=>h('option',{key:preset.id,value:preset.id},preset.name||preset.id)),
              ])),
              h(Field,{key:'card',label:'角色卡'},h('select',{value:draft.cardId??'',disabled:saving,onChange:event=>set({cardId:event.target.value})},[
                h('option',{key:'none',value:''},'不使用角色卡'),
                ...cards.map(card=>h('option',{key:card.id,value:card.id},card.name||card.id)),
              ])),
              h('hr',{key:'divider',className:'wg-config-divider'}),
              h(Field,{key:'world-mode',label:'世界书范围'},h('select',{value:worldMode,disabled:saving,onChange:event=>set({worldSelection:event.target.value})},[
                h('option',{key:'all',value:'all'},'全部世界书'),
                h('option',{key:'selected',value:'selected'},'只用手动指定的'),
                h('option',{key:'none',value:'none'},'仅使用角色卡关联书'),
              ])),
              worldMode==='selected'?h(Field,{key:'worlds',label:'指定世界书（可多选）'},
                h(WorldbookMultiSelect,{worlds:data.worlds??[],value:draft.worldIds??[],disabled:saving,onChange:worldIds=>set({worldSelection:'selected',worldIds})})):null,
              h('div',{key:'world-hint',className:'wg-hint'},'角色卡关联书自动加入，重复选择只使用一次。'),
            ]),
            h('div',{key:'right',className:'wg-config-column'},[
              h('section',{key:'model',className:'wg-config-section','aria-label':'生成设置'},[
                h('h3',{key:'heading'},'生成设置'),
                h(Field,{key:'model',label:'写作模型'},h('select',{
                  value:draft.provider&&draft.model?`${draft.provider}/${draft.model}`:'',disabled:saving,
                  onChange:event=>{const [provider,...model]=event.target.value.split('/');set({provider,model:model.join('/')});},
                },[h('option',{key:'none',value:''},'选择模型'),...(data.routes??[]).map(route=>h('option',{key:`${route.provider}/${route.model}`,value:`${route.provider}/${route.model}`},`${route.provider} / ${route.model}`))])),
                h(Field,{key:'tokens',label:'输出上限（token）'},[
                  h('input',{key:'input',type:'number',min:0,step:128,value:draft.maxTokens??0,disabled:saving,onChange:event=>set({maxTokens:Number(event.target.value)||0})}),
                  h('span',{key:'hint',className:'wg-hint'},'0 使用全局设置；未设置时为 4096。实际值受模型上限限制。'),
                ]),
              ]),
              h('details',{key:'advanced',className:'wg-disclosure','data-config-advanced':true},[
                h('summary',{key:'summary'},'高级参数'),
                h('div',{key:'body',className:'wg-disclosure-body'},[
                  h(Field,{key:'context',label:'上下文窗口（token）'},[
                    h('input',{key:'input',type:'number',min:0,step:1024,value:draft.contextWindow??0,disabled:saving,onChange:event=>set({contextWindow:Number(event.target.value)||0})}),
                    h('span',{key:'hint',className:'wg-hint'},'0 沿用全局设置或模型提供的上下文容量。'),
                  ]),
                  h(Field,{key:'note',label:'作者注'},[
                    h('textarea',{key:'input',value:draft.authorNote??'',disabled:saving,placeholder:'补充叙事视角、文风或本轮写作要求',onChange:event=>set({authorNote:event.target.value})}),
                    h('span',{key:'hint',className:'wg-hint'},'用于补充写作要求，按预设位置注入。'),
                  ]),
                ]),
              ]),
              compatCount?h('details',{key:'compat',className:'wg-disclosure','data-config-compat':true},[
                h('summary',{key:'summary'},['预设兼容说明',h('span',{key:'count',className:'wg-tag'},`${compatCount} 项`)]),
                h('div',{key:'body',className:'wg-disclosure-body'},compatGroups.map(group=>h('div',{key:group.label},[
                  h('b',{key:'label'},group.label),
                  h('ul',{key:'items',className:'wg-compat-list wg-hint'},group.items.map((item,index)=>h('li',{key:index},item))),
                ]))),
              ]):null,
            ]),
          ]),
          h('details',{key:'help',className:'wg-config-help'},[
            h('summary',{key:'summary'},'如何开始写作'),
            h('p',{key:'body',className:'wg-hint'},'保存配置后，新建 DSH 会话并选择“写作模式”，直接在聊天输入框中发送写作要求。需要为不同会话使用不同素材时，在上方切换配置目标。'),
          ]),
        ])),
        h('footer',{key:'footer',className:'wg-config-footer'},h('div',{className:'wg-config-footer-inner'},[
          h('div',{key:'state',className:'wg-config-save-state','data-dirty':String(dirty),'aria-live':'polite'},[
            h('strong',{key:'label'},saving?'正在保存…':dirty?'有未保存的更改':'配置已保存'),
            h('span',{key:'hint',className:'wg-hint'},target?'保存到当前会话':'保存为默认写作配置'),
          ]),
          h('div',{key:'actions',className:'wg-config-actions'},[
            target?h('button',{key:'reset',type:'button',className:'wg-btn',disabled:saving,onClick:resetToDefault},'恢复默认'):null,
            h('button',{key:'save',type:'button',className:'wg-btn wg-btn-primary',disabled:saving||!dirty,onClick:save},target?'保存此会话配置':'保存默认配置'),
          ]),
        ])),
      ]);
    }

    /** 角色卡：JSON/PNG 导入、编辑基础字段与开场白、导出。 */
    function CardsPanel({ notify, fail }) {
      const [query,setQuery]=useState('');
      const [cards, setCards] = useState(null);
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const fileRef = useRef(null);
      const load = useCallback(async () => {
        try { setCards(await call('/cards').then((value) => value.cards ?? [])); } catch (error) { fail(error); }
      }, [fail]);
      useEffect(() => { load(); }, [load]);

      const importFile = async (file) => {
        if (!file) return;
        setBusy(true);
        try {
          const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
          let payload;
          if (isPng) {
            if(file.size>20*1024*1024)throw new Error('PNG 超过 20 MB');
            const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
            for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
            payload={pngBase64:btoa(binary)};
          } else payload={card:JSON.parse(await file.text())};
          let imported;
          try{imported=await api('POST','/cards/import',payload);}
          catch(error){
            if(!String(error.message).includes('同名世界书')||!window.confirm('存在不同内容的同名世界书。按酒馆导入逻辑覆盖并关联到此角色卡？'))throw error;
            imported=await api('POST','/cards/import',{...payload,overwriteWorld:true});
          }
          await load();
          notify(imported.world?'角色卡已导入，内置世界书已加入列表并关联':'角色卡已导入');
        } catch (error) { fail(error); } finally { setBusy(false); }
      };

      const save = async (card) => {
        setBusy(true);
        try {
          const result = await api('POST', '/cards', { card });
          await load();
          setEditing(result.card);
          notify('角色卡已保存');
        } catch (error) { fail(error); } finally { setBusy(false); }
      };

      if (!cards) return h('div', { className: 'wg-empty' }, '读取角色卡…');
      return h('div', {className:'wg-collection'}, [
        h('div', { key: 'bar', className: 'wg-row' }, [
          h('button', { key: 'imp', className: 'wg-btn', disabled: busy, onClick: () => fileRef.current?.click() }, '导入 JSON / PNG 卡'),
          h('input', {
            key: 'file', type: 'file', accept: '.json,.png,image/png', ref: fileRef, style: { display: 'none' },
            onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file); },
          }),
          h('span', { key: 'h', className: 'wg-hint' }, '导入 JSON 或 PNG 角色卡，内置世界书自动关联。脚本是否运行由扩展来源开关控制。'),
        ]),
        cards.length === 0 ? h('div', { key: 'empty', className: 'wg-empty' }, '还没有角色卡') : null,
        h(SearchInput,{key:'search',query,onChange:setQuery,label:'搜索角色卡名称'}),
        ...cards.filter(card=>matchesSearch(card,query)).map((card) => h('div', { key: card.id, className: 'wg-item' }, [
          h('div', { key: 'main', className: 'wg-item-main' }, [h('b', {}, card.name || card.id), h('span', { className: 'wg-hint' }, ` ${card.spec} · ${card.characterBook?.entries?.length ?? 0} 条世界书条目`)]),
          h('div', { key: 'ops', className: 'wg-item-ops' }, [
            h('button', { key: 'e', className: 'wg-btn wg-btn-mini', onClick: () => setEditing(card) }, '编辑'),
            h('button', {
              key: 'x', className: 'wg-btn wg-btn-mini',
              onClick: async () => {
                try {
                  const value = await call(`/cards/${encodeURIComponent(card.id)}/export`);
                  const blob = new Blob([JSON.stringify(value.card, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url; anchor.download = `${card.id}.json`; anchor.click();
                  URL.revokeObjectURL(url);
                } catch (error) { fail(error); }
              },
            }, '导出'),
            h('button', {
              key: 'd', className: 'wg-btn wg-btn-mini',
              onClick: async () => {
                if (!window.confirm(`删除角色卡「${card.name}」？`)) return;
                try { await api('DELETE', `/cards/${encodeURIComponent(card.id)}`); await load(); notify('已删除'); } catch (error) { fail(error); }
              },
            }, '删除'),
          ]),
        ])),
        editing ? h('div', { key: 'editor', className: 'wg-card' }, [
          h('h4', { key: 'h' }, `编辑：${editing.name}`),
          h(Field, { key: 'n', label: '名字' }, h('input', { value: editing.name ?? '', onChange: (event) => setEditing({ ...editing, name: event.target.value }) })),
          h(Field, { key: 'd', label: '描述（description）' }, h('textarea', { style: { minHeight: '70px' }, value: editing.description ?? '', onChange: (event) => setEditing({ ...editing, description: event.target.value }) })),
          h(Field, { key: 'f', label: '开场白（first_mes）' }, h('textarea', { style: { minHeight: '60px' }, value: editing.firstMes ?? '', onChange: (event) => setEditing({ ...editing, firstMes: event.target.value }) })),
          h(Field, { key: 'g', label: '使用哪个开场白' },
            h('select', {
              value: editing.greetingPolicy ?? 'first',
              onChange: (event) => setEditing({ ...editing, greetingPolicy: event.target.value }),
            }, [h('option', { key: 'first', value: 'first' }, '第一条（first_mes）')]
              .concat((editing.alternateGreetings ?? []).map((_value, index) => h('option', { key: `alt${index}`, value: `alternate:${index}` }, `备用开场白 ${index + 1}`)))
              .concat([h('option', { key: 'none', value: 'none' }, '不注入开场白')]))),
          h('div', { key: 'tip', className: 'wg-hint' }, '开场白只作为写作模式首轮的上下文种子出现一次，不会伪造你的输入。'),
          h('div', { key: 'ops', className: 'wg-row' }, [
            h('button', { key: 's', className: 'wg-btn wg-btn-primary', disabled: busy, onClick: () => save(editing) }, '保存'),
            h('button', { key: 'c', className: 'wg-btn', onClick: () => setEditing(null) }, '关闭'),
          ]),
        ]) : null,
      ]);
    }

    /** 扩展：正则 / 模板 / 助手（三分区，明确列 unsupported）。 */
    function RegexRuleForm({text,onChange}){
      let rule;try{rule=JSON.parse(text);}catch{return h('div',{className:'wg-hint'},'JSON 尚未完整，请先修正高级编辑内容。');}
      if(!rule||Array.isArray(rule))return null;
      const patch=value=>onChange(JSON.stringify({...rule,...value},null,2));
      const placement=(value,checked)=>patch({placement:checked?[...new Set([...(rule.placement??[]),value])]:(rule.placement??[]).filter(item=>item!==value)});
      return h('div',{className:'wg-card','aria-label':'正则编辑'},[
        h(Field,{key:'name',label:'规则名称'},h('input',{value:rule.scriptName??'',onChange:e=>patch({scriptName:e.target.value})})),
        h(Field,{key:'find',label:'查找表达式'},h('input',{value:rule.findRegex??'',placeholder:'/pattern/g',onChange:e=>patch({findRegex:e.target.value})})),
        h(Field,{key:'replace',label:'替换内容'},h('textarea',{value:rule.replaceString??'',onChange:e=>patch({replaceString:e.target.value})})),
        h('div',{key:'targets',className:'wg-row'},[[1,'用户消息'],[2,'助手消息']].map(([value,label])=>h('label',{key:value},[h('input',{type:'checkbox',checked:(rule.placement??[]).includes(value),onChange:e=>placement(value,e.target.checked)}),label]))),
        h('div',{key:'channels',className:'wg-row'},[['promptOnly','发送给模型'],['markdownOnly','写作阅读显示'],['runOnEdit','编辑后重算']].map(([key,label])=>h('label',{key},[h('input',{type:'checkbox',checked:rule[key]===true,onChange:e=>patch({[key]:e.target.checked})}),label]))),
        h('div',{key:'hint',className:'wg-hint'},'替换为空可隐藏匹配片段。未勾选发送或显示时按通用文本规则处理。'),
      ]);
    }

    function ExtensionsPanel({ data, notify, fail, scopeSession, onScopeSessionChange }) {
      const [section,setSection]=useState('regex'),[state,setState]=useState(null),[sessions,setSessions]=useState([]);
      const [inspect,setInspect]=useState(false),[presetId,setPresetId]=useState(''),[cardId,setCardId]=useState('');
      const [sourceType,setSourceType]=useState('global'),[editor,setEditor]=useState(null),[text,setText]=useState(''),[result,setResult]=useState('');
      const [busy,setBusy]=useState(false),[template,setTemplate]=useState({enabled:false,allowedPresetIds:[]});
      const [previewText,setPreviewText]=useState(''),[mode,setMode]=useState('send'),[placement,setPlacement]=useState(2),[depth,setDepth]=useState(0);
      const selection={sessionId:scopeSession,inspect,presetId,cardId};
      const requestSeq=useRef(0);
      const load=useCallback(async()=>{
        const seq=++requestSeq.current;
        try {
          const query=new URLSearchParams({sessionId:scopeSession,inspect:String(inspect),presetId,cardId});
          const value=await call('/extensions/scopes?'+query);
          if(seq!==requestSeq.current)return;
          setState(value);setTemplate(value.template);
          const listing=await call('/sessions');if(seq===requestSeq.current)setSessions((listing.sessions??[]).filter(s=>s.writer||s.preset==='writer'));
        } catch(e){if(seq===requestSeq.current)fail(e);}
      },[scopeSession,inspect,presetId,cardId,fail]);
      useEffect(()=>{setState(null);setEditor(null);setText('');setResult('');load();},[load]);
      useEffect(()=>{
        if(editor||busy||section==='template')return;
        const refresh=()=>{if(document.visibilityState!=='hidden')load();};
        const timer=setInterval(refresh,5000);window.addEventListener('focus',refresh);
        return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};
      },[load,editor,busy,section]);
      if(!state)return h('div',{},'读取来源扩展…');
      const kind=section==='helper'?'helper':'regex';
      const source=state.sources.find(s=>s.type===sourceType)??state.sources[0];
      const scope={type:source.type,id:source.id};
      const items=kind==='regex'?source.regex:source.scripts;
      const rev=kind==='regex'?source.regexRevision:source.helperRevision;
      const allowed=kind==='regex'?source.regexAllowed:source.helperAllowed;
      const labels={global:'全局',preset:'预设',character:'角色卡'};
      const act=async(fn,refresh=true)=>{setBusy(true);try{const value=await fn();setResult(JSON.stringify(value,null,2));setEditor(null);setText('');if(refresh)await load();notify('操作完成');}catch(e){fail(e);}finally{setBusy(false);}};
      const button=(name,fn,disabled=false)=>h('button',{className:'wg-btn',disabled:busy||disabled,onClick:fn},name);
      const saveItems=next=>act(()=>api('POST','/extensions/scope/save',{scope,kind,revision:rev,items:next}));
      const editAt=(path,change)=>{const next=JSON.parse(JSON.stringify(items));let list=next;for(const index of path.slice(0,-1))list=list[index].scripts;change(list,path.at(-1));saveItems(next);};
      const download=()=>{
        const clean=node=>{const out=JSON.parse(JSON.stringify(node));if(out.type==='folder')out.scripts=(out.scripts??[]).map(clean);else if(kind==='helper'){if(out.export_with?.data===false)out.data={};if(out.export_with?.button===false&&out.button)out.button.buttons=[];}return out;};
        const blob=new Blob([JSON.stringify(items.map(clean),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=source.type+'-'+source.id+'-'+kind+'.json';a.click();URL.revokeObjectURL(url);
      };
      const renderItems=(list,parent=[],parentEnabled=true)=>list.map((item,index)=>{
        const path=[...parent,index],folder=kind==='helper'&&item.type==='folder';
        const enabled=kind==='regex'?!item.disabled:item.enabled===true,effective=allowed&&parentEnabled&&enabled;
        return h('div',{key:path.join('.'),className:'wg-card'},[
          h('div',{className:'wg-bar'},[
            h('b',{},(folder?'📁 ':'')+(item.scriptName??item.name??'未命名')),
            h('span',{className:'wg-hint'},effective?'已启用':!enabled?'条目停用':!parentEnabled?'文件夹停用':'来源未启用'),
            button(enabled?'停用条目':'启用条目',()=>editAt(path,(xs,i)=>{xs[i]={...xs[i],...(kind==='regex'?{disabled:enabled}:{enabled:!enabled})};})),
            button('编辑',()=>{setEditor({scope,kind,revision:rev,path,items:JSON.parse(JSON.stringify(items))});setText(JSON.stringify(item,null,2));}),
            button('上移',()=>editAt(path,(xs,i)=>{[xs[i-1],xs[i]]=[xs[i],xs[i-1]];}),index===0),
            button('下移',()=>editAt(path,(xs,i)=>{[xs[i+1],xs[i]]=[xs[i],xs[i+1]];}),index===list.length-1),
            button('删除',()=>{if(window.confirm('从所属'+labels[source.type]+'删除此条目？'))editAt(path,(xs,i)=>xs.splice(i,1));}),
            kind==='helper'&&!folder?button('手动运行',()=>act(()=>api('POST','/extensions/scope/run',{scope,revision:rev,scriptId:item.id,sessionId:scopeSession})),!effective||!scopeSession||inspect):null,
          ]),folder?h('div',{style:{paddingLeft:16}},renderItems(item.scripts??[],path,parentEnabled&&enabled)):null,
        ]);
      });
      return h('div',{className:'wg-body'},[
        h('div',{key:'tabs',className:'wg-bar'},[['regex','正则'],['template','提示词模板'],['helper','酒馆助手']].map(([id,name])=>h('button',{key:id,className:'wg-btn'+(section===id?' wg-btn-primary':''),disabled:busy,onClick:()=>{setSection(id);setEditor(null);setText('');setResult('');}},name))),
        h('div',{key:'context',className:'wg-card'},[
          ...(state.missing??[]).map((m,i)=>h('div',{key:'missing'+i,className:'wg-err'},m)),
          h(Field,{label:'跟随写作会话的预设和角色卡'},h('select',{value:scopeSession,disabled:busy,onChange:e=>{onScopeSessionChange(e.target.value);setInspect(false);}},[h('option',{value:''},'默认写作配置'),...sessions.map(s=>h('option',{key:s.id,value:s.id},s.title||s.id))])),
          h('label',{},[h('input',{type:'checkbox',checked:inspect,disabled:busy,onChange:e=>setInspect(e.target.checked)}),' 浏览其它素材（不改变会话绑定）']),
          inspect?h('div',{className:'wg-bar'},[
            h('select',{value:presetId,onChange:e=>setPresetId(e.target.value)},[h('option',{value:''},'不选预设'),...state.presets.map(p=>h('option',{key:p.id,value:p.id},p.name))]),
            h('select',{value:cardId,onChange:e=>setCardId(e.target.value)},[h('option',{value:''},'不选角色卡'),...state.cards.map(c=>h('option',{key:c.id,value:c.id},c.name))]),
          ]):null,
          !scopeSession&&!inspect?h('label',{className:'wg-hint'},[
            h('input',{type:'checkbox',checked:state.resident?.defaultEnabled===true,disabled:busy,onChange:e=>act(()=>api('POST','/extensions/resident/default',{enabled:e.target.checked}))}),
            ' 写作会话默认使用常驻运行器（各会话仍可单独关闭）',
          ]):null,
          scopeSession&&!inspect?h('div',{className:'wg-card'},[
            h('h4',{},'常驻脚本运行（实验）'),
            h('div',{className:'wg-hint'},'使用独立浏览器保持脚本与事件；仅运行已启用来源的脚本。仍有未实现的界面API。外部模块固定缓存，脚本联网被阻止；世界书运行改动暂保存在会话副本。'),
            ...(()=>{const enabled=!state.resident?.disabledSessionIds?.includes(scopeSession)&&(state.resident?.defaultEnabled===true||state.resident?.sessionIds?.includes(scopeSession));return [button(enabled?'关闭本会话常驻运行':'开启本会话常驻运行',()=>act(()=>api('POST','/extensions/resident',{sessionId:scopeSession,enabled:!enabled})))];})(),
          ]):null,
          h('div',{className:'wg-hint'},'附带条目直接来自所属素材，导入、替换或切换绑定后自动更新，不复制为全局扩展。修改素材会影响使用同一素材的其它会话。'),
        ]),
        section!=='template'?h('div',{key:'sources',className:'wg-bar'},state.sources.map(s=>h('button',{key:s.key,className:'wg-btn'+(s.type===source.type?' wg-btn-primary':''),disabled:busy,onClick:()=>{setSourceType(s.type);setEditor(null);setText('');}},labels[s.type]+' · '+s.name+' ('+(kind==='regex'?s.regex.length:s.scripts.length)+')'))):null,
        section!=='template'?h('div',{key:'owner',className:'wg-card'},[
          h('h4',{},labels[source.type]+'：'+source.name),
          kind==='regex'&&source.type==='global'?h('div',{className:'wg-hint'},'全局正则按各条目启停状态执行。'):button(allowed?'停用此来源':'启用此来源',()=>act(()=>api('POST','/extensions/scope/allowed',{scope,kind,enabled:!allowed}))),
          h('div',{className:'wg-hint'},kind==='regex'?'执行顺序：全局 → 当前预设 → 当前角色卡。显示规则在同一会话的“写作阅读”生效。':'来源、文件夹、脚本三层开关分别生效。常驻模式支持部分事件、MVU、按钮和独立脚本界面；联网和宿主历史改写暂不支持。'),
          ...renderItems(items),!items.length?h('div',{className:'wg-hint'},'该来源暂无附带条目。'):null,
          h('div',{className:'wg-bar'},[
            button('新建',()=>{setEditor({scope,kind,revision:rev,path:null,items:JSON.parse(JSON.stringify(items))});setText(JSON.stringify(kind==='regex'?{scriptName:'新正则',findRegex:'/旧词/g',replaceString:'新词',placement:[2],promptOnly:true,disabled:false,trimStrings:[],minDepth:null,maxDepth:null}:{type:'script',name:'新脚本',enabled:false,content:'console.log(getVariables());',data:{},button:{enabled:true,buttons:[]}},null,2));}),
            kind==='helper'?button('新建文件夹',()=>saveItems([...items,{type:'folder',name:'新文件夹',enabled:true,scripts:[]}])):null,
            button('导出此来源',download),
            h('label',{className:'wg-btn'},['选择 JSON 文件',h('input',{type:'file',accept:'.json,application/json',style:{display:'none'},disabled:busy,onChange:async e=>{try{setEditor({scope,kind,revision:rev,import:true});setText(await e.target.files[0].text());}catch(x){fail(x);}e.target.value='';}})]),
          ]),
          kind==='regex'&&editor&&!editor.import?h(RegexRuleForm,{text,onChange:setText}):null,
          h('details',{key:'json',className:'wg-disclosure',open:editor?.import===true},[
            h('summary',{key:'summary'},editor?.import?'导入 JSON':'高级 JSON 编辑'),
            h('div',{key:'body',className:'wg-disclosure-body'},h(Field,{label:'条目 JSON / 导入内容'},h('textarea',{value:text,onChange:e=>{setText(e.target.value);if(!editor)setEditor({scope,kind,revision:rev,import:true});}}))),
          ]),
          button(editor?.import?'导入到所选来源':'保存到所属素材',()=>act(async()=>{
            if(!editor)throw Error('请先选择编辑或导入');const item=JSON.parse(text);
            if(editor.import||editor.path===null)return api('POST','/extensions/scope/import',{...editor,data:item});
            const next=editor.items;let list=next;for(const i of editor.path.slice(0,-1))list=list[i].scripts;list[editor.path.at(-1)]=item;
            return api('POST','/extensions/scope/save',{scope:editor.scope,kind:editor.kind,revision:editor.revision,items:next});
          }),!text.trim()),
        ]):null,
        section==='regex'?h('div',{key:'preview',className:'wg-card'},[
          h('h4',{},'预览当前来源组合（遵循各来源和条目开关）'),
          h('div',{className:'wg-bar'},[
            h('select',{value:mode,onChange:e=>setMode(e.target.value)},[h('option',{value:'send'},'发送给模型'),h('option',{value:'display'},'写作阅读显示效果')]),
            h('select',{value:placement,onChange:e=>setPlacement(Number(e.target.value))},[h('option',{value:1},'用户消息'),h('option',{value:2},'助手消息')]),
            h('input',{type:'number',min:0,value:depth,onChange:e=>setDepth(Number(e.target.value)),style:{width:80},'aria-label':'消息深度'}),
          ]),h('textarea',{value:previewText,onChange:e=>setPreviewText(e.target.value),'aria-label':'正则测试文本'}),
          button('运行预览',()=>act(()=>api('POST','/extensions/scope/preview',{...selection,text:previewText,mode,placement,depth}),false)),
        ]):null,
        section==='template'?h('div',{key:'template',className:'wg-card'},[
          h('h4',{},'提示词模板（现有 EJS 基础兼容）'),h('div',{className:'wg-hint'},'此处保留现有预设启用范围；完整酒馆模板选项与事件尚未移植。'),
          h('label',{},[h('input',{type:'checkbox',checked:template.enabled,onChange:e=>setTemplate({...template,enabled:e.target.checked})}),'启用']),
          ...state.presets.map(p=>h('label',{key:p.id},[h('input',{type:'checkbox',checked:template.allowedPresetIds.includes(p.id),onChange:e=>setTemplate({...template,allowedPresetIds:e.target.checked?[...template.allowedPresetIds,p.id]:template.allowedPresetIds.filter(id=>id!==p.id)})}),p.name])),
          button('保存模板设置',()=>act(()=>api('POST','/extensions/template',template))),
          h('textarea',{value:previewText,onChange:e=>setPreviewText(e.target.value),'aria-label':'EJS模板预览'}),button('运行模板预览',()=>act(()=>api('POST','/extensions/template/preview',{text:previewText}),false)),
        ]):null,
        h('pre',{key:'result',className:'wg-pre',style:{whiteSpace:'pre-wrap',maxHeight:320,overflow:'auto'}},result),
      ]);
    }

    function WorksPanel({ data, reload, notify, fail }) {
      const [query,setQuery]=useState('');
      const [creating, setCreating] = useState(false);
      const [works, setWorks] = useState([]);
      const [current, setCurrent] = useState(null);
      const [chat, setChat] = useState([]);
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState(false);
      const [reply, setReply] = useState('');

      const refreshWorks = useCallback(async () => {
        try {
          const result = await call('/work/list');
          setWorks(result.works ?? []);
        } catch (error) { fail(error); }
      }, [fail]);
      useEffect(() => { refreshWorks(); }, [refreshWorks]);

      const open = async (id) => {
        try {
          const result = await call(`/work/${encodeURIComponent(id)}`);
          setCurrent(result.work);
          setChat(result.chat ?? []);
          setReply('');
        } catch (error) { fail(error); }
      };
      const create = async (title) => {
        try {
          const result = await call('/work/save', {
            work: { title, presetId: data.settings.presetId, worldIds: [], authorNote: '' },
          });
          await refreshWorks();
          await open(result.work.id);
          setCreating(false);
          notify('已创建作品');
        } catch (error) { fail(error); }
      };
      const saveCurrent = async (patchValue) => {
        if (!current) return;
        try {
          const result = await call('/work/save', { work: { ...current, ...patchValue } });
          setCurrent(result.work);
          await refreshWorks();
          notify('作品已保存');
        } catch (error) { fail(error); }
      };
      const remove = async (work) => {
        if (!window.confirm(`删除作品「${work.title}」？`)) return;
        try {
          await call('/work/delete', { id: work.id });
          if (current?.id === work.id) { setCurrent(null); setChat([]); }
          await refreshWorks();
          notify('已删除');
        } catch (error) { fail(error); }
      };
      const generate = async () => {
        if (!current || !message.trim()) return;
        setBusy(true);
        setReply('');
        try {
          const result = await call('/work/generate', { workId: current.id, message });
          if (!result.ok) {
            fail(new Error(result.detail || '生成未完成（正文未保存）'));
            return;
          }
          setReply(result.text);
          setMessage('');
          const fresh = await call(`/work/${encodeURIComponent(current.id)}`);
          setChat(fresh.chat ?? []);
          notify(`生成完成：${result.detail}`);
        } catch (error) { fail(error); } finally { setBusy(false); }
      };
      const exportWork = async () => {
        if (!current) return;
        try {
          const result = await call(`/work/${encodeURIComponent(current.id)}`);
          const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${current.id}.json`;
          anchor.click();
          URL.revokeObjectURL(url);
        } catch (error) { fail(error); }
      };

      const presets = data.presets ?? [];
      const worlds = data.worlds ?? [];

      return h(React.Fragment, null, [
        h('div', { key: 'bar', className: 'wg-bar' }, [
          h('button', { key: 'new', className: 'wg-btn', onClick: () => setCreating((v) => !v) }, '+ 新建作品'),
          creating ? h(NewNameRow, {
            key: 'newrow', label: '作品名称', placeholder: '例如：雨城故事',
            busy: false, onCreate: create, onCancel: () => setCreating(false),
          }) : null,
          h('button', { key: 'rf', className: 'wg-btn', onClick: refreshWorks }, '刷新'),
          h('span', { key: 'n', className: 'wg-hint' }, `${works.length} 个作品 · 生成走本插件自己的请求通道（不经 DSH 会话历史）`),
        ]),
        h(SearchInput,{key:'search',query,onChange:setQuery,label:'搜索旧版作品'}),
        ...works.filter(work=>matchesSearch(work,query)).map((work) => h('div', {
          key: work.id,
          className: 'wg-item',
          'data-active': String(current?.id === work.id),
        }, [
          h('div', { key: 'm', className: 'wg-item-main' }, [
            h('b', { key: 'b' }, work.title),
            h('div', { key: 'd' }, `${work.messages ?? 0} 条 · 预设 ${work.presetId || '未指定'} · 世界书 ${(work.worldIds ?? []).length || '全部'} · ${work.id}`),
          ]),
          h('div', { key: 'o', className: 'wg-bar' }, [
            h('button', { key: 'open', className: 'wg-btn wg-btn-mini', onClick: () => open(work.id) }, '打开'),
            h('button', { key: 'del', className: 'wg-btn wg-btn-mini', onClick: () => remove(work) }, '删除'),
          ]),
        ])),
        works.length === 0 ? h('div', { key: 'empty', className: 'wg-empty' }, '还没有作品。新建一个，绑定预设与世界书后就能生成。') : null,

        current ? h('div', { key: 'editor', className: 'wg-card' }, [
          h('h4', { key: 'h' }, `作品：${current.title}`),
          h('div', { key: 'row', className: 'wg-row' }, [
            h('label', null, '预设',
              h('select', {
                value: current.presetId ?? '',
                onChange: (event) => saveCurrent({ presetId: event.target.value }),
              }, [h('option', { key: '', value: '' }, '（不注入预设）')].concat(
                presets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.name)),
              ))),
            h('button', { key: 'exp', className: 'wg-btn wg-btn-mini', onClick: exportWork }, '导出 JSON'),
          ]),
          h('div', { key: 'routeRow', className: 'wg-row' }, [
            h('label', { key: 'l' }, '本作品 route',
              h('select', {
                key: 's',
                value: current.route
                  ? (current.route.transport === 'chat'
                    ? `chat:${current.route.provider}/${current.route.model}`
                    : `${current.route.provider}/${current.route.model}`)
                  : '',
                onChange: (event) => {
                  const value = event.target.value;
                  if (!value) return saveCurrent({ route: null });
                  if (value.startsWith('chat:')) {
                    const [provider, ...rest] = value.slice(5).split('/');
                    return saveCurrent({ route: { provider, model: rest.join('/'), transport: 'chat' } });
                  }
                  const [provider, ...rest] = value.split('/');
                  return saveCurrent({ route: { provider, model: rest.join('/'), transport: 'llm' } });
                },
              }, [h('option', { key: '', value: '' }, '跟随全局默认模型')].concat(
                [h('option', { key: 'chat-catiecli', value: 'chat:catiecli/vtx-gemini-4-argon' },
                  '兼容 Chat 接口（catiecli，保留角色与顺序 · 已实测）')],
                (data.routes ?? []).filter((route) => route.provider !== 'catiecli').map((route) => h('option', {
                  key: `${route.provider}/${route.model}`,
                  value: `${route.provider}/${route.model}`,
                }, `${route.provider} / ${route.model}（宿主通道）`)),
              ))),
            h('span', { key: 'h', className: 'wg-hint' }, '通道说明：选「兼容 Chat 接口」时按严格角色顺序发送（保留 @D/PHI 的 system 位置）；选宿主通道时由宿主适配器决定，可能合并 system。'),
          ]),
          h('div', { key: 'wl', className: 'wg-hint' }, '世界书（不选 = 使用全部世界书；普通 DSH 会话里这些条目只按系统段近似注入）'),
          h('div', { key: 'chips', className: 'wg-chips' }, worlds.map((world) => {
            const on = (current.worldIds ?? []).includes(world.id);
            return h('button', {
              key: world.id,
              className: 'wg-chip',
              'data-on': String(on),
              onClick: () => saveCurrent({
                worldIds: on
                  ? (current.worldIds ?? []).filter((id) => id !== world.id)
                  : [...(current.worldIds ?? []), world.id],
              }),
            }, world.name);
          })),
          h(Field, { key: 'an', label: '作者注（没有 authorsNote marker 时按 depth 4 / system 插入）' },
            h('textarea', {
              value: current.authorNote ?? '',
              onChange: (event) => setCurrent({ ...current, authorNote: event.target.value }),
              onBlur: () => saveCurrent({ authorNote: current.authorNote ?? '' }),
            })),
          h('div', { key: 'legacy', className: 'wg-hint' },
            '旧版数据：这些作品是插件早期的独立生成记录，只读与导出；写作请到 DSH 新建会话并选「写作模式」。'),
          h('div', { key: 'say', className: 'wg-row', style: { display: 'none' } }, [
            h('input', {
              key: 'msg', type: 'text', style: { flex: '1 1 320px' }, value: message,
              placeholder: '这一轮写什么…（Enter 生成）',
              onChange: (event) => setMessage(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && !busy) generate(); },
            }),
            h('button', { key: 'go', className: 'wg-btn wg-btn-primary', disabled: busy, onClick: generate }, busy ? '生成中…' : '生成'),
          ]),
          reply ? h('pre', { key: 'reply', className: 'wg-pre' }, reply) : null,
          chat.length ? h('details', { key: 'hist', className: 'wg-card' }, [
            h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12.5px', fontWeight: '600' } },
              `作品历史 ${chat.length} 条（点开看已保存的正文）`),
            ...chat.map((row, index) => h('div', { key: `h${index}`, className: 'wg-entry' }, [
              h('div', { key: 'head', className: 'wg-hint' },
                `${row.role === 'user' ? '我' : '模型'}${row.time ? ` · ${String(row.time).replace('T', ' ').slice(0, 19)}` : ''}`),
              h('div', { key: 'body', className: 'wg-hint', style: { whiteSpace: 'pre-wrap' } }, String(row.content ?? '')),
            ])),
          ]) : null,
        ]) : null,
      ]);
    }

    // ------------------------------------------------------------------ shell
    function App() {
      const [tab, setTab] = useState('config');
      const [scopeSession,setScopeSession]=useState('');
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [message, setMessage] = useState('');

      const notify = useCallback((text) => { setMessage(text); setError(''); }, []);
      const fail = useCallback((issue) => { setError(issue?.message ?? String(issue)); setMessage(''); }, []);
      const reload = useCallback(async () => {
        try {
          const result = await call('/state');
          setData(result);
          setError('');
          return result;
        } catch (issue) {
          fail(issue);
          return null;
        }
      }, [fail]);

      useEffect(() => { reload(); }, [reload]);

      // Host 与页面版本错配时锁定面板，避免用旧接口写坏新结构的数据
      const staleHost = Boolean(data) && data.api !== 2;

      return h('div', { className: 'wg-app' }, [
        h(Styles, { key: 'style' }),
        h('div', { key: 'head', className: 'wg-head' }, [
          h('span', { key: 't', className: 'wg-title' }, '✍️ 写作指导'),
          h('div', { key: 'tabs', className: 'wg-tabs' }, [
            ['config', '写作配置'],
            ['cards', '角色卡'],
            ['ext', '扩展'],
            ['inject', '注入'],
            ['worlds', '世界书'],
            ['presets', '预设'],
            ['works', '旧版作品'],
          ].map(([id, label]) => h('button', {
            key: id,
            'aria-selected': String(tab === id),
            disabled: staleHost,
            onClick: () => setTab(id),
          }, label))),
        ]),
        h('div', { key: 'body', className: 'wg-body'+(tab==='config'?' wg-body-config':'') }, [
          tab!=='config'?h('header',{key:'page-heading',className:'wg-page-heading'},[
            h('h2',{key:'title'},({cards:'角色卡',ext:'扩展',inject:'注入设置',worlds:'世界书',presets:'预设',works:'旧版作品'})[tab]),
            h('p',{key:'description'},({cards:'管理角色设定与开场白，关联世界书随卡片保存。',ext:'按来源管理正则、模板与助手，设置只影响对应素材。',inject:'管理提示词的注入规则，并用预览核对效果。',worlds:'管理世界设定与关键词条目，在写作配置中选择要使用的书。',presets:'管理提示词顺序、角色和 SPreset 扩展配置。',works:'查看与导出旧版作品。新的创作建议使用正常写作会话。'})[tab]),
          ]):null,
          message ? h('div', { key: 'ok', className: 'wg-ok' }, message) : null,
          error ? h('div', { key: 'err', className: 'wg-err' }, error) : null,
          !data
            ? h('div', { key: 'loading', className: 'wg-empty' }, '读取写作指导数据…（Host 改动后需重启 DSH）')
            : staleHost
              ? h('div', { key: 'stale', className: 'wg-card' }, [
                h('h4', { key: 'h' }, 'Host 还是旧版本'),
                h('div', { key: 'b', className: 'wg-hint' },
                  `页面上是新版界面（ST 结构），但 /api/writing-guide 返回的 api=${data.api ?? '未知'}，说明 Host 里的插件代码还是旧的。`
                  + ' 直接在这里编辑会用旧接口写坏新结构的数据，所以先锁住了。'),
                h('div', { key: 'c', className: 'wg-hint' }, '重启 DSH 后刷新页面即可恢复。'),
              ])
              : tab === 'inject'
                ? h(InjectPanel, { key: 'inject', data, reload, notify, fail })
                : tab === 'worlds'
                  ? h(WorldsPanel, { key: 'worlds', data, reload, notify, fail })
                  : tab === 'presets'
                  ? h(PresetsPanel, { key: 'presets', data, reload, notify, fail })
                  : tab === 'config'
                  ? h(ConfigPanel, { key: 'config', data, reload, notify, fail,scopeSession,onScopeSessionChange:setScopeSession })
                  : tab === 'cards'
                  ? h(CardsPanel, { key: 'cards', data, reload, notify, fail })
                  : tab === 'ext'
                  ? h(ExtensionsPanel, { key: 'ext', data, notify, fail,scopeSession,onScopeSessionChange:setScopeSession })
                  : h(WorksPanel, { key: 'works', data, reload, notify, fail }),
        ]),
      ]);
    }

    /** 左侧栏图标：owner 传 { size, active }。 */
    function GuideGlyph(props) {
      const size = Number(props?.size) || 20;
      const active = props?.active === true;
      return h('svg', {
        className: 'wg-glyph',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { opacity: active ? 1 : 0.82 },
      }, [
        h('path', { key: 'book', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z' }),
        h('path', { key: 'lines', d: 'M8 11h7M8 14.5h4' }),
        h('path', { key: 'pen', d: 'M17.6 10.2l1.7 1.7-4.6 4.6-2.2.5.5-2.2z', fill: 'currentColor', stroke: 'none' }),
      ]);
    }

    function GuidePage() {
      return h('div', { className: 'wg-root' }, h(App, {}));
    }

    function WritingSessionPanel({ sessionId, useProjection }) {
      const preset=useProjection('agentPreset');
      const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
      const current=useRef(sessionId);current.current=sessionId;
      const refresh=useCallback(async()=>{
        if(!sessionId||preset!=='writer'){setState(null);return;}
        try{const next=await api('GET','/session-panel?sessionId='+encodeURIComponent(sessionId));if(current.current===sessionId)setState(next);}
        catch{if(current.current===sessionId){setState(null);setError('写作配置暂时无法读取，请刷新后重试');}}
      },[sessionId,preset]);
      useEffect(()=>{setState(null);setError('');setBusy(false);void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},5000);return()=>clearInterval(timer);},[refresh]);
      const act=async payload=>{
        setBusy(true);setError('');
        try{await api('POST','/session-panel/action',{sessionId,...payload});await refresh();}
        catch(e){if(current.current===sessionId)setError(e.message);}
        finally{if(current.current===sessionId)setBusy(false);}
      };
      if(preset!=='writer')return null;
      const buttonStyle={font:'inherit',border:'1px solid var(--dsw-alias-border-primary, #d7d4cf)',borderRadius:8,padding:'3px 9px',background:'var(--dsw-alias-bg-layer-2, #f4f2ee)',color:'inherit',cursor:'pointer'};
      const content=state?.writer?[
        h('span',{key:'model',title:state.provider},'写作模型：'+(state.model||'尚未配置')),
        state.residentEnabled?h('span',{key:'status'},state.busy?'· 运行中':state.active?'· 扩展已就绪':'· 扩展待启动'):null,
        state.residentEnabled&&!state.active?h('button',{key:'activate',type:'button',style:buttonStyle,disabled:busy||state.busy,onClick:()=>act({action:'activate'})},'启动扩展'):null,
        ...(state.buttons??[]).map(button=>h('button',{key:button.scriptId+'|'+button.name,type:'button',style:buttonStyle,title:button.scriptName,disabled:busy||state.busy,onClick:()=>act({action:'button',scriptId:button.scriptId,name:button.name})},button.name)),
        state.status?.errors?.length?h('span',{key:'issues',title:'部分扩展功能未完成，请在写作指导中查看兼容性状态'},`· ${state.status.errors.length} 项兼容提示`):null,
        error?h('span',{key:'error',role:'alert'},error):null,
      ]:[h('span',{key:'pending',role:error?'alert':undefined},error||'正在读取写作配置…')];
      return h('div',{'data-writing-panel':true,style:{boxSizing:'border-box',width:'100%',padding:'0 var(--dsh-composer-side-clearance, 16px)',marginBottom:6}},
        h('div',{'data-writing-panel-content':true,style:{boxSizing:'border-box',width:'100%',maxWidth:'var(--dsh-composer-card-max-width, 952px)',margin:'0 auto',display:'flex',gap:6,alignItems:'center',flexWrap:'wrap',fontSize:12,lineHeight:'20px',padding:'4px 0',color:'var(--dsw-alias-label-secondary, inherit)',overflowWrap:'anywhere'}},content));
    }

    function ReadingFrame({html}){
      const frame=useRef(null);
      useEffect(()=>{
        let observer;const node=frame.current;
        const resize=()=>{try{const height=Math.min(7000,Math.max(32,node.contentDocument.body.scrollHeight+20));node.style.height=height+'px';}catch{}};
        const ready=()=>{resize();try{observer=new ResizeObserver(resize);observer.observe(node.contentDocument.body);}catch{}};
        node.addEventListener('load',ready);return()=>{node.removeEventListener('load',ready);observer?.disconnect();};
      },[html]);
      const doc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"><style>:root{color-scheme:light dark}body{margin:0;padding:4px;font:15px/1.75 system-ui;overflow-wrap:anywhere}p{margin:.5em 0}pre{overflow:auto;white-space:pre-wrap}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #8886;padding:6px}details{padding:8px;border:1px solid #8884;border-radius:8px}</style>'+html;
      return h('iframe',{ref:frame,title:'写作正文',sandbox:'allow-same-origin',srcDoc:doc,style:{border:0,width:'100%',display:'block',minHeight:40,colorScheme:'inherit'}});
    }
    function WritingReadingView({sessionId,useProjection,useSession}){
      const preset=useProjection('agentPreset'),running=useSession(s=>s.running);
      const [data,setData]=useState(null),[error,setError]=useState(''),[raw,setRaw]=useState(false),[showRuntime,setShowRuntime]=useState(false);
      useEffect(()=>{
        let active=true,pending=false;setData(null);setError('');
        const load=async()=>{if(!active||pending||preset!=='writer')return;pending=true;try{const next=await api('GET','/reading?sessionId='+encodeURIComponent(sessionId));if(active){setData(next);setError('');}}catch(e){if(active)setError(e.message);}finally{pending=false;}};
        void load();const timer=setInterval(load,4000);return()=>{active=false;clearInterval(timer);};
      },[sessionId,preset,running]);
      if(preset!=='writer')return h('div',{style:{padding:24}},'写作阅读仅用于写作模式会话。');
      return h('section',{'data-writing-reading':true,style:{boxSizing:'border-box',width:'100%',maxWidth:'var(--dsh-composer-card-max-width, 952px)',margin:'0 auto',padding:'20px 16px',display:'flex',flexDirection:'column',gap:18}},[
        h('div',{key:'bar',style:{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}},[
          h('strong',{key:'title'},'写作阅读'),h('span',{key:'hint',style:{opacity:.65,fontSize:12}},'显示处理不改变原始对话'),
          h('button',{key:'runtime',type:'button',onClick:()=>setShowRuntime(value=>!value)},showRuntime?'收起脚本界面':'脚本界面'),
          h('label',{key:'raw',style:{marginLeft:'auto',fontSize:12}},[h('input',{key:'i',type:'checkbox',checked:raw,onChange:e=>setRaw(e.target.checked)}),' 显示原文']),
        ]),
        showRuntime?h(RuntimeSurface,{key:sessionId,sessionId}):null,
        error?h('div',{key:'error',role:'alert'},error):null,
        !data?h('div',{key:'loading'},'读取正文…'):!data.messages.length?h('div',{key:'empty'},'在下方输入框发送消息，回复完成后会在这里显示。'):null,
        ...(data?.messages??[]).map(row=>h('article',{key:row.id,style:{minWidth:0,padding:row.role==='user'?'12px 16px':'8px 0',borderRadius:12,background:row.role==='user'?'var(--dsw-alias-bg-layer-1, #8881)':'transparent'}},[
          h('div',{key:'role',style:{fontSize:11,opacity:.6,marginBottom:5}},row.role==='user'?'你':'正文'),
          raw?h('pre',{key:'raw',style:{whiteSpace:'pre-wrap',font:'inherit'}},row.original):row.hidden?h('details',{key:'hidden'},[h('summary',{key:'s'},'此消息已按显示规则隐藏'),h('pre',{key:'p',style:{whiteSpace:'pre-wrap',font:'inherit'}},row.original)]):h(ReadingFrame,{key:'html',html:row.html}),
        ])),
        running?h('div',{key:'running',style:{opacity:.6}},'正在生成，完成后更新正文…'):null,
      ]);
    }
    function RuntimeSurface({sessionId}){
      const [surface,setSurface]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[text,setText]=useState('');
      const refresh=useCallback(async()=>{try{const value=await api('GET','/runtime-surface?sessionId='+encodeURIComponent(sessionId));setSurface(value);setError('');}catch(e){setError(e.message);}},[sessionId]);
      useEffect(()=>{setSurface(null);void refresh();},[refresh]);
      const send=async input=>{setBusy(true);try{await api('POST','/session-panel/action',{sessionId,action:input?'surface':'activate',...(input?{input}:{})});await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
      return h('section',{'aria-label':'脚本界面',style:{border:'1px solid #8885',borderRadius:12,padding:12,display:'flex',flexDirection:'column',gap:8}},[
        h('div',{key:'toolbar',style:{display:'flex',gap:8,flexWrap:'wrap'}},[
          h('button',{key:'start',disabled:busy,onClick:()=>send(null)},'启动 / 恢复'),h('button',{key:'refresh',disabled:busy,onClick:refresh},'刷新界面'),
          ...[['up','向上滚动',-350],['down','向下滚动',350]].map(([key,label,dy])=>h('button',{key,disabled:busy,onClick:()=>send({type:'scroll',dy})},label)),
        ]),
        error?h('div',{key:'error',role:'alert'},error):null,
        surface?h('img',{key:'image',alt:'隔离运行中的助手脚本界面',src:surface.image,style:{width:'100%',cursor:busy?'wait':'pointer',borderRadius:6},onClick:event=>{if(busy)return;const box=event.currentTarget.getBoundingClientRect();void send({type:'click',x:(event.clientX-box.left)*surface.width/box.width,y:(event.clientY-box.top)*surface.height/box.height});}}):null,
        h('div',{key:'input',style:{display:'flex',gap:6,flexWrap:'wrap'}},[
          h('input',{key:'text',value:text,placeholder:'先点击脚本界面的输入框，再输入文字','aria-label':'脚本输入文字',onChange:event=>setText(event.target.value),style:{flex:1,minWidth:180}}),
          h('button',{key:'type',disabled:busy||!text,onClick:()=>send({type:'text',text})},'输入'),
          ...['Enter','Escape','Tab','Backspace'].map(key=>h('button',{key,disabled:busy,onClick:()=>send({type:'key',key})},key)),
        ]),
        h('small',{key:'hint'},'界面在独立浏览器中运行。点击图中的控件可交互；涉及改写原聊天记录的操作暂不支持。'),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'writing-reading',order:5,label:'写作阅读'},WritingReadingView));
        // DSH hides composer.dock on its empty-session hero. input.dock is shared by both layouts.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({name:'conversation.input.dock',id:'writing-guide-session',order:30}, WritingSessionPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'writing-guide',
          order: 20,
          label: '写作指导',
        }, GuideGlyph));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'writing-guide',
        }, GuidePage));
      },
    };
  },
});
