(() => {
  const VERSION = '0.22';
  const IDS = {
    STYLE: 'pts-sync-style',
    BTN: 'pts-sync-open-btn',
    DIALOG: 'pts-sync-backdrop',
    MASK: 'pts-sync-icon-mask',
  };
  const BUTTON_NAME = '预设同步';
  const ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><mask id="${IDS.MASK}"><rect width="24" height="24" fill="white"/><path d="M10.7 13.8l2.1 2.1 4.1-4.3" stroke="black" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><path d="M4.8 15.5V6.2A2.7 2.7 0 0 1 7.5 3.5h8.8" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><rect x="7.4" y="6.8" width="13.2" height="13.8" rx="3.4" fill="currentColor" mask="url(#${IDS.MASK})"/></svg>`;

  const PLACEHOLDER_IDS = new Set([
    'worldInfoBefore',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'worldInfoAfter',
    'dialogueExamples',
    'chatHistory',
  ]);
  const SYSTEM_IDS = new Set(['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']);
  const RESERVED_IDS = new Set([...PLACEHOLDER_IDS, ...SYSTEM_IDS]);

  const topWin = window.parent || window;
  const topDoc = topWin.document;

  const getTH = () => window.TavernHelper || topWin.TavernHelper;
  const getPM = () => {
    try {
      const ctx = topWin.SillyTavern?.getContext?.() || window.SillyTavern?.getContext?.();
      return ctx?.getPresetManager?.('openai') || null;
    } catch {
      return null;
    }
  };

  const toast = (type, msg) => {
    const t = topWin.toastr || window.toastr;
    if (t && typeof t[type] === 'function') t[type](msg, '预设开关同步');
  };

  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const genId = (usedIds) => {
    let id;
    do {
      id =
        topWin.crypto && typeof topWin.crypto.randomUUID === 'function'
          ? topWin.crypto.randomUUID()
          : 'pts_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    } while (usedIds.has(id) || RESERVED_IDS.has(id));
    usedIds.add(id);
    return id;
  };

  const isMarkerPrompt = (p, TH) => {
    if (!p) return false;
    const pid = p.id ?? p.identifier;
    if (p.marker === true) return true;
    if (pid && PLACEHOLDER_IDS.has(pid)) return true;
    try {
      if (TH && typeof TH.isPresetPlaceholderPrompt === 'function' && 'id' in p) {
        return !!TH.isPresetPlaceholderPrompt(p);
      }
    } catch {}
    return false;
  };

  const primaryOrder = (rawJson) => {
    const g = rawJson.prompt_order;
    return (
      g.find((x) => x.character_id === 100001) ||
      g.find((x) => x.character_id === 100000) ||
      g.slice().sort((a, b) => (b.order || []).length - (a.order || []).length)[0]
    );
  };

  const validateRawJson = (p, label) => {
    if (!p || !Array.isArray(p.prompts) || !Array.isArray(p.prompt_order) || !p.prompt_order.length) {
      throw new Error(`${label}不是有效的酒馆对话补全预设（缺少 prompts 或 prompt_order）`);
    }
  };

  const entriesFromTHPreset = (preset, TH) =>
    (Array.isArray(preset?.prompts) ? preset.prompts : []).map((p) => ({
      id: p.id,
      name: p.name || p.id,
      enabled: !!p.enabled,
      marker: isMarkerPrompt(p, TH),
      content: String(p.content ?? ''),
      raw: p,
    }));

  const entriesFromRawJson = (rawJson) => {
    const byId = new Map(rawJson.prompts.map((x) => [x.identifier, x]));
    const ord = primaryOrder(rawJson)?.order || [];
    return ord
      .filter((o) => byId.has(o.identifier))
      .map((o) => {
        const pr = byId.get(o.identifier);
        return {
          id: o.identifier,
          name: pr.name || o.identifier,
          enabled: !!o.enabled,
          marker: !!pr.marker || PLACEHOLDER_IDS.has(o.identifier),
          content: String(pr.content ?? ''),
          raw: pr,
        };
      });
  };

  const thPromptToRaw = (p, identifier) => {
    const isChat = p?.position?.type === 'in_chat';
    return {
      identifier,
      name: p?.name || identifier,
      system_prompt: false,
      enabled: !!p?.enabled,
      marker: false,
      role: p?.role || 'system',
      content: String(p?.content ?? ''),
      injection_position: isChat ? 1 : 0,
      injection_depth: isChat ? Number(p.position.depth ?? 4) : 4,
      injection_order: isChat ? Number(p.position.order ?? 100) : 100,
      forbid_overrides: false,
      ...(p?.extra ? clone(p.extra) : {}),
    };
  };

  const rawPromptToTH = (pr, enabled) => {
    const isChat = Number(pr.injection_position) === 1;
    const base = {
      id: pr.identifier,
      name: pr.name || pr.identifier,
      enabled: !!enabled,
      role: pr.role || 'system',
    };
    if (!PLACEHOLDER_IDS.has(pr.identifier) && !pr.marker) base.content = String(pr.content ?? '');
    if (!SYSTEM_IDS.has(pr.identifier)) {
      base.position = isChat
        ? { type: 'in_chat', depth: Number(pr.injection_depth ?? 4), order: Number(pr.injection_order ?? 100) }
        : { type: 'relative' };
    }
    return base;
  };

  const rawJsonToTHPreset = (rawJson) => {
    const byId = new Map(rawJson.prompts.map((x) => [x.identifier, x]));
    const ord = primaryOrder(rawJson)?.order || [];
    const used = new Set();
    const prompts = [];
    for (const o of ord) {
      const pr = byId.get(o.identifier);
      if (!pr || used.has(o.identifier)) continue;
      used.add(o.identifier);
      prompts.push(rawPromptToTH(pr, o.enabled));
    }
    const prompts_unused = [];
    for (const pr of rawJson.prompts) {
      if (used.has(pr.identifier)) continue;
      prompts_unused.push(rawPromptToTH(pr, pr.enabled));
    }
    return { prompts, prompts_unused, extensions: rawJson.extensions ? clone(rawJson.extensions) : {} };
  };

  const readJsonFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result || '')));
        } catch {
          reject(new Error(`「${file.name}」不是有效的 JSON 文件`));
        }
      };
      reader.onerror = () => reject(new Error('读取本地文件失败'));
      reader.readAsText(file, 'utf-8');
    });

  const syncThemeTokens = (container) => {
    if (!container) return;
    const rootStyle = topWin.getComputedStyle(topDoc.documentElement);
    const uiBg =
      rootStyle.getPropertyValue('--SmartThemeBlurTintColor').trim() ||
      rootStyle.getPropertyValue('--SmartThemeChatTintColor').trim() ||
      topWin.getComputedStyle(topDoc.body).backgroundColor;
    const probe = topDoc.createElement('span');
    probe.style.display = 'none';
    probe.style.color = uiBg || '#ffffff';
    topDoc.body.appendChild(probe);
    const resolved = topWin.getComputedStyle(probe).color;
    probe.remove();
    const m = resolved.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) container.style.setProperty('--pts-solid-bg', `rgb(${m[1]}, ${m[2]}, ${m[3]})`);
  };

  const state = {
    presetNames: [],
    loadedName: '',
    srcKey: 'in_use',
    tgtMode: 'existing',
    tgtName: '',
    tgtFileRaw: null,
    tgtFileOrigName: '',
    tgtFileSaveName: '',
    tgtFileToken: 0,
    activeTab: 'preview',
    onlyChg: false,
    switchAfter: false,
    manual: {},
    stitch: new Set(),
    error: '',
    busy: false,
  };

  const cache = {
    srcKey: null,
    srcFull: null,
    tgtKey: null,
    tgtFull: null,
    computed: null,
  };

  const resetCache = () => {
    cache.srcKey = null;
    cache.srcFull = null;
    cache.tgtKey = null;
    cache.tgtFull = null;
    cache.computed = null;
  };

  let mountTimer = null;
  let dialogEl = null;
  let refs = {};
  let patchedParent = null;
  let patchedPrev = null;

  const CSS_TEXT = `
#${IDS.BTN}{display:inline-flex !important;align-items:center !important;justify-content:center !important;cursor:pointer;line-height:1;min-width:0 !important;flex-shrink:0 !important}
#${IDS.BTN}::before{content:none !important;display:none !important}
#${IDS.BTN} svg{width:1.12em;height:1.12em;display:block;pointer-events:none;flex-shrink:0}
#${IDS.DIALOG}{
  --pts-solid-bg:var(--SmartThemeBlurTintColor,#fafafa);
  --pts-text:var(--SmartThemeBodyColor,#333333);
  --pts-sub:var(--SmartThemeEmColor,color-mix(in srgb,var(--SmartThemeBodyColor,#333333) 62%,transparent));
  --pts-border:color-mix(in srgb,var(--SmartThemeBorderColor,#cccccc) 65%,color-mix(in srgb,var(--SmartThemeBodyColor,#333333) 16%,transparent));
  --pts-border-soft:color-mix(in srgb,var(--SmartThemeBodyColor,#333333) 10%,transparent);
  --pts-card-bg:color-mix(in srgb,var(--SmartThemeBodyColor,#333333) 3.5%,transparent);
  --pts-input-bg:color-mix(in srgb,var(--SmartThemeChatTintColor,var(--pts-solid-bg)) 92%,var(--pts-solid-bg) 8%);
  --pts-hover:color-mix(in srgb,var(--SmartThemeBodyColor,#333333) 8%,transparent);
  --pts-active-bg:var(--SmartThemeBodyColor,#333333);
  --pts-active-fg:var(--pts-solid-bg);
  position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;
  width:100vw !important;height:100vh !important;height:100dvh !important;
  max-width:100vw !important;max-height:100dvh !important;min-width:0 !important;min-height:0 !important;
  margin:0 !important;padding:20px !important;border:0 !important;border-radius:0 !important;
  background:rgba(0,0,0,0.36) !important;box-shadow:none !important;transform:none !important;
  overflow:hidden !important;z-index:2147483640 !important;
  display:flex !important;align-items:center !important;justify-content:center !important;
  box-sizing:border-box !important;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--pts-text)
}
#${IDS.DIALOG}:not([open]){display:none !important}
#${IDS.DIALOG}::backdrop{background:transparent !important}
@media(min-width:768px){#${IDS.DIALOG}{padding:36px 48px !important}}
#${IDS.DIALOG} *{box-sizing:border-box}
.pts-modal{
  position:relative !important;margin:auto !important;width:100% !important;max-width:580px !important;
  max-height:calc(100dvh - 44px) !important;display:flex !important;flex-direction:column !important;
  background:var(--pts-solid-bg) !important;border:1px solid var(--pts-border) !important;
  border-radius:16px !important;box-shadow:0 14px 38px var(--SmartThemeShadowColor,rgba(0,0,0,0.22)) !important;
  overflow:hidden !important;transform:none !important;font-size:14px;line-height:1.5;color:var(--pts-text)
}
@media(min-width:768px){.pts-modal{max-height:calc(100dvh - 80px) !important}}
.pts-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--pts-border-soft);flex-shrink:0}
.pts-title-wrap{display:flex;align-items:baseline;gap:6px;min-width:0}
.pts-title{margin:0;font-size:16px;font-weight:600;color:var(--pts-text)}
.pts-ver{font-size:12px;color:var(--pts-sub);font-weight:500}
.pts-close{width:30px;height:30px;border-radius:8px;border:1px solid var(--pts-border);background:transparent;color:var(--pts-text);font-size:18px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
.pts-close:hover{background:var(--pts-hover)}
.pts-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.pts-card{background:var(--pts-card-bg);border:1px solid var(--pts-border);border-radius:12px;padding:12px}
.pts-label{display:block;font-size:13px;font-weight:600;color:var(--pts-text);margin:0 0 6px}
.pts-field+.pts-field{margin-top:11px}
.pts-select,.pts-input{width:100%;min-height:36px;padding:6px 10px;border-radius:9px;border:1px solid var(--pts-border);background:var(--pts-input-bg);color:var(--pts-text);font-size:14px;outline:none}
@media(max-width:767px){.pts-select,.pts-input{font-size:16px}}
.pts-select:focus,.pts-input:focus{border-color:var(--pts-text)}
.pts-mode-tabs{display:inline-flex;gap:4px;padding:3px;border-radius:9px;background:var(--pts-hover);border:1px solid var(--pts-border-soft);margin-bottom:8px}
.pts-mode-tab{border:0;border-radius:7px;padding:4px 12px;font-size:12.5px;cursor:pointer;background:transparent;color:var(--pts-sub)}
.pts-mode-tab.active{background:var(--pts-active-bg);color:var(--pts-active-fg);font-weight:600}
.pts-file-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pts-file-btn{display:inline-flex;align-items:center;padding:6px 12px;border-radius:8px;border:1px solid var(--pts-border);background:var(--pts-input-bg);color:var(--pts-text);font-size:13px;cursor:pointer}
.pts-file-btn:hover{background:var(--pts-hover)}
.pts-file-info{font-size:12px;color:var(--pts-sub);word-break:break-all}
.pts-file-name-wrap{margin-top:8px}
.pts-hint{font-size:12px;color:var(--pts-sub);margin-top:4px}
.pts-hint.warn{color:#b87400}
.pts-err{color:#c0392b;font-size:13px;margin-top:8px}
.pts-sum{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.pts-pill{padding:2px 9px;border-radius:999px;font-size:12px;background:var(--pts-input-bg);border:1px solid var(--pts-border);color:var(--pts-sub)}
.pts-pill.hl{color:var(--pts-text);border-color:var(--pts-text);font-weight:600}
.pts-panel-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;border-radius:10px;background:var(--pts-hover);border:1px solid var(--pts-border-soft)}
.pts-panel-tab{border:0;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:var(--pts-sub);display:inline-flex;align-items:center;justify-content:center;gap:6px}
.pts-panel-tab.active{background:var(--pts-active-bg);color:var(--pts-active-fg)}
.pts-tag-badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,currentColor 14%,transparent)}
.pts-panel-wrap{margin-top:8px;border:1px solid var(--pts-border);border-radius:10px;background:var(--pts-input-bg);overflow:hidden}
.pts-panel-bar{min-height:36px;padding:6px 10px;border-bottom:1px solid var(--pts-border-soft);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--pts-sub)}
.pts-panel-scroll{height:min(230px,32dvh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 11px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--pts-text) 24%,transparent) transparent}
.pts-panel-scroll::-webkit-scrollbar,.pts-body::-webkit-scrollbar{width:5px}
.pts-panel-scroll::-webkit-scrollbar-thumb,.pts-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--pts-text) 22%,transparent);border-radius:999px}
.pts-chk{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--pts-text);cursor:pointer;user-select:none}
.pts-chk input{margin:0;accent-color:var(--pts-text)}
.pts-mini-bar{display:inline-flex;gap:6px}
.pts-mini-btn{padding:2px 9px;border-radius:6px;border:1px solid var(--pts-border);background:transparent;color:var(--pts-text);font-size:12px;cursor:pointer}
.pts-mini-btn:hover{background:var(--pts-hover)}
.pts-row{border-top:1px solid var(--pts-border-soft);padding:8px 0;display:flex;flex-direction:column;gap:4px}
.pts-row:first-child{border-top:0}
.pts-nm{font-weight:600;font-size:13px;color:var(--pts-text);word-break:break-word}
.pts-meta{font-size:12px;color:var(--pts-sub);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pts-on{color:#248a52;font-weight:600}
.pts-off{color:#c7473c;font-weight:600}
.pts-chg{color:#b87400;font-weight:600}
.pts-manual-sel{width:100%;margin-top:2px;padding:4px 8px;border-radius:6px;border:1px solid var(--pts-border);background:var(--pts-solid-bg);color:var(--pts-text);font-size:12px}
.pts-sti{display:flex;gap:8px;align-items:flex-start;border-top:1px solid var(--pts-border-soft);padding:8px 0;cursor:pointer}
.pts-sti:first-child{border-top:0}
.pts-sti input{margin:3px 0 0;flex-shrink:0;accent-color:var(--pts-text)}
.pts-sti-info{min-width:0;flex:1}
.pts-snip{font-size:12px;color:var(--pts-sub);word-break:break-all;margin-top:2px}
.pts-empty{height:100%;display:flex;align-items:center;justify-content:center;font-size:12.5px;color:var(--pts-sub);text-align:center;padding:16px}
.pts-footer{padding:11px 16px 14px;border-top:1px solid var(--pts-border-soft);flex-shrink:0;display:flex;flex-direction:column;gap:9px}
.pts-submit{width:100%;min-height:40px;border:0;border-radius:10px;background:var(--pts-active-bg);color:var(--pts-active-fg);font-size:14px;font-weight:600;cursor:pointer}
.pts-submit:hover:not(:disabled){opacity:0.88}
.pts-submit:disabled{opacity:0.35;cursor:not-allowed}
`;

  const el = (tag, cls, text) => {
    const node = topDoc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const stTxt = (b) => (b ? '开' : '关');
  const stCls = (b) => (b ? 'pts-on' : 'pts-off');

  const injectStyle = () => {
    if (topDoc.getElementById(IDS.STYLE)) return;
    const style = topDoc.createElement('style');
    style.id = IDS.STYLE;
    style.textContent = CSS_TEXT;
    topDoc.head.appendChild(style);
  };

  const getSourceEntriesCached = (TH) => {
    if (cache.srcKey === state.srcKey && cache.srcFull) return cache.srcFull;
    cache.srcKey = state.srcKey;
    cache.srcFull = entriesFromTHPreset(TH.getPreset(state.srcKey), TH);
    return cache.srcFull;
  };

  const getTargetEntriesCached = (TH) => {
    const key =
      state.tgtMode === 'file'
        ? state.tgtFileRaw
          ? `file:${state.tgtFileToken}`
          : null
        : state.tgtName
          ? `preset:${state.tgtName}`
          : null;
    if (!key) {
      cache.tgtKey = null;
      cache.tgtFull = null;
      return null;
    }
    if (cache.tgtKey === key && cache.tgtFull) return cache.tgtFull;
    cache.tgtKey = key;
    cache.tgtFull =
      state.tgtMode === 'file'
        ? entriesFromRawJson(state.tgtFileRaw)
        : entriesFromTHPreset(TH.getPreset(state.tgtName), TH);
    return cache.tgtFull;
  };

  const compute = (TH) => {
    const srcFull = getSourceEntriesCached(TH);
    const tgtFull = getTargetEntriesCached(TH);
    if (!srcFull || !tgtFull) {
      cache.computed = null;
      return null;
    }
    const S = srcFull.filter((e) => !e.marker);
    const T = tgtFull.filter((e) => !e.marker);
    const sById = new Map(S.map((e) => [e.id, e]));
    const pool = new Map();
    S.forEach((e) => {
      const k = norm(e.name);
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(e);
    });

    const used = new Set();
    const picked = new Map();

    T.forEach((t) => {
      const m = state.manual[t.id];
      if (m && sById.has(m)) {
        const s = sById.get(m);
        picked.set(t.id, { s, how: 'manual' });
        used.add(m);
        const q = pool.get(norm(s.name));
        if (q) {
          const idx = q.findIndex((x) => x.id === m);
          if (idx >= 0) q.splice(idx, 1);
        }
      }
    });

    T.forEach((t) => {
      if (picked.has(t.id)) return;
      const q = pool.get(norm(t.name));
      if (q && q.length) {
        const s = q.shift();
        used.add(s.id);
        picked.set(t.id, { s, how: 'auto' });
      } else {
        picked.set(t.id, { s: null, how: 'none' });
      }
    });

    const rows = T.map((t) => {
      const p = picked.get(t.id);
      return { t, s: p.s, how: p.how, after: p.s ? p.s.enabled : t.enabled };
    });

    const unusedSrc = S.filter((e) => !used.has(e.id));
    state.stitch = new Set([...state.stitch].filter((id) => unusedSrc.some((u) => u.id === id)));
    cache.computed = { rows, unusedSrc, srcFull, tgtFull };
    return cache.computed;
  };

  const getRawSourcePromptMap = () => {
    const map = new Map();
    if (state.srcKey === 'in_use') return map;
    try {
      const pm = getPM();
      const raw = pm?.getCompletionPresetByName?.(state.srcKey);
      if (raw && Array.isArray(raw.prompts)) {
        raw.prompts.forEach((p) => {
          if (p?.identifier) map.set(p.identifier, p);
        });
      }
    } catch {}
    return map;
  };

  const updateFooter = () => {
    const btn = refs.submitBtn;
    if (!btn) return;
    const canSubmit =
      !state.busy &&
      !!cache.computed &&
      (state.tgtMode === 'existing'
        ? !!state.tgtName
        : !!state.tgtFileRaw &&
          !!state.tgtFileSaveName.trim() &&
          state.tgtFileSaveName.trim() !== 'in_use');
    btn.disabled = !canSubmit;
    btn.textContent = state.busy
      ? '正在覆盖写入…'
      : state.tgtMode === 'file'
        ? '导入并覆盖写入预设'
        : '覆盖写入新版预设';
  };

  const refreshBadgesOnly = () => {
    const c = cache.computed;
    if (!c) return;
    const { rows, unusedSrc } = c;
    const matched = rows.filter((r) => r.s).length;
    const changed = rows.filter((r) => r.s && r.t.enabled !== r.after).length;
    const none = rows.filter((r) => r.how === 'none').length;

    if (refs.sumEl) {
      refs.sumEl.replaceChildren();
      [
        [`新版 ${rows.length}`, false],
        [`匹配 ${matched}`, false],
        [`变更 ${changed}`, changed > 0],
        [`未匹配 ${none}`, false],
        [`已选缝合 ${state.stitch.size}/${unusedSrc.length}`, state.stitch.size > 0],
      ].forEach(([txt, hl]) => refs.sumEl.append(el('span', 'pts-pill' + (hl ? ' hl' : ''), txt)));
    }
    if (refs.leftBadge) refs.leftBadge.textContent = String(rows.length);
    if (refs.rightBadge) {
      refs.rightBadge.textContent =
        state.stitch.size > 0 ? `${state.stitch.size}/${unusedSrc.length}` : String(unusedSrc.length);
    }
    updateFooter();
  };

  const renderSelectCard = () => {
    const card = refs.selectCard;
    if (!card) return;
    card.replaceChildren();

    const srcField = el('div', 'pts-field');
    srcField.append(el('label', 'pts-label', '① 旧版预设（开关状态来源）'));
    const srcSel = el('select', 'pts-select');
    srcSel.append(new Option(`当前使用中（实时）：${state.loadedName || '未命名'}`, 'in_use'));
    state.presetNames.forEach((n) => srcSel.append(new Option(n, n)));
    srcSel.value = state.srcKey;
    srcSel.onchange = () => {
      state.srcKey = srcSel.value;
      state.manual = {};
      state.stitch = new Set();
      state.error = '';
      renderPvSection(true);
    };
    srcField.append(srcSel);
    card.append(srcField);

    const tgtField = el('div', 'pts-field');
    tgtField.append(el('label', 'pts-label', '② 新版预设（被覆盖的目标）'));

    const modeTabs = el('div', 'pts-mode-tabs');
    const tabEx = el('button', 'pts-mode-tab' + (state.tgtMode === 'existing' ? ' active' : ''), '酒馆已有预设');
    tabEx.type = 'button';
    tabEx.onclick = () => {
      if (state.tgtMode === 'existing') return;
      state.tgtMode = 'existing';
      state.manual = {};
      state.stitch = new Set();
      state.error = '';
      renderSelectCard();
      renderPvSection(true);
    };
    const tabFl = el('button', 'pts-mode-tab' + (state.tgtMode === 'file' ? ' active' : ''), '导入本地 JSON');
    tabFl.type = 'button';
    tabFl.onclick = () => {
      if (state.tgtMode === 'file') return;
      state.tgtMode = 'file';
      state.manual = {};
      state.stitch = new Set();
      state.error = '';
      renderSelectCard();
      renderPvSection(true);
    };
    modeTabs.append(tabEx, tabFl);
    tgtField.append(modeTabs);

    if (state.tgtMode === 'existing') {
      const tgtSel = el('select', 'pts-select');
      tgtSel.append(new Option('请选择要覆盖的新版预设…', ''));
      state.presetNames.forEach((n) => tgtSel.append(new Option(n, n)));
      tgtSel.value = state.tgtName;
      tgtSel.onchange = () => {
        state.tgtName = tgtSel.value;
        state.manual = {};
        state.stitch = new Set();
        state.error = '';
        renderPvSection(true);
      };
      tgtField.append(tgtSel);
    } else {
      const fileRow = el('div', 'pts-file-row');
      const fileInput = topDoc.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        state.error = '';
        try {
          const parsed = await readJsonFile(file);
          validateRawJson(parsed, '新版文件');
          state.tgtFileRaw = parsed;
          state.tgtFileOrigName = file.name;
          state.tgtFileSaveName = file.name.replace(/\.json$/i, '');
          state.tgtFileToken += 1;
          state.manual = {};
          state.stitch = new Set();
        } catch (err) {
          state.tgtFileRaw = null;
          state.tgtFileOrigName = '';
          state.tgtFileSaveName = '';
          state.error = err?.message || String(err);
        }
        renderSelectCard();
        renderPvSection(true);
      };
      const pickBtn = el('button', 'pts-file-btn', '选择本地预设 JSON');
      pickBtn.type = 'button';
      pickBtn.onclick = () => fileInput.click();
      fileRow.append(
        pickBtn,
        fileInput,
        el(
          'span',
          'pts-file-info',
          state.tgtFileRaw ? `${state.tgtFileOrigName}（${state.tgtFileRaw.prompts.length} 个条目）` : '未选择文件'
        )
      );
      tgtField.append(fileRow);

      if (state.tgtFileRaw) {
        const wrap = el('div', 'pts-file-name-wrap');
        const input = el('input', 'pts-input');
        input.type = 'text';
        input.placeholder = '输入要写入酒馆的预设名称';
        input.value = state.tgtFileSaveName;
        const hint = el('div', 'pts-hint');
        const refreshHint = () => {
          const t = state.tgtFileSaveName.trim();
          const exists = t && state.presetNames.includes(t);
          hint.className = 'pts-hint' + (exists ? ' warn' : '');
          hint.textContent = !t
            ? '请填写写入酒馆的预设名称'
            : exists
              ? `酒馆中已存在「${t}」，写入时将直接覆盖`
              : `将在酒馆中导入为「${t}」并应用同步后的开关`;
          updateFooter();
        };
        input.oninput = () => {
          state.tgtFileSaveName = input.value;
          refreshHint();
        };
        wrap.append(input, hint);
        tgtField.append(wrap);
        refreshHint();
      }
    }

    card.append(tgtField);
    if (state.error) card.append(el('div', 'pts-err', state.error));
  };

  const renderPanelContent = (resetScroll = false) => {
    const c = cache.computed;
    if (!c || !refs.panelBar || !refs.panelScroll) return;
    const { rows, unusedSrc } = c;
    const prevScroll = resetScroll ? 0 : refs.panelScroll.scrollTop;

    refs.leftTab.className = 'pts-panel-tab' + (state.activeTab === 'preview' ? ' active' : '');
    refs.rightTab.className = 'pts-panel-tab' + (state.activeTab === 'stitch' ? ' active' : '');

    refs.panelBar.replaceChildren();
    refs.panelScroll.replaceChildren();

    const frag = topDoc.createDocumentFragment();

    if (state.activeTab === 'preview') {
      const onlyLab = el('label', 'pts-chk');
      const onlyCb = topDoc.createElement('input');
      onlyCb.type = 'checkbox';
      onlyCb.checked = state.onlyChg;
      onlyCb.onchange = () => {
        state.onlyChg = onlyCb.checked;
        renderPanelContent(true);
      };
      onlyLab.append(onlyCb, topDoc.createTextNode('只显示有变化 / 未匹配'));

      let shown = 0;
      rows.forEach((r) => {
        const isChg = r.s && r.t.enabled !== r.after;
        if (state.onlyChg && !isChg && r.how !== 'none') return;
        shown++;

        const row = el('div', 'pts-row');
        row.append(el('div', 'pts-nm', r.t.name));
        const meta = el('div', 'pts-meta');
        meta.append(el('span', stCls(r.t.enabled), `新版当前：${stTxt(r.t.enabled)}`));
        if (r.s) {
          meta.append(
            el('span', isChg ? 'pts-chg' : '', isChg ? '→ 同步为：' : '→ 保持：'),
            el('span', stCls(r.after), stTxt(r.after))
          );
          if (r.how === 'manual') meta.append(el('span', '', `〔手动对应：${r.s.name}〕`));
        } else {
          meta.append(el('span', '', '未找到同名旧条目，保持不变'));
        }
        row.append(meta);

        if (r.how === 'none' || r.how === 'manual') {
          const sel = el('select', 'pts-manual-sel');
          sel.append(new Option('不同步（保持新版状态）', ''));
          const opts = unusedSrc.slice();
          if (r.how === 'manual' && r.s && !opts.some((o) => o.id === r.s.id)) opts.unshift(r.s);
          opts.forEach((o) => sel.append(new Option(`对应旧条目：${o.name}（${stTxt(o.enabled)}）`, o.id)));
          sel.value = r.how === 'manual' && r.s ? r.s.id : '';
          sel.onchange = () => {
            if (sel.value) state.manual[r.t.id] = sel.value;
            else delete state.manual[r.t.id];
            renderPvSection(false);
          };
          row.append(sel);
        }

        frag.append(row);
      });

      refs.panelBar.append(onlyLab, el('span', '', `显示 ${shown} / ${rows.length} 项`));
      if (!shown) frag.append(el('div', 'pts-empty', '没有需要显示的条目。'));
    } else {
      refs.panelBar.append(el('span', '', '勾选后连内容复制到新版，跟随旧版相邻位置'));
      if (unusedSrc.length > 0) {
        const checkboxes = [];
        const miniBar = el('div', 'pts-mini-bar');
        const bAll = el('button', 'pts-mini-btn', '全选');
        bAll.type = 'button';
        bAll.onclick = () => {
          unusedSrc.forEach((u) => state.stitch.add(u.id));
          checkboxes.forEach((cb) => (cb.checked = true));
          refreshBadgesOnly();
        };
        const bNone = el('button', 'pts-mini-btn', '全不选');
        bNone.type = 'button';
        bNone.onclick = () => {
          state.stitch = new Set();
          checkboxes.forEach((cb) => (cb.checked = false));
          refreshBadgesOnly();
        };
        miniBar.append(bAll, bNone);
        refs.panelBar.append(miniBar);

        unusedSrc.forEach((u) => {
          const snippet = String(u.content || '').replace(/\s+/g, ' ').slice(0, 60);
          const lab = el('label', 'pts-sti');
          const cb = topDoc.createElement('input');
          cb.type = 'checkbox';
          cb.checked = state.stitch.has(u.id);
          cb.onchange = () => {
            if (cb.checked) state.stitch.add(u.id);
            else state.stitch.delete(u.id);
            refreshBadgesOnly();
          };
          checkboxes.push(cb);
          const info = el('div', 'pts-sti-info');
          info.append(el('div', 'pts-nm', u.name));
          const sub = el('div', 'pts-meta');
          sub.append(el('span', stCls(u.enabled), `旧版：${stTxt(u.enabled)}`));
          info.append(sub);
          if (snippet) {
            info.append(el('div', 'pts-snip', snippet + (String(u.content || '').length > 60 ? '…' : '')));
          }
          lab.append(cb, info);
          frag.append(lab);
        });
      } else {
        frag.append(el('div', 'pts-empty', '旧版没有独有的可缝合条目。'));
      }
    }

    refs.panelScroll.append(frag);
    refs.panelScroll.scrollTop = prevScroll;
  };

  const renderPvSection = (resetScroll = false) => {
    const TH = getTH();
    const host = refs.pvHost;
    if (!host) return;

    let computed = null;
    try {
      if (TH) computed = compute(TH);
    } catch (err) {
      host.replaceChildren(el('div', 'pts-err', err?.message || String(err)));
      updateFooter();
      return;
    }

    if (!computed) {
      host.replaceChildren();
      refs.sumEl = null;
      refs.leftTab = null;
      refs.rightTab = null;
      refs.leftBadge = null;
      refs.rightBadge = null;
      refs.panelBar = null;
      refs.panelScroll = null;
      updateFooter();
      return;
    }

    if (!refs.panelScroll) {
      const pvCard = el('div', 'pts-card');
      const sumEl = el('div', 'pts-sum');

      const panelTabs = el('div', 'pts-panel-tabs');
      const leftTab = el('button', 'pts-panel-tab');
      leftTab.type = 'button';
      const leftBadge = el('span', 'pts-tag-badge', '0');
      leftTab.append(topDoc.createTextNode('预览'), leftBadge);
      leftTab.onclick = () => {
        if (state.activeTab !== 'preview') {
          state.activeTab = 'preview';
          renderPanelContent(true);
        }
      };

      const rightTab = el('button', 'pts-panel-tab');
      rightTab.type = 'button';
      const rightBadge = el('span', 'pts-tag-badge', '0');
      rightTab.append(topDoc.createTextNode('缝合'), rightBadge);
      rightTab.onclick = () => {
        if (state.activeTab !== 'stitch') {
          state.activeTab = 'stitch';
          renderPanelContent(true);
        }
      };

      panelTabs.append(leftTab, rightTab);

      const panelWrap = el('div', 'pts-panel-wrap');
      const panelBar = el('div', 'pts-panel-bar');
      const panelScroll = el('div', 'pts-panel-scroll');
      panelWrap.append(panelBar, panelScroll);

      pvCard.append(sumEl, panelTabs, panelWrap);
      host.replaceChildren(pvCard);

      refs.sumEl = sumEl;
      refs.leftTab = leftTab;
      refs.rightTab = rightTab;
      refs.leftBadge = leftBadge;
      refs.rightBadge = rightBadge;
      refs.panelBar = panelBar;
      refs.panelScroll = panelScroll;
    }

    refreshBadgesOnly();
    renderPanelContent(resetScroll);
  };

  const applySync = async () => {
    const TH = getTH();
    if (!TH) {
      toast('error', '未检测到酒馆助手（TavernHelper）接口');
      return;
    }
    const res = cache.computed || compute(TH);
    if (!res) return;

    const { rows, srcFull, tgtFull } = res;
    const dec = new Map(rows.filter((r) => r.s).map((r) => [r.t.id, r.s.enabled]));
    const changedCount = rows.filter((r) => r.s && r.t.enabled !== r.after).length;
    const stitchCount = state.stitch.size;

    const tgtIdSet = new Set(tgtFull.map((e) => e.id));
    const srcToTgt = new Map(rows.filter((r) => r.s).map((r) => [r.s.id, r.t.id]));
    srcFull.forEach((e) => {
      if (e.marker && tgtIdSet.has(e.id) && !srcToTgt.has(e.id)) srcToTgt.set(e.id, e.id);
    });
    const matchedMap = new Map(srcToTgt);

    state.busy = true;
    state.error = '';
    updateFooter();

    try {
      if (state.tgtMode === 'existing') {
        const targetName = state.tgtName;
        if (!targetName) throw new Error('请选择新版预设');

        const out = clone(TH.getPreset(targetName));
        out.prompts = Array.isArray(out.prompts) ? out.prompts : [];
        out.prompts_unused = Array.isArray(out.prompts_unused) ? out.prompts_unused : [];

        out.prompts.forEach((p) => {
          if (dec.has(p.id) && !isMarkerPrompt(p, TH)) p.enabled = dec.get(p.id);
        });

        if (stitchCount > 0) {
          const usedIds = new Set([
            ...out.prompts.map((p) => p.id),
            ...out.prompts_unused.map((p) => p.id),
          ]);

          srcFull.forEach((e, i) => {
            if (!state.stitch.has(e.id)) return;
            const np = clone(e.raw);
            if (!np.id || usedIds.has(np.id) || RESERVED_IDS.has(np.id)) np.id = genId(usedIds);
            else usedIds.add(np.id);
            np.enabled = !!e.enabled;
            np.role = np.role || 'system';
            np.content = String(np.content ?? '');
            np.position = np.position || { type: 'relative' };

            let before = null;
            let after = null;
            for (let j = i - 1; j >= 0; j--) {
              const m = srcToTgt.get(srcFull[j].id);
              if (m) {
                before = m;
                break;
              }
            }
            if (!before) {
              for (let j = i + 1; j < srcFull.length; j++) {
                const m = matchedMap.get(srcFull[j].id);
                if (m) {
                  after = m;
                  break;
                }
              }
            }

            let idx = -1;
            if (before) {
              idx = out.prompts.findIndex((p) => p.id === before);
              if (idx >= 0) idx += 1;
            } else if (after) {
              idx = out.prompts.findIndex((p) => p.id === after);
            }
            if (idx < 0) out.prompts.push(np);
            else out.prompts.splice(idx, 0, np);

            srcToTgt.set(e.id, np.id);
          });
        }

        await TH.replacePreset(targetName, out, { render: 'immediate' });
        const loaded = TH.getLoadedPresetName();
        if (targetName === loaded) {
          await TH.replacePreset('in_use', out, { render: 'immediate' });
        } else if (state.switchAfter && typeof TH.loadPreset === 'function') {
          TH.loadPreset(targetName);
        }

        toast('success', `已覆盖同步「${targetName}」：变更 ${changedCount} 项开关，缝合 ${stitchCount} 个条目`);
        closeModal();
      } else {
        const targetName = state.tgtFileSaveName.trim();
        if (!targetName || targetName === 'in_use') {
          throw new Error('请填写有效的目标预设名称（不能为 in_use）');
        }
        if (!state.tgtFileRaw) throw new Error('请先选择本地新版预设 JSON 文件');

        const out = clone(state.tgtFileRaw);
        out.prompt_order.forEach((g) => {
          (g.order || []).forEach((o) => {
            if (dec.has(o.identifier)) o.enabled = dec.get(o.identifier);
          });
        });

        if (stitchCount > 0) {
          const rawSrcMap = getRawSourcePromptMap();
          const usedIds = new Set(out.prompts.map((p) => p.identifier));

          srcFull.forEach((e, i) => {
            if (!state.stitch.has(e.id)) return;
            const origRaw = rawSrcMap.get(e.id);
            let newId = e.id;
            if (!newId || usedIds.has(newId) || RESERVED_IDS.has(newId)) newId = genId(usedIds);
            else usedIds.add(newId);

            const np = origRaw
              ? { ...clone(origRaw), identifier: newId, marker: false, system_prompt: false, enabled: !!e.enabled }
              : thPromptToRaw(e.raw, newId);
            out.prompts.push(np);

            let before = null;
            let after = null;
            for (let j = i - 1; j >= 0; j--) {
              const m = srcToTgt.get(srcFull[j].id);
              if (m) {
                before = m;
                break;
              }
            }
            if (!before) {
              for (let j = i + 1; j < srcFull.length; j++) {
                const m = matchedMap.get(srcFull[j].id);
                if (m) {
                  after = m;
                  break;
                }
              }
            }

            out.prompt_order.forEach((g) => {
              g.order = g.order || [];
              const item = { identifier: np.identifier, enabled: !!e.enabled };
              let idx = -1;
              if (before) {
                idx = g.order.findIndex((o) => o.identifier === before);
                if (idx >= 0) idx += 1;
              } else if (after) {
                idx = g.order.findIndex((o) => o.identifier === after);
              }
              if (idx < 0) g.order.push(item);
              else g.order.splice(idx, 0, item);
            });

            srcToTgt.set(e.id, np.identifier);
          });
        }

        const pm = getPM();
        if (pm && typeof pm.savePreset === 'function') {
          await pm.savePreset(targetName, out);
        } else if (typeof TH.createOrReplacePreset === 'function') {
          await TH.createOrReplacePreset(targetName, rawJsonToTHPreset(out), { render: 'immediate' });
        } else {
          throw new Error('当前酒馆环境不支持直接写入预设');
        }

        const loaded = TH.getLoadedPresetName();
        if ((targetName === loaded || state.switchAfter) && typeof TH.loadPreset === 'function') {
          TH.loadPreset(targetName);
        }

        toast('success', `已导入并同步「${targetName}」：变更 ${changedCount} 项开关，缝合 ${stitchCount} 个条目`);
        closeModal();
      }
    } catch (err) {
      state.busy = false;
      state.error = err?.message || String(err);
      toast('error', state.error);
      renderSelectCard();
      updateFooter();
    }
  };

  const closeModal = () => {
    if (dialogEl) {
      try {
        if (dialogEl.open && typeof dialogEl.close === 'function') dialogEl.close();
      } catch {}
      dialogEl.remove();
      dialogEl = null;
    }
    refs = {};
    resetCache();
  };

  const openModal = () => {
    const TH = getTH();
    if (!TH || typeof TH.getPresetNames !== 'function') {
      toast('error', '未检测到酒馆助手（TavernHelper）预设接口，请确认已更新酒馆助手');
      return;
    }

    injectStyle();
    closeModal();

    state.presetNames = TH.getPresetNames() || [];
    state.loadedName = TH.getLoadedPresetName?.() || '';
    state.srcKey = 'in_use';
    state.tgtMode = 'existing';
    state.tgtName = '';
    state.tgtFileRaw = null;
    state.tgtFileOrigName = '';
    state.tgtFileSaveName = '';
    state.activeTab = 'preview';
    state.manual = {};
    state.stitch = new Set();
    state.error = '';
    state.busy = false;

    const dialog = topDoc.createElement('dialog');
    dialog.id = IDS.DIALOG;
    dialog.onclick = (e) => {
      if (e.target === dialog && !state.busy) closeModal();
    };
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!state.busy) closeModal();
    });

    const modal = el('div', 'pts-modal');

    const header = el('div', 'pts-header');
    const titleWrap = el('div', 'pts-title-wrap');
    titleWrap.append(el('h3', 'pts-title', '预设开关同步 · 缝合'), el('span', 'pts-ver', `v${VERSION}`));
    const closeBtn = el('button', 'pts-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.onclick = () => {
      if (!state.busy) closeModal();
    };
    header.append(titleWrap, closeBtn);

    const body = el('div', 'pts-body');
    const selectCard = el('div', 'pts-card');
    const pvHost = el('div', '');
    body.append(selectCard, pvHost);

    const footer = el('div', 'pts-footer');
    const swLab = el('label', 'pts-chk');
    const swCb = topDoc.createElement('input');
    swCb.type = 'checkbox';
    swCb.checked = state.switchAfter;
    swCb.onchange = () => {
      state.switchAfter = swCb.checked;
    };
    swLab.append(swCb, topDoc.createTextNode('同步后切换到新版预设'));

    const submitBtn = el('button', 'pts-submit', '覆盖写入新版预设');
    submitBtn.type = 'button';
    submitBtn.disabled = true;
    submitBtn.onclick = () => applySync();
    footer.append(swLab, submitBtn);

    modal.append(header, body, footer);
    dialog.append(modal);
    topDoc.body.appendChild(dialog);
    syncThemeTokens(dialog);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    dialogEl = dialog;
    refs = { selectCard, pvHost, submitBtn };

    renderSelectCard();
    renderPvSection(true);
  };

  const restorePatchedLayout = () => {
    if (patchedParent) {
      patchedParent.style.removeProperty('display');
      patchedParent.style.removeProperty('flex-wrap');
      patchedParent.style.removeProperty('align-items');
      patchedParent.style.removeProperty('gap');
      patchedParent = null;
    }
    if (patchedPrev) {
      patchedPrev.style.removeProperty('white-space');
      patchedPrev.style.removeProperty('flex-shrink');
      patchedPrev = null;
    }
  };

  const mountPresetPanelButton = () => {
    if (topDoc.getElementById(IDS.BTN)) return true;
    const anchor =
      topDoc.getElementById('delete_oai_preset') ||
      topDoc.getElementById('export_oai_preset') ||
      topDoc.getElementById('import_oai_preset') ||
      topDoc.getElementById('update_oai_preset') ||
      topDoc.getElementById('settings_preset_openai');
    if (!anchor || !anchor.parentElement) return false;

    const btn = topDoc.createElement('div');
    btn.id = IDS.BTN;
    const inherited = (anchor.className || 'menu_button menu_button_icon fa-solid')
      .split(/\s+/)
      .filter((c) => c && (c === 'fa-solid' || !c.startsWith('fa-')))
      .join(' ');
    btn.className = inherited || 'menu_button menu_button_icon fa-solid';
    btn.title = `预设开关同步 · 缝合 v${VERSION}`;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = ICON_SVG;
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openModal();
    };
    btn.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openModal();
      }
    };
    anchor.insertAdjacentElement('afterend', btn);

    const parent = anchor.parentElement;
    if (parent && !parent.querySelector('select')) {
      parent.style.setProperty('display', 'flex', 'important');
      parent.style.setProperty('flex-wrap', 'nowrap', 'important');
      parent.style.setProperty('align-items', 'center', 'important');
      parent.style.setProperty('gap', 'clamp(4px, 1.8vw, 12px)', 'important');
      patchedParent = parent;
      const prev = parent.previousElementSibling;
      if (prev && !prev.querySelector('select')) {
        prev.style.setProperty('white-space', 'nowrap', 'important');
        prev.style.setProperty('flex-shrink', '0', 'important');
        patchedPrev = prev;
      }
    }
    return true;
  };

  const cleanup = () => {
    closeModal();
    restorePatchedLayout();
    if (mountTimer) {
      clearInterval(mountTimer);
      mountTimer = null;
    }
    topDoc.getElementById(IDS.BTN)?.remove();
    topDoc.getElementById(IDS.STYLE)?.remove();
  };

  const init = () => {
    cleanup();
    injectStyle();

    if (!mountPresetPanelButton()) {
      let tries = 0;
      mountTimer = setInterval(() => {
        tries += 1;
        if (mountPresetPanelButton() || tries >= 15) {
          clearInterval(mountTimer);
          mountTimer = null;
        }
      }, 500);
    }

    try {
      if (typeof window.getButtonEvent === 'function' && typeof window.eventOn === 'function') {
        const ev = window.getButtonEvent(BUTTON_NAME);
        if (ev) window.eventOn(ev, () => openModal());
      }
    } catch {}
  };

  if (typeof window.$ === 'function') {
    window.$(() => init());
    window.$(window).on('pagehide', () => cleanup());
  } else {
    if (topDoc.readyState === 'loading') {
      topDoc.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
    window.addEventListener('pagehide', cleanup);
  }
})();
