// Field contract independently implemented from ST convertCharacterBook and
// convertWorldInfoToCharacterBook. Original metadata remains available separately.
const fields = {
  position:['position',1], excludeRecursion:['exclude_recursion',false],
  preventRecursion:['prevent_recursion',false], delayUntilRecursion:['delay_until_recursion',false],
  displayIndex:['display_index',0], probability:['probability',100], useProbability:['useProbability',true],
  depth:['depth',4], selectiveLogic:['selectiveLogic',0], outletName:['outlet_name',''],
  group:['group',''], groupOverride:['group_override',false], groupWeight:['group_weight',100],
  scanDepth:['scan_depth',null], caseSensitive:['case_sensitive',null], matchWholeWords:['match_whole_words',null],
  useGroupScoring:['use_group_scoring',null], automationId:['automation_id',''], role:['role',0],
  vectorized:['vectorized',false], sticky:['sticky',null], cooldown:['cooldown',null], delay:['delay',null],
  matchPersonaDescription:['match_persona_description',false], matchCharacterDescription:['match_character_description',false],
  matchCharacterPersonality:['match_character_personality',false], matchCharacterDepthPrompt:['match_character_depth_prompt',false],
  matchScenario:['match_scenario',false], matchCreatorNotes:['match_creator_notes',false], triggers:['triggers',[]], ignoreBudget:['ignore_budget',false],
};
export function readCharacterBook(book, fallbackName) {
  if (book == null) return null;
  if (!Array.isArray(book.entries)) throw new Error('character_book.entries 必须是数组');
  return { ...structuredClone(book), name: book.name || fallbackName, entries: book.entries.map((entry,index) => {
    if (!entry || typeof entry !== 'object') throw new Error('世界书条目结构无效');
    if (Array.isArray(entry.key) && entry.uid !== undefined) return structuredClone(entry);
    const ext = entry.extensions ?? {};
    const out = { ...structuredClone(entry), uid:entry.id ?? index, key:entry.keys ?? [], keysecondary:entry.secondary_keys ?? [],
      content:entry.content ?? '', comment:entry.comment ?? '', constant:entry.constant || false, selective:entry.selective || false,
      order:entry.insertion_order ?? 100, disable:!entry.enabled, addMemo:!!entry.comment,
    };
    for (const [key,[source,value]] of Object.entries(fields)) out[key] = ext[source] ?? structuredClone(value);
    out.position = ext.position ?? (entry.position === 'before_char' ? 0 : 1);
    out.displayIndex = ext.display_index ?? index;
    for (const key of ['id','keys','secondary_keys','insertion_order','enabled','raw']) delete out[key];
    return out;
  }) };
}
export function writeCharacterBook(book) {
  if (!book) return null;
  const out = structuredClone(book);
  for (const key of ['id','modes','updatedAt','originalData']) delete out[key];
  out.entries = book.entries.map(entry => {
    const result = structuredClone(entry);
    for (const key of ['uid','key','keysecondary','order','disable','raw','addMemo',...Object.keys(fields)]) delete result[key];
    Object.assign(result,{id:entry.uid,keys:entry.key ?? [],secondary_keys:entry.keysecondary ?? [],content:entry.content ?? '',
      comment:entry.comment ?? '',constant:entry.constant===true,selective:entry.selective===true,insertion_order:entry.order ?? 100,
      enabled:entry.disable!==true,position:entry.position===0?'before_char':'after_char',use_regex:entry.use_regex ?? true,
      extensions:{...(entry.extensions ?? {})}});
    for (const [key,[target,value]] of Object.entries(fields)) result.extensions[target] = entry[key] ?? structuredClone(value);
    return result;
  });
  return out;
}
