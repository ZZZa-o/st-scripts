/**
 * 预设开关同步 · 缝合工具（酒馆助手全局脚本 v0.1）
 * - 完全跟随酒馆主题变量（--SmartTheme*），自动适配浅色/深色主题
 * - 支持将旧版预设的提示词条目开关按名称同步到新版预设，并缝合旧版独有条目
 * - 支持覆盖酒馆已有预设，或选择本地 JSON 文件一步导入并同步覆盖
 */
(() => {
  const IDS = {
    STYLE: 'pts-sync-style',
    BTN: 'pts-sync-open-btn',
    BACKDROP: 'pts-sync-backdrop',
  };

  const BUTTON_NAME = '预设同步';

  // 系统占位/标记条目 ID：不参与开关同步与缝合，仅作为缝合时的位置锚点
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

  // 系统保留 ID：缝合生成新条目时避免冲突
  const SYSTEM_IDS = new Set([
    'main',
    'nsfw',
    'jailbreak',
    'enhanceDefinitions',
  ]);

  const RESERVED_IDS = new Set([...PLACEHOLDER_IDS, ...SYSTEM_IDS]);

  const topWin = window.parent || window;
  const topDoc = topWin.document;

  const getTH = () => window.TavernHelper || topWin.TavernHelper;
  const getPM = () => {
    try {
      const ctx =
        topWin.SillyTavern?.getContext?.() ||
        window.SillyTavern?.getContext?.();
      return ctx?.getPresetManager?.('openai') || null;
    } catch {
      return null;
    }
  };

  const toast = (type, msg) => {
    const t = topWin.toastr || window.toastr;
    if (t && typeof t[type] === 'function') {
      t[type](msg, '预设开关同步');
    } else if (type === 'error') {
      console.error('[预设开关同步]', msg);
    } else {
      console.log('[预设开关同步]', msg);
    }
  };

  const norm = (s) =>
    String(s == null ? '' : s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  const clone = (obj) => JSON.parse(JSON.stringify(obj));

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
    } catch {
      // ignore
    }
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
    if (
      !p ||
      !Array.isArray(p.prompts) ||
      !Array.isArray(p.prompt_order) ||
      !p.prompt_order.length
    ) {
      throw new Error(`${label}不是有效的酒馆对话补全预设（缺少 prompts 或 prompt_order）`);
    }
  };

  const entriesFromTHPreset = (preset, TH) => {
    const list = Array.isArray(preset?.prompts) ? preset.prompts : [];
    return list.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      enabled: !!p.enabled,
      marker: isMarkerPrompt(p, TH),
      content: String(p.content ?? ''),
      raw: p,
    }));
  };

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
    if (!PLACEHOLDER_IDS.has(pr.identifier) && !pr.marker) {
      base.content = String(pr.content ?? '');
    }
    if (!SYSTEM_IDS.has(pr.identifier)) {
      base.position = isChat
        ? {
            type: 'in_chat',
            depth: Number(pr.injection_depth ?? 4),
            order: Number(pr.injection_order ?? 100),
          }
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
    return {
      prompts,
      prompts_unused,
      extensions: rawJson.extensions ? clone(rawJson.extensions) : {},
    };
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

  // 读取酒馆 UI 背景色并转为不透明版本，保证半透明主题下主按钮反色文字依然清晰
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
    if (m) {
      container.style.setProperty('--pts-solid-bg', `rgb(${m[1]}, ${m[2]}, ${m[3]})`);
    }
  };

  const state = {
    presetNames: [],
    loadedName: '',
    srcKey: 'in_use',
    tgtMode: 'existing', // 'existing' | 'file'
    tgtName: '',
    tgtFileRaw: null,
    tgtFileOrigName: '',
    tgtFileSaveName: '',
    activeTab: 'preview', // 'preview'（左） | 'stitch'（右）
    onlyChg: false,
    switchAfter: false,
    manual: {},
    stitch: new Set(),
    error: '',
    busy: false,
  };

  let observer = null;
  let modalEl = null;

  const CSS_TEXT = `
#${IDS.BTN} {
  cursor: pointer;
}
#${IDS.BACKDROP} {
  --pts-solid-bg: var(--SmartThemeBlurTintColor);
  --pts-bg: var(--SmartThemeBlurTintColor, var(--SmartThemeChatTintColor));
  --pts-text: var(--SmartThemeBodyColor);
  --pts-sub: var(--SmartThemeEmColor, color-mix(in srgb, var(--SmartThemeBodyColor) 62%, transparent));
  --pts-border: color-mix(in srgb, var(--SmartThemeBorderColor) 65%, color-mix(in srgb, var(--SmartThemeBodyColor) 16%, transparent));
  --pts-border-soft: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
  --pts-card-bg: color-mix(in srgb, var(--SmartThemeBodyColor) 3.5%, transparent);
  --pts-input-bg: color-mix(in srgb, var(--SmartThemeChatTintColor, var(--pts-solid-bg)) 92%, var(--pts-solid-bg) 8%);
  --pts-hover: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
  --pts-active-bg: var(--SmartThemeBodyColor);
  --pts-active-fg: var(--pts-solid-bg);

  position: fixed;
  inset: 0;
  z-index: 20000;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--pts-text);
}
@media (min-width: 768px) {
  #${IDS.BACKDROP} { padding: 36px 48px; }
}
#${IDS.BACKDROP} * { box-sizing: border-box; }

.pts-modal {
  width: 100%;
  max-width: 600px;
  max-height: calc(100dvh - 44px);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--pts-bg) 94%, var(--pts-solid-bg) 6%);
  backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px));
  -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px));
  border: 1px solid var(--pts-border);
  border-radius: 16px;
  box-shadow: 0 14px 40px var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.18));
  overflow: hidden;
  font-size: 14px;
  line-height: 1.5;
  color: var(--pts-text);
}
@media (min-width: 768px) {
  .pts-modal { max-height: calc(100dvh - 80px); }
}

.pts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--pts-border-soft);
  flex-shrink: 0;
}
.pts-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--pts-text);
}
.pts-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--pts-border);
  background: transparent;
  color: var(--pts-text);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.pts-close:hover { background: var(--pts-hover); }

.pts-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pts-card {
  background: var(--pts-card-bg);
  border: 1px solid var(--pts-border);
  border-radius: 12px;
  padding: 12px;
}
.pts-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--pts-text);
  margin: 0 0 6px;
}
.pts-field + .pts-field { margin-top: 11px; }

.pts-select, .pts-input {
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border-radius: 9px;
  border: 1px solid var(--pts-border);
  background: var(--pts-input-bg);
  color: var(--pts-text);
  font-size: 14px;
  outline: none;
}
@media (max-width: 767px) {
  .pts-select, .pts-input { font-size: 16px; }
}
.pts-select:focus, .pts-input:focus {
  border-color: var(--pts-text);
}

.pts-mode-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--pts-hover);
  border: 1px solid var(--pts-border-soft);
  margin-bottom: 8px;
}
.pts-mode-tab {
  border: 0;
  border-radius: 7px;
  padding: 4px 12px;
  font-size: 12.5px;
  cursor: pointer;
  background: transparent;
  color: var(--pts-sub);
  transition: background 0.15s, color 0.15s;
}
.pts-mode-tab.active {
  background: var(--pts-active-bg);
  color: var(--pts-active-fg);
  font-weight: 600;
}

.pts-file-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pts-file-btn {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--pts-border);
  background: var(--pts-input-bg);
  color: var(--pts-text);
  font-size: 13px;
  cursor: pointer;
}
.pts-file-btn:hover { background: var(--pts-hover); }
.pts-file-info { font-size: 12px; color: var(--pts-sub); word-break: break-all; }
.pts-file-name-wrap { margin-top: 8px; }
.pts-hint { font-size: 12px; color: var(--pts-sub); margin-top: 4px; }
.pts-hint.warn { color: #b87400; }
.pts-err { color: #c0392b; font-size: 13px; margin-top: 8px; }

.pts-sum {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.pts-pill {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--pts-input-bg);
  border: 1px solid var(--pts-border);
  color: var(--pts-sub);
}
.pts-pill.hl {
  color: var(--pts-text);
  border-color: var(--pts-text);
  font-weight: 600;
}

.pts-panel-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 4px;
  border-radius: 10px;
  background: var(--pts-hover);
  border: 1px solid var(--pts-border-soft);
}
.pts-panel-tab {
  border: 0;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: transparent;
  color: var(--pts-sub);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.15s, color 0.15s;
}
.pts-panel-tab.active {
  background: var(--pts-active-bg);
  color: var(--pts-active-fg);
}
.pts-tag-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 14%, transparent);
}

.pts-panel-wrap {
  margin-top: 8px;
  border: 1px solid var(--pts-border);
  border-radius: 10px;
  background: var(--pts-input-bg);
  overflow: hidden;
}
.pts-panel-bar {
  min-height: 36px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--pts-border-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--pts-sub);
}
.pts-panel-scroll {
  height: min(240px, 34dvh);
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 0 11px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--pts-text) 24%, transparent) transparent;
}
.pts-panel-scroll::-webkit-scrollbar,
.pts-body::-webkit-scrollbar { width: 6px; }
.pts-panel-scroll::-webkit-scrollbar-thumb,
.pts-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--pts-text) 22%, transparent);
  border-radius: 999px;
}

.pts-chk {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--pts-text);
  cursor: pointer;
  user-select: none;
}
.pts-chk input {
  margin: 0;
  accent-color: var(--pts-text);
}

.pts-mini-bar { display: inline-flex; gap: 6px; }
.pts-mini-btn {
  padding: 2px 9px;
  border-radius: 6px;
  border: 1px solid var(--pts-border);
  background: transparent;
  color: var(--pts-text);
  font-size: 12px;
  cursor: pointer;
}
.pts-mini-btn:hover { background: var(--pts-hover); }

.pts-row {
  border-top: 1px solid var(--pts-border-soft);
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pts-row:first-child { border-top: 0; }
.pts-nm {
  font-weight: 600;
  font-size: 13px;
  color: var(--pts-text);
  word-break: break-word;
}
.pts-meta {
  font-size: 12px;
  color: var(--pts-sub);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.pts-on { color: #248a52; font-weight: 600; }
.pts-off { color: #c7473c; font-weight: 600; }
.pts-chg { color: #b87400; font-weight: 600; }

.pts-manual-sel {
  width: 100%;
  margin-top: 2px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--pts-border);
  background: var(--pts-bg);
  color: var(--pts-text);
  font-size: 12px;
}

.pts-sti {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  border-top: 1px solid var(--pts-border-soft);
  padding: 8px 0;
  cursor: pointer;
}
.pts-sti:first-child { border-top: 0; }
.pts-sti input {
  margin: 3px 0 0;
  flex-shrink: 0;
  accent-color: var(--pts-text);
}
.pts-sti-info { min-width: 0; flex: 1; }
.pts-snip {
  font-size: 12px;
  color: var(--pts-sub);
  word-break: break-all;
  margin-top: 2px;
}
.pts-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12.5px;
  color: var(--pts-sub);
  text-align: center;
  padding: 16px;
}

.pts-footer {
  padding: 11px 16px 14px;
  border-top: 1px solid var(--pts-border-soft);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pts-submit {
  width: 100%;
  min-height: 40px;
  border: 0;
  border-radius: 10px;
  background: var(--pts-active-bg);
  color: var(--pts-active-fg);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.pts-submit:hover:not(:disabled) { opacity: 0.88; }
.pts-submit:disabled { opacity: 0.35; cursor: not-allowed; }
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

  const getSourceEntries = (TH) => entriesFromTHPreset(TH.getPreset(state.srcKey), TH);

  const getTargetEntries = (TH) => {
    if (state.tgtMode === 'file') {
      if (!state.tgtFileRaw) return null;
      return entriesFromRawJson(state.tgtFileRaw);
    }
    if (!state.tgtName) return null;
    return entriesFromTHPreset(TH.getPreset(state.tgtName), TH);
  };

  const compute = (TH) => {
    const srcFull = getSourceEntries(TH);
    const tgtFull = getTargetEntries(TH);
    if (!srcFull || !tgtFull) return null;

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

    // 第一轮：手动指定
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

    // 第二轮：按名称自动匹配
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

    return { rows, unusedSrc, srcFull, tgtFull };
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
    } catch {
      // ignore
    }
    return map;
  };

  const applySync = async () => {
    const TH = getTH();
    if (!TH) {
      toast('error', '未检测到酒馆助手（TavernHelper）接口');
      return;
    }

    const res = compute(TH);
    if (!res) return;

    const { rows, srcFull, tgtFull } = res;
    const dec = new Map(rows.filter((r) => r.s).map((r) => [r.t.id, r.s.enabled]));
    const changedCount = rows.filter((r) => r.s && r.t.enabled !== r.after).length;
    const stitchCount = state.stitch.size;

    const tgtIdSet = new Set(tgtFull.map((e) => e.id));
    const srcToTgt = new Map(rows.filter((r) => r.s).map((r) => [r.s.id, r.t.id]));
    srcFull.forEach((e) => {
      if (e.marker && tgtIdSet.has(e.id) && !srcToTgt.has(e.id)) {
        srcToTgt.set(e.id, e.id);
      }
    });
    const matchedMap = new Map(srcToTgt);

    state.busy = true;
    state.error = '';
    renderModal();

    try {
      if (state.tgtMode === 'existing') {
        const targetName = state.tgtName;
        if (!targetName) throw new Error('请选择新版预设');

        const out = clone(TH.getPreset(targetName));
        out.prompts = Array.isArray(out.prompts) ? out.prompts : [];
        out.prompts_unused = Array.isArray(out.prompts_unused) ? out.prompts_unused : [];

        out.prompts.forEach((p) => {
          if (dec.has(p.id) && !isMarkerPrompt(p, TH)) {
            p.enabled = dec.get(p.id);
          }
        });

        if (stitchCount > 0) {
          const usedIds = new Set([
            ...out.prompts.map((p) => p.id),
            ...out.prompts_unused.map((p) => p.id),
          ]);

          srcFull.forEach((e, i) => {
            if (!state.stitch.has(e.id)) return;
            const np = clone(e.raw);
            if (!np.id || usedIds.has(np.id) || RESERVED_IDS.has(np.id)) {
              np.id = genId(usedIds);
            } else {
              usedIds.add(np.id);
            }
            np.enabled = !!e.enabled;
            np.role = np.role || 'system';
            np.content = String(np.content ?? '');
            np.position = np.position || { type: 'relative' };

            let before = null;
            let after = null;
            for (let j = i - 1; j >= 0; j--) {
              const m = srcToTgt.get(srcFull[j].id);
              if (m) { before = m; break; }
            }
            if (!before) {
              for (let j = i + 1; j < srcFull.length; j++) {
                const m = matchedMap.get(srcFull[j].id);
                if (m) { after = m; break; }
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

        toast(
          'success',
          `已覆盖同步「${targetName}」：变更 ${changedCount} 项开关，缝合 ${stitchCount} 个条目`
        );
        closeModal();
      } else {
        const targetName = state.tgtFileSaveName.trim();
        if (!targetName || targetName === 'in_use') {
          throw new Error('请填写有效的目标预设名称（不能为 in_use）');
        }
        if (!state.tgtFileRaw) {
          throw new Error('请先选择本地新版预设 JSON 文件');
        }

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
            if (!newId || usedIds.has(newId) || RESERVED_IDS.has(newId)) {
              newId = genId(usedIds);
            } else {
              usedIds.add(newId);
            }

            const np = origRaw
              ? {
                  ...clone(origRaw),
                  identifier: newId,
                  marker: false,
                  system_prompt: false,
                  enabled: !!e.enabled,
                }
              : thPromptToRaw(e.raw, newId);

            out.prompts.push(np);

            let before = null;
            let after = null;
            for (let j = i - 1; j >= 0; j--) {
              const m = srcToTgt.get(srcFull[j].id);
              if (m) { before = m; break; }
            }
            if (!before) {
              for (let j = i + 1; j < srcFull.length; j++) {
                const m = matchedMap.get(srcFull[j].id);
                if (m) { after = m; break; }
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
          const thPreset = rawJsonToTHPreset(out);
          await TH.createOrReplacePreset(targetName, thPreset, { render: 'immediate' });
        } else {
          throw new Error('当前酒馆环境不支持直接写入预设');
        }

        const loaded = TH.getLoadedPresetName();
        if (
          (targetName === loaded || state.switchAfter) &&
          typeof TH.loadPreset === 'function'
        ) {
          TH.loadPreset(targetName);
        }

        toast(
          'success',
          `已导入并同步「${targetName}」：变更 ${changedCount} 项开关，缝合 ${stitchCount} 个条目`
        );
        closeModal();
      }
    } catch (err) {
      state.busy = false;
      state.error = err?.message || String(err);
      toast('error', state.error);
      renderModal();
    }
  };

  const renderModal = (resetPanelScroll = false) => {
    if (!modalEl) return;
    syncThemeTokens(modalEl);

    const TH = getTH();
    const body = modalEl.querySelector('.pts-body');
    const footerBtn = modalEl.querySelector('.pts-submit');
    if (!body || !footerBtn) return;

    const prevBodyScroll = body.scrollTop;
    const prevPanelScroll = resetPanelScroll
      ? 0
      : body.querySelector('.pts-panel-scroll')?.scrollTop || 0;

    body.replaceChildren();

    // 卡片 1：预设选择
    const selectCard = el('div', 'pts-card');

    const srcField = el('div', 'pts-field');
    srcField.append(el('label', 'pts-label', '① 旧版预设（开关状态来源）'));
    const srcSel = el('select', 'pts-select');
    srcSel.append(
      new Option(`当前使用中（实时）：${state.loadedName || '未命名'}`, 'in_use')
    );
    state.presetNames.forEach((n) => srcSel.append(new Option(n, n)));
    srcSel.value = state.srcKey;
    srcSel.onchange = () => {
      state.srcKey = srcSel.value;
      state.manual = {};
      state.stitch = new Set();
      state.error = '';
      renderModal(true);
    };
    srcField.append(srcSel);
    selectCard.append(srcField);

    const tgtField = el('div', 'pts-field');
    tgtField.append(el('label', 'pts-label', '② 新版预设（被覆盖的目标）'));

    const modeTabs = el('div', 'pts-mode-tabs');
    const tabEx = el(
      'button',
      'pts-mode-tab' + (state.tgtMode === 'existing' ? ' active' : ''),
      '酒馆已有预设'
    );
    tabEx.type = 'button';
    tabEx.onclick = () => {
      if (state.tgtMode !== 'existing') {
        state.tgtMode = 'existing';
        state.manual = {};
        state.stitch = new Set();
        state.error = '';
        renderModal(true);
      }
    };
    const tabFl = el(
      'button',
      'pts-mode-tab' + (state.tgtMode === 'file' ? ' active' : ''),
      '导入本地 JSON'
    );
    tabFl.type = 'button';
    tabFl.onclick = () => {
      if (state.tgtMode !== 'file') {
        state.tgtMode = 'file';
        state.manual = {};
        state.stitch = new Set();
        state.error = '';
        renderModal(true);
      }
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
        renderModal(true);
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
          state.manual = {};
          state.stitch = new Set();
        } catch (err) {
          state.tgtFileRaw = null;
          state.tgtFileOrigName = '';
          state.tgtFileSaveName = '';
          state.error = err?.message || String(err);
        }
        renderModal(true);
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
          state.tgtFileRaw
            ? `${state.tgtFileOrigName}（${state.tgtFileRaw.prompts.length} 个条目）`
            : '未选择文件'
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
          footerBtn.disabled = state.busy || !t || t === 'in_use';
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

    selectCard.append(tgtField);
    if (state.error) selectCard.append(el('div', 'pts-err', state.error));
    body.append(selectCard);

    // 卡片 2：统一高度的「预览（左）/ 缝合（右）」双 Tag 分区
    let computed = null;
    try {
      if (TH) computed = compute(TH);
    } catch (err) {
      body.append(el('div', 'pts-err', err?.message || String(err)));
    }

    if (computed) {
      const { rows, unusedSrc } = computed;
      const matched = rows.filter((r) => r.s).length;
      const changed = rows.filter((r) => r.s && r.t.enabled !== r.after).length;
      const none = rows.filter((r) => r.how === 'none').length;

      const pvCard = el('div', 'pts-card');

      const sum = el('div', 'pts-sum');
      [
        [`新版 ${rows.length}`, false],
        [`匹配 ${matched}`, false],
        [`变更 ${changed}`, changed > 0],
        [`未匹配 ${none}`, false],
        [`已选缝合 ${state.stitch.size}/${unusedSrc.length}`, state.stitch.size > 0],
      ].forEach(([txt, hl]) => {
        sum.append(el('span', 'pts-pill' + (hl ? ' hl' : ''), txt));
      });
      pvCard.append(sum);

      const panelTabs = el('div', 'pts-panel-tabs');

      const leftTab = el(
        'button',
        'pts-panel-tab' + (state.activeTab === 'preview' ? ' active' : '')
      );
      leftTab.type = 'button';
      leftTab.append(
        topDoc.createTextNode('预览'),
        el('span', 'pts-tag-badge', String(rows.length))
      );
      leftTab.onclick = () => {
        if (state.activeTab !== 'preview') {
          state.activeTab = 'preview';
          renderModal(true);
        }
      };

      const rightTab = el(
        'button',
        'pts-panel-tab' + (state.activeTab === 'stitch' ? ' active' : '')
      );
      rightTab.type = 'button';
      rightTab.append(
        topDoc.createTextNode('缝合'),
        el(
          'span',
          'pts-tag-badge',
          state.stitch.size > 0
            ? `${state.stitch.size}/${unusedSrc.length}`
            : String(unusedSrc.length)
        )
      );
      rightTab.onclick = () => {
        if (state.activeTab !== 'stitch') {
          state.activeTab = 'stitch';
          renderModal(true);
        }
      };

      panelTabs.append(leftTab, rightTab);
      pvCard.append(panelTabs);

      const panelWrap = el('div', 'pts-panel-wrap');
      const panelBar = el('div', 'pts-panel-bar');
      const panelScroll = el('div', 'pts-panel-scroll');

      if (state.activeTab === 'preview') {
        const onlyLab = el('label', 'pts-chk');
        const onlyCb = topDoc.createElement('input');
        onlyCb.type = 'checkbox';
        onlyCb.checked = state.onlyChg;
        onlyCb.onchange = () => {
          state.onlyChg = onlyCb.checked;
          renderModal(true);
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
            if (r.how === 'manual') {
              meta.append(el('span', '', `〔手动对应：${r.s.name}〕`));
            }
          } else {
            meta.append(el('span', '', '未找到同名旧条目，保持不变'));
          }
          row.append(meta);

          if (r.how === 'none' || r.how === 'manual') {
            const sel = el('select', 'pts-manual-sel');
            sel.append(new Option('不同步（保持新版状态）', ''));
            const opts = unusedSrc.slice();
            if (r.how === 'manual' && r.s && !opts.some((o) => o.id === r.s.id)) {
              opts.unshift(r.s);
            }
            opts.forEach((o) => {
              sel.append(new Option(`对应旧条目：${o.name}（${stTxt(o.enabled)}）`, o.id));
            });
            sel.value = r.how === 'manual' && r.s ? r.s.id : '';
            sel.onchange = () => {
              if (sel.value) state.manual[r.t.id] = sel.value;
              else delete state.manual[r.t.id];
              renderModal(false);
            };
            row.append(sel);
          }

          panelScroll.append(row);
        });

        panelBar.append(onlyLab, el('span', '', `显示 ${shown} / ${rows.length} 项`));
        if (!shown) panelScroll.append(el('div', 'pts-empty', '没有需要显示的条目。'));
      } else {
        panelBar.append(el('span', '', '勾选后连内容复制到新版，跟随旧版相邻位置'));
        if (unusedSrc.length > 0) {
          const miniBar = el('div', 'pts-mini-bar');
          const bAll = el('button', 'pts-mini-btn', '全选');
          bAll.type = 'button';
          bAll.onclick = () => {
            unusedSrc.forEach((c) => state.stitch.add(c.id));
            renderModal(false);
          };
          const bNone = el('button', 'pts-mini-btn', '全不选');
          bNone.type = 'button';
          bNone.onclick = () => {
            state.stitch = new Set();
            renderModal(false);
          };
          miniBar.append(bAll, bNone);
          panelBar.append(miniBar);

          unusedSrc.forEach((c) => {
            const snippet = String(c.content || '').replace(/\s+/g, ' ').slice(0, 60);
            const lab = el('label', 'pts-sti');
            const cb = topDoc.createElement('input');
            cb.type = 'checkbox';
            cb.checked = state.stitch.has(c.id);
            cb.onchange = () => {
              if (cb.checked) state.stitch.add(c.id);
              else state.stitch.delete(c.id);
              renderModal(false);
            };
            const info = el('div', 'pts-sti-info');
            info.append(el('div', 'pts-nm', c.name));
            const sub = el('div', 'pts-meta');
            sub.append(el('span', stCls(c.enabled), `旧版：${stTxt(c.enabled)}`));
            info.append(sub);
            if (snippet) {
              info.append(
                el(
                  'div',
                  'pts-snip',
                  snippet + (String(c.content || '').length > 60 ? '…' : '')
                )
              );
            }
            lab.append(cb, info);
            panelScroll.append(lab);
          });
        } else {
          panelScroll.append(el('div', 'pts-empty', '旧版没有独有的可缝合条目。'));
        }
      }

      panelWrap.append(panelBar, panelScroll);
      pvCard.append(panelWrap);
      body.append(pvCard);
    }

    const canSubmit =
      !state.busy &&
      !!computed &&
      (state.tgtMode === 'existing'
        ? !!state.tgtName
        : !!state.tgtFileRaw &&
          !!state.tgtFileSaveName.trim() &&
          state.tgtFileSaveName.trim() !== 'in_use');

    footerBtn.disabled = !canSubmit;
    footerBtn.textContent = state.busy
      ? '正在覆盖写入…'
      : state.tgtMode === 'file'
        ? '导入并覆盖写入预设'
        : '覆盖写入新版预设';

    body.scrollTop = prevBodyScroll;
    const newPanelScroll = body.querySelector('.pts-panel-scroll');
    if (newPanelScroll) newPanelScroll.scrollTop = prevPanelScroll;
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && modalEl && !state.busy) closeModal();
  };

  const closeModal = () => {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
    topDoc.removeEventListener('keydown', onKeyDown);
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

    const backdrop = el('div', '');
    backdrop.id = IDS.BACKDROP;
    backdrop.onclick = (e) => {
      if (e.target === backdrop && !state.busy) closeModal();
    };

    const modal = el('div', 'pts-modal');

    const header = el('div', 'pts-header');
    header.append(el('h3', 'pts-title', '预设开关同步 · 缝合'));
    const closeBtn = el('button', 'pts-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.onclick = () => {
      if (!state.busy) closeModal();
    };
    header.append(closeBtn);

    const body = el('div', 'pts-body');

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
    backdrop.append(modal);
    topDoc.body.appendChild(backdrop);

    modalEl = backdrop;
    topDoc.addEventListener('keydown', onKeyDown);
    renderModal(true);
  };

  // 在酒馆预设面板嵌入入口按钮
  const mountPresetPanelButton = () => {
    if (topDoc.getElementById(IDS.BTN)) return true;
    const select = topDoc.getElementById('settings_preset_openai');
    if (!select) return false;

    const btn = topDoc.createElement('div');
    btn.id = IDS.BTN;
    btn.className = 'menu_button menu_button_icon fa-solid fa-arrows-rotate';
    btn.title = '预设开关同步 · 缝合';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
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

    const anchor =
      topDoc.getElementById('import_oai_preset') ||
      topDoc.getElementById('export_oai_preset') ||
      topDoc.getElementById('update_oai_preset') ||
      select;

    if (anchor && anchor.parentElement) {
      anchor.insertAdjacentElement('afterend', btn);
      return true;
    }
    return false;
  };

  const cleanup = () => {
    closeModal();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    topDoc.getElementById(IDS.BTN)?.remove();
    topDoc.getElementById(IDS.STYLE)?.remove();
  };

  const init = () => {
    cleanup();
    injectStyle();

    if (!mountPresetPanelButton()) {
      observer = new MutationObserver(() => {
        if (mountPresetPanelButton() && observer) {
          observer.disconnect();
          observer = null;
        }
      });
      observer.observe(topDoc.body, { childList: true, subtree: true });
    }

    try {
      if (typeof window.getButtonEvent === 'function' && typeof window.eventOn === 'function') {
        const ev = window.getButtonEvent(BUTTON_NAME);
        if (ev) {
          window.eventOn(ev, () => openModal());
        }
      }
    } catch (err) {
      console.warn('[预设开关同步] 绑定脚本按钮失败:', err);
    }
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
