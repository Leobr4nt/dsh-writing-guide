/** Mirrors ST deletion handlers: deleting a material removes its source permission. */
export async function forgetExtensionOwner(extensionStore, type, id) {
  if (!extensionStore || !['preset','character'].includes(type)) return;
  const bucket = type === 'preset' ? 'presets' : 'characters';
  await extensionStore.update(state => {
    const allowed = structuredClone(state.allowed ?? {});
    for (const kind of ['regex','helper']) {
      if (Array.isArray(allowed[kind]?.[bucket])) allowed[kind][bucket] = allowed[kind][bucket].filter(value => value !== id);
    }
    return { ...state, allowed };
  });
}
