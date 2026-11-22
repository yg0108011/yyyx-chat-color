/*!
 * 聊天文字调色 v1.1.6
 * SillyTavern UI 扩展
 *
 * 功能：
 * 1. 改色仅作用于酒馆聊天消息（#chat .mes），不影响任何其他界面。
 * 2. 主要文本 / 斜体文本 / 引用文本可分别调色：
 *    - 跟随酒馆主题（不做任何处理）
 *    - 纯色（可自定义颜色）
 *    - 渐变（自定义 2~4 个颜色，可调整渐变角度 0~360°）
 *      渐变带霓虹光晕开关与强度调节（逐字三层辉光，跟随每个字自己的颜色）
 * 3. 渐变粒度：主要文本 = 整条消息；斜体 = 按段落；引用 = 按引号对，
 *    六种引号（英文 ""、中文 “”、直角 「」、双直角 『』、法语 «»、全角 ＂＂）
 *    连同其中文字（含开闭引号）作为一个独立渐变循环。
 * 4. 内置 10 套配色预设 + 3 套可保存的自定义预设。
 * 5. 设置面板跟随酒馆主题与字体大小，顶部横排文字类型标签切换。
 *
 * 性能设计：
 * - 离屏门控：仅对接近视口的消息做逐字染色（IntersectionObserver）。
 * - 流式生成期间以 CSS 近似色兜底（酒馆重建 DOM 时新文本立即着色、不闪烁），
 *   DOM 稳定后再补逐字精确，生成结束后统一按真实位置校正。
 * - 批量读取字符位置（一次布局后统一计算颜色），阴影字符串缓存。
 */
(() => {
    'use strict';

    // ===== 基础常量 =====
    const MODULE = 'yyyx_chat_color';
    const VERSION = '1.1.7';
    const TAG = '[聊天文字调色]';
    const TARGET_KEYS = ['main', 'italic', 'quote'];
    const TARGET_LABELS = { main: '主要文本', italic: '斜体文本', quote: '引用文本' };
    const MAX_STOPS = 4;
    const MIN_STOPS = 2;

    // 句子结束符（保留：测试与历史兼容；引用渐变自 v1.1.3 起改为按引号对分段）
    const SENTENCE_END = /[。！？!?…\n]/;

    // 引用渐变按「六种引号对」分段：每对引号连同其中文字（含开闭引号）作为独立渐变循环。
    // 开闭同字符（toggle）：英文 "、全角 ＂；开闭不同字符：中文 “”、直角 「」、双直角 『』、法语 «»
    const QUOTE_TOGGLE = new Set(['"', '＂']);
    const QUOTE_OPEN = new Set(['“', '「', '『', '«']);
    const QUOTE_CLOSE = new Set(['”', '」', '』', '»']);

    // 10 套内置预设（三段色标）
    const PRESETS = [
        { id: 'pinkblue',     name: '粉蓝', stops: ['#ffb6c1', '#ffffff', '#a8d8ff'] },
        { id: 'pink',         name: '粉',   stops: ['#ff9bb2', '#ffffff', '#ffdbe4'] },
        { id: 'yelloworange', name: '黄橙', stops: ['#f5c26b', '#ffffff', '#ff9a3c'] },
        { id: 'blueyellow',   name: '蓝黄', stops: ['#8ecbff', '#ffffff', '#ffe680'] },
        { id: 'bluecyan',     name: '蓝青', stops: ['#4aa8ff', '#ffffff', '#70f3ff'] },
        { id: 'blue',         name: '蓝',   stops: ['#8faecb', '#ffffff', '#d8e6f3'] },
        { id: 'cyan',         name: '青',   stops: ['#7fd8d8', '#ffffff', '#c8f0f0'] },
        { id: 'silver',       name: '银白', stops: ['#c0c8d0', '#ffffff', '#e8eef4'] },
        { id: 'purple',       name: '紫',   stops: ['#b8a9d9', '#ffffff', '#d8c8f0'] },
        { id: 'gold',         name: '金',   stops: ['#d4af37', '#fdf6e2', '#e5cf76'] },
    ];

    // 光晕：三层 drop-shadow（内亮/中/外晕），逐字跟随字色。
    // v1.1.2 起：以最高优先级（!important）写入避免被主题覆盖；半径与透明度放大到霓虹级。
    const GLOW_LAYERS = [
        { radius: 2,  alpha: 1.00 },
        { radius: 8,  alpha: 0.85 },
        { radius: 24, alpha: 0.50 },
    ];

    // ===== 颜色工具 =====
    function hexToRgb(hex) {
        let h = String(hex || '').trim().replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        const n = parseInt(h, 16);
        if (Number.isNaN(n) || h.length !== 6) return [255, 255, 255];
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(r, g, b) {
        const to = v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
        return `#${to(r)}${to(g)}${to(b)}`;
    }

    // 规范化 hex 输入，非法返回 null
    function normHex(v) {
        let h = String(v || '').trim().replace(/^#/, '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return '#' + h.toLowerCase();
    }

    // HSV 工具（取色器用），h∈[0,360) s∈[0,100] v∈[0,100]
    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        const s = max === 0 ? 0 : (d / max) * 100;
        return [h, s, max * 100];
    }

    function hsvToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        s /= 100; v /= 100;
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }

    function hexToHsv(hex) { return rgbToHsv(...hexToRgb(hex)); }
    function hsvToHex(h, s, v) { return rgbToHex(...hsvToRgb(h, s, v)); }

    // 多段渐变取色：t ∈ [0,1]，色标均匀分布
    function colorAt(stops, t) {
        const list = (stops && stops.length) ? stops : ['#ffffff'];
        if (list.length === 1) return list[0];
        const x = Math.min(1, Math.max(0, t)) * (list.length - 1);
        const i = Math.min(list.length - 2, Math.floor(x));
        const f = x - i;
        const [r1, g1, b1] = hexToRgb(list[i]);
        const [r2, g2, b2] = hexToRgb(list[i + 1]);
        return rgbToHex(r1 + (r2 - r1) * f, g1 + (g2 - g1) * f, b1 + (b2 - b1) * f);
    }

    const shadowCache = new Map();

    // 逐字三层辉光：颜色 = 该字自身的颜色，强度 0~1 同时缩放半径与透明度
    function glowShadow(hex, strength) {
        if (!(strength > 0)) return 'none';
        const s = Math.min(1, Math.max(0, Number(strength) || 0));
        const [r, g, b] = hexToRgb(hex);
        const key = `${r},${g},${b}|${Math.round(s * 100)}`;
        let v = shadowCache.get(key);
        if (!v) {
            v = GLOW_LAYERS.map(L => {
                const rr = (L.radius * (0.5 + 0.5 * s)).toFixed(2);
                const aa = (L.alpha * (0.5 + 0.5 * s)).toFixed(3);
                return `0 0 ${rr}px rgba(${r},${g},${b},${aa})`;
            }).join(', ');
            shadowCache.set(key, v);
        }
        return v;
    }

    // 流式近似样式：某一类文字在流式期间的兜底颜色（渐变取中点色，纯色取纯色）
    function approxOf(cfg) {
        if (!cfg || cfg.mode === 'theme') return null;
        if (cfg.mode === 'solid') {
            return { color: cfg.color, glow: null };
        }
        const stops = stopsOf(cfg);
        const color = colorAt(stops, 0.5);
        const strength = cfg.glow ? Math.min(1, Math.max(0, (Number(cfg.strength) || 0) / 100)) : 0;
        return { color, glow: strength > 0 ? glowShadow(color, strength) : null };
    }

    // 流式兜底：元素级渐变文字（background-clip:text），让斜体/引用在流式期间就呈现渐变
    function gradientTextCss(stops, angle) {
        const list = stopsOf({ stops });
        const a = Number.isFinite(Number(angle)) ? Number(angle) : 90;
        return `background: linear-gradient(${a}deg, ${list.join(', ')}) !important; -webkit-background-clip: text !important; background-clip: text !important; color: transparent !important; -webkit-text-fill-color: transparent !important;`;
    }

    // 流式兜底光晕：参考「雨夜回响」主题，用多层 drop-shadow 跟随渐变文字轮廓发光。
    // 三层分别取渐变起点/中点/终点色（蓝段蓝光、白段白光、黄段黄光），强度同时缩放半径与透明度。
    function streamGlowFilter(stops, strength) {
        const s = Math.min(1, Math.max(0, (Number(strength) || 0) / 100));
        if (!(s > 0)) return 'none';
        const list = stopsOf({ stops });
        const scale = 0.5 + 0.5 * s;
        const layers = [
            { r: 2,  a: 0.50, t: 0 },
            { r: 8,  a: 0.32, t: 0.5 },
            { r: 24, a: 0.20, t: 1 },
        ];
        return layers.map(L => {
            const [r, g, b] = hexToRgb(colorAt(list, L.t));
            return `drop-shadow(0 0 ${(L.r * scale).toFixed(2)}px rgba(${r},${g},${b},${(L.a * scale).toFixed(3)}))`;
        }).join(' ');
    }

    // 生成流式兜底 CSS：只命中带 data-yyx-stream 的消息中尚未逐字染色的文本；
    // 已染色 span 的 inline !important 优先于本规则，不受影响。
    // 斜体/引用在流式期间即呈现渐变与光晕（雨夜回响式 drop-shadow）；主要文本仍用中点色近似兜底。
    function buildStreamCss(s) {
        const selColor = {
            main: '#chat .mes[data-yyx-stream] .mes_text',
            italic: '#chat .mes[data-yyx-stream] .mes_text em',
            quote: '#chat .mes[data-yyx-stream] .mes_text q, #chat .mes[data-yyx-stream] .mes_text blockquote',
        };
        let css = '';
        for (const k of ['italic', 'quote']) {
            const cfg = s && s[k];
            if (!cfg || cfg.mode === 'theme') continue;
            const sel = selColor[k];
            if (cfg.mode === 'solid') {
                css += `${sel} { color: ${cfg.color || '#ffffff'} !important; text-shadow: none !important; } `;
            } else {
                const stops = stopsOf(cfg);
                const angle = Number.isFinite(Number(cfg.angle)) ? Number(cfg.angle) : 90;
                const glow = cfg.glow ? streamGlowFilter(stops, cfg.strength) : 'none';
                css += `${sel} { ${gradientTextCss(stops, angle)} text-shadow: none !important; filter: ${glow} !important; } `;
            }
        }
        const aMain = approxOf(s && s.main);
        if (aMain) {
            css += `${selColor.main} { color: ${aMain.color} !important; } `;
            if (aMain.glow) {
                css += `#chat .mes[data-yyx-stream] .mes_text * { text-shadow: ${aMain.glow} !important; }`;
            }
        }
        return css;
    }

    // 按字素拆分（避免 emoji 组合序列被拆坏）
    function graphemes(s) {
        try {
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                return [...seg.segment(s)].map(x => x.segment);
            }
        } catch { /* 降级 */ }
        return Array.from(s);
    }

    // 把一段字符按六种引号对切成渐变段：返回每字符的段号数组。
    // 每对引号（含开闭引号）为独立段，引号外文字各自成段；baseGid/startInQuote 用于跨文本节点续接，
    // 返回结束时的 gid 与 inQuote 以便后续节点继续分段。
    function quoteSegments(chars, baseGid = 0, startInQuote = false) {
        const segs = [];
        let gid = baseGid;
        let inQuote = startInQuote;
        for (const ch of chars) {
            let closedNow = false;
            if (QUOTE_TOGGLE.has(ch)) {
                if (!inQuote) { gid++; inQuote = true; }   // 开引号：新段
                else { inQuote = false; closedNow = true; } // 闭引号：字归当前段
            } else if (QUOTE_OPEN.has(ch)) {
                if (!inQuote) { gid++; inQuote = true; }   // 明确开引号
            } else if (QUOTE_CLOSE.has(ch)) {
                if (inQuote) { inQuote = false; closedNow = true; } // 明确闭引号
            }
            segs.push(gid);
            if (closedNow) gid++; // 闭引号后：后续文字新段
        }
        return { segs, gid, inQuote };
    }

    // 渐变色标：2~4 色数组，非法时兜底双白
    function stopsOf(cfg) {
        const a = Array.isArray(cfg.stops)
            ? cfg.stops.filter(x => typeof x === 'string' && x)
            : null;
        if (a && a.length >= 2) return a;
        return ['#ffffff', '#ffffff'];
    }

    // ===== 默认设置 =====
    function makeTargetDefaults() {
        return {
            mode: 'theme',        // theme | solid | gradient
            color: '#ffffff',     // 纯色
            stops: ['#ffb6c1', '#ffffff', '#a8d8ff'], // 渐变 2~4 色
            angle: 90,            // 渐变角度 0~360
            glow: false,          // 光晕开关
            strength: 30,         // 光晕强度 0~100
        };
    }

    const DEFAULT_SETTINGS = {
        enabled: true,          // 插件总开关
        main: makeTargetDefaults(),
        italic: makeTargetDefaults(),
        quote: makeTargetDefaults(),
        customPresets: [null, null, null],
    };

    // ===== 状态 =====
    let ctx = null;               // 酒馆上下文（eventSource 等）
    let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    let rev = JSON.stringify(settings); // 设置指纹：不一致时重染
    let applying = false;         // 自身 DOM 写入保护
    let streaming = false;        // 流式生成中（增量上色路径）
    let streamTimer = null;
    let paintTimer = null;
    let repaintTimer = null;
    const mutTs = new Map();      // 每条消息最近一次 DOM 变动时间（流式稳定门控）
    const STREAM_SETTLE_MS = 600; // 距上次变动不足此时长时跳过逐字精确化，交给 CSS 近似兜底
    let booted = false;
    let uiBuilt = false;
    let uiTimerId = null;
    let uiCapTimerId = null;
    let uiKey = 'main';           // 当前选中的文字类型标签
    let openPickerEl = null;      // 当前展开的取色器
    let openPickerBtn = null;
    const pendingMes = new Set();
    const observed = new WeakSet();
    const chat = { el: null, mo: null, io: null, ro: null };

    // ===== 酒馆上下文解析 =====
    async function resolveContext() {
        // 新版：全局 SillyTavern.getContext()
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function') {
                const c = SillyTavern.getContext();
                if (c && typeof c.saveSettingsDebounced === 'function') return c;
            }
        } catch { /* 继续尝试模块导入 */ }
        // 旧版：直接导入 script.js
        for (const p of ['../../../../script.js', '../../../script.js']) {
            try {
                const m = await import(p);
                if (m && typeof m.saveSettingsDebounced === 'function') return m;
            } catch { /* 尝试下一条路径 */ }
        }
        return null;
    }

    async function resolveContextWithRetry() {
        for (let i = 0; i < 40; i++) {
            const c = await resolveContext();
            if (c) return c;
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
    }

    function initSettings() {
        const store = ctx ? (ctx.extensionSettings ?? ctx.extension_settings) : null;
        if (store) {
            if (!store[MODULE] || typeof store[MODULE] !== 'object') store[MODULE] = {};
            const s = store[MODULE];
            for (const k of TARGET_KEYS) {
                const t = (s[k] && typeof s[k] === 'object') ? s[k] : {};
                const nd = makeTargetDefaults();
                // v1.0 -> v1.1 迁移：旧版 c1/mid/c3 -> 新版 stops 数组
                if (!Array.isArray(t.stops)) {
                    const arr = [];
                    if (typeof t.c1 === 'string' && t.c1) arr.push(t.c1);
                    if (typeof t.mid === 'string' && t.mid) arr.push(t.mid);
                    if (typeof t.c3 === 'string' && t.c3) arr.push(t.c3);
                    t.stops = arr.length >= 2 ? arr : nd.stops.slice();
                }
                delete t.c1; delete t.mid; delete t.c3;
                s[k] = Object.assign(nd, t);
                s[k].stops = (Array.isArray(s[k].stops) ? s[k].stops : [])
                    .filter(x => typeof x === 'string' && x)
                    .slice(0, MAX_STOPS);
                while (s[k].stops.length < MIN_STOPS) s[k].stops.push('#ffffff');
            }
            if (typeof s.enabled !== 'boolean') s.enabled = true;
            if (!Array.isArray(s.customPresets)) s.customPresets = [null, null, null];
            while (s.customPresets.length < 3) s.customPresets.push(null);
            s.customPresets = s.customPresets.slice(0, 3);
            return s;
        }
        return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }

    function saveNow() {
        try { if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced(); } catch { /* 忽略 */ }
    }

    // ===== 样式注入 =====
    function injectCss() {
        if (document.getElementById('yyyx-style')) return;
        const st = document.createElement('style');
        st.id = 'yyyx-style';
        // 不设固定字号：面板跟随酒馆字体大小；颜色全部走酒馆主题变量
        st.textContent = `
.yyx-panel { padding: 4px 2px; }
.yyx-note { font-size: .92em; opacity: .78; margin: 6px 0; line-height: 1.5; }
.yyx-tabs { display: flex; gap: 4px; margin: 4px 0 10px; padding: 3px; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); border-radius: 8px; background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.25)); }
.yyx-tab { flex: 1 1 0; padding: 6px 2px; border: none; border-radius: 6px; background: transparent; color: var(--SmartThemeBodyColor, #e6e6e6); cursor: pointer; }
.yyx-tab:hover { opacity: .85; }
.yyx-tab.yyx-on { background: var(--SmartThemeQuoteColor, rgba(120,120,120,.4)); color: #fff; }
.yyx-sec { border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.yyx-sec-title { font-weight: 600; margin: 0 0 6px; }
.yyx-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
.yyx-row[hidden], .yyx-sec[hidden] { display: none !important; }
.yyx-lbl { opacity: .88; }
.yyx-modes { display: inline-flex; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); border-radius: 6px; overflow: hidden; }
.yyx-modebtn { padding: 4px 12px; border: none; background: transparent; color: var(--SmartThemeBodyColor, #e6e6e6); cursor: pointer; }
.yyx-modebtn + .yyx-modebtn { border-left: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); }
.yyx-modebtn.yyx-on { background: var(--SmartThemeQuoteColor, rgba(120,120,120,.4)); color: #fff; }
.yyx-sw { display: inline-block; width: 1.15em; height: 1.15em; flex: none; border-radius: 4px; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); box-sizing: border-box; }
.yyx-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.yyx-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.yyx-track { position: relative; flex: none; width: 36px; height: 20px; border-radius: 10px; background: var(--SmartThemeBorderColor, rgba(255,255,255,.22)); transition: background .15s; }
.yyx-toggle input:checked + .yyx-track { background: var(--SmartThemeQuoteColor, rgba(120,120,120,.65)); }
.yyx-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.4); transition: left .15s; }
.yyx-toggle input:checked + .yyx-track .yyx-thumb { left: 18px; }
.yyx-stoprow { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
.yyx-stoprow .yyx-sw { width: 1.4em; height: 1.4em; border-radius: 5px; }
.yyx-in { flex: 1 1 70px; min-width: 56px; padding: 3px 7px; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); border-radius: 6px; background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.2)); color: var(--SmartThemeBodyColor, #e6e6e6); }
.yyx-in:focus { outline: none; border-color: var(--SmartThemeQuoteColor, rgba(255,255,255,.4)); }
.yyx-range { flex: 1 1 100px; }
.yyx-val { min-width: 2.8em; text-align: right; font-variant-numeric: tabular-nums; opacity: .9; }
.yyx-presets { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 4px; }
.yyx-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.2)); color: var(--SmartThemeBodyColor, #e6e6e6); }
.yyx-chip:hover { border-color: var(--SmartThemeQuoteColor, rgba(255,255,255,.5)); }
.yyx-slot { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
.yyx-slotname { flex: none; width: 3.4em; opacity: .88; }
.yyx-slotpreview { display: inline-flex; gap: 2px; flex: 1 1 auto; min-width: 0; align-items: center; }
.yyx-slotpreview .yyx-sw { width: .95em; height: .95em; border-radius: 3px; }
.yyx-slotempty { opacity: .55; }
.yyx-picker { border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.15)); border-radius: 8px; padding: 8px; margin: 6px 0; background: var(--SmartThemeBlurTintColor, rgba(0,0,0,.25)); }
.yyx-picker-top { display: flex; gap: 8px; }
.yyx-sv { border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); border-radius: 6px; cursor: crosshair; touch-action: none; }
.yyx-hue { position: relative; width: 18px; height: 120px; border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,.2)); cursor: ns-resize; touch-action: none; background: linear-gradient(to bottom, #ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, #00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%); }
.yyx-hue-knob { position: absolute; left: -3px; width: 22px; height: 6px; margin-top: -3px; border-radius: 3px; background: #fff; border: 1px solid rgba(0,0,0,.55); pointer-events: none; box-sizing: border-box; }
.yyx-picker-side { display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch; flex: 1 1 auto; min-width: 0; gap: 8px; }
.yyx-side-row { display: flex; align-items: center; gap: 6px; }
.yyx-side-lbl { opacity: .7; flex: none; width: 2.6em; }
.yyx-prev { width: 1.7em; height: 1.7em; border-radius: 6px; flex: none; }
.yyx-prevhex { font-variant-numeric: tabular-nums; opacity: .95; }
.yyx-side-row .yyx-in { flex: 1 1 0; min-width: 0; }
.yyx-side-row .yyx-fnum { flex: 1 1 0; min-width: 3.2em; -moz-appearance: textfield; appearance: textfield; }
.yyx-side-row .yyx-fnum::-webkit-outer-spin-button, .yyx-side-row .yyx-fnum::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.yyx-picker-actions { display: flex; justify-content: flex-end; margin-top: 2px; }
.yyx-pickbtn.yyx-active { outline: 1px solid var(--SmartThemeQuoteColor, rgba(255,255,255,.5)); }
`;
        document.head.appendChild(st);
        // 流式兜底样式表：酒馆流式期间重建 DOM 时，新文本立即获得近似色，消除「原生色→彩色」闪烁
        let sa = document.getElementById('yyx-stream-approx');
        if (!sa) {
            sa = document.createElement('style');
            sa.id = 'yyx-stream-approx';
            document.head.appendChild(sa);
        }
        sa.textContent = buildStreamCss(settings);
    }

    // 设置变化时刷新流式兜底样式
    function updateStreamCss() {
        if (typeof document === 'undefined') return; // Node 纯函数测试环境
        const sa = document.getElementById('yyx-stream-approx');
        if (sa) sa.textContent = buildStreamCss(settings);
    }

    // ===== 染色引擎 =====
    // 收集文本节点：跳过代码块、代码行内、已染色节点及额外排除的子树
    function collectText(root, extraSkip) {
        const out = [];
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
            const p = n.parentNode;
            if (!p) continue;
            if (p.closest('code, pre, [data-yyx]')) continue;
            if (extraSkip && p.closest(extraSkip)) continue;
            out.push(n);
        }
        return out;
    }

    function wrapSolidText(node, hex) {
        const sp = document.createElement('span');
        sp.className = 'yyx-sol';
        sp.setAttribute('data-yyx', 'sol');
        sp.style.setProperty('color', hex, 'important');
        sp.style.setProperty('-webkit-text-fill-color', hex, 'important');
        sp.style.setProperty('text-shadow', 'none', 'important');
        sp.textContent = node.nodeValue;
        node.parentNode.replaceChild(sp, node);
    }

    function paintGradient(el, cfg, granularity, groups, extraSkip) {
        const stops = stopsOf(cfg);
        let container = el;
        if (granularity === 'block') {
            container = el.closest('p, li, div, blockquote, h1, h2, h3, h4, h5, h6, .mes_text') || el.parentElement || el;
        }
        let key = groups.get(container);
        if (!key) { key = new Map(); groups.set(container, key); }
        let gid = 0;
        let inQuote = false; // 引号对状态（跨文本节点保持）
        const byQuote = granularity === 'sentence';
        const getList = (g) => {
            let L = key.get(g);
            if (!L) { L = { spans: [], cfg, stops }; key.set(g, L); }
            return L;
        };
        for (const n of collectText(el, extraSkip)) {
            if (!n.nodeValue.trim()) continue; // 纯空白节点无可见颜色，跳过
            const chars = graphemes(n.nodeValue || '');
            if (!chars.length) continue;
            const frag = document.createDocumentFragment();
            if (byQuote) {
                // 六种引号对分段：每对引号连同内容（含引号）为独立渐变循环；引号外文字各自成段
                const r = quoteSegments(chars, gid, inQuote);
                for (let i = 0; i < chars.length; i++) {
                    const g = r.segs[i];
                    const sp = document.createElement('span');
                    sp.className = 'yyx-ch';
                    sp.setAttribute('data-yyx', 'ch');
                    sp.setAttribute('data-g', String(g));
                    sp.textContent = chars[i];
                    frag.appendChild(sp);
                    getList(g).spans.push(sp);
                }
                gid = r.gid;
                inQuote = r.inQuote;
            } else {
                for (const ch of chars) {
                    const sp = document.createElement('span');
                    sp.className = 'yyx-ch';
                    sp.setAttribute('data-yyx', 'ch');
                    sp.setAttribute('data-g', String(gid));
                    sp.textContent = ch;
                    frag.appendChild(sp);
                    getList(gid).spans.push(sp);
                }
            }
            n.parentNode.replaceChild(frag, n);
        }
    }

    function paintTargetEl(el, cfg, groups, granularity, extraSkip) {
        if (!cfg || cfg.mode === 'theme') return;
        if (cfg.mode === 'solid') {
            for (const n of collectText(el, extraSkip)) {
                if (!n.nodeValue.trim()) continue; // 纯空白节点无可见颜色，跳过
                wrapSolidText(n, cfg.color);
            }
            return;
        }
        paintGradient(el, cfg, granularity, groups, extraSkip);
    }

    // 依据字符在容器中的真实位置沿渐变方向投影取色（角度按 CSS 约定）
    function finalizeGroups(groups) {
        for (const [container, key] of groups) {
            const crect = container.getBoundingClientRect();
            const hasBox = crect && (crect.width > 0 || crect.height > 0);
            const c0x = crect.left + crect.width / 2;
            const c0y = crect.top + crect.height / 2;
            for (const [g, item] of key) {
                const spans = item.spans;
                const n = spans.length;
                if (!n) continue;
                const cfg = item.cfg;
                const rad = ((Number(cfg.angle) || 0) * Math.PI) / 180;
                const sinA = Math.sin(rad), cosA = Math.cos(rad);
                const stops = item.stops;
                const strength = cfg.glow
                    ? Math.max(0, Math.min(1, (Number(cfg.strength) || 0) / 100))
                    : 0;
                const ts = hasBox ? new Array(n) : null;
                let tmin = Infinity, tmax = -Infinity;
                if (hasBox) {
                    for (let i = 0; i < n; i++) {
                        const r = spans[i].getBoundingClientRect();
                        const cx = r.left + r.width / 2;
                        const cy = r.top + r.height / 2;
                        const t = (cx - c0x) * sinA - (cy - c0y) * cosA;
                        ts[i] = t;
                        if (t < tmin) tmin = t;
                        if (t > tmax) tmax = t;
                    }
                }
                const span2 = tmax - tmin;
                for (let i = 0; i < n; i++) {
                    let T;
                    if (!hasBox) T = (n === 1) ? 0 : i / (n - 1);
                    else if (span2 < 1e-6) T = 0;
                    else T = Math.min(1, Math.max(0, (ts[i] - tmin) / span2));
                    const hex = colorAt(stops, T);
                    const sp = spans[i];
                    sp.style.setProperty('color', hex, 'important');
                    sp.style.setProperty('-webkit-text-fill-color', hex, 'important');
                    sp.style.setProperty('text-shadow', glowShadow(hex, strength), 'important');
                }
            }
        }
    }

    // 恢复原始文本：移除所有染色 span
    function restoreMes(mes) {
        const els = [...mes.querySelectorAll('[data-yyx]')];
        for (const el of els) {
            const kind = el.getAttribute('data-yyx');
            if (kind !== 'ch' && kind !== 'sol') continue;
            const p = el.parentNode;
            if (!p) continue;
            p.replaceChild(document.createTextNode(el.textContent), el);
        }
        delete mes.dataset.yyx;
        delete mes.dataset.yyxRev;
    }

    function markDone(mes) {
        mes.dataset.yyx = '1';
        mes.dataset.yyxRev = rev;
    }

    function applyMes(mes) {
        // 先还原自身，保证 applyMes 可安全重复调用（否则消息自身的 data-yyx 会被 closest 命中而跳过全部文本）
        restoreMes(mes);
        const mt = mes.querySelector('.mes_text');
        if (!mt) { markDone(mes); return; }
        // 总开关关闭：保持酒馆原生样式，不染色
        if (settings.enabled === false) { markDone(mes); return; }
        // 隐藏状态（无布局）不染色，等可见时再处理，避免近似色失真
        const r = mt.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
            delete mes.dataset.yyx;
            delete mes.dataset.yyxRev;
            return;
        }
        const groups = new Map();
        const s = settings;
        // 斜体优先（最内层），引用其次，主要文本最后
        for (const em of mt.querySelectorAll('em')) {
            if (em.closest('code, pre, [data-yyx]')) continue;
            paintTargetEl(em, s.italic, groups, 'block');
        }
        for (const q of mt.querySelectorAll('q, blockquote')) {
            if (q.closest('code, pre')) continue;
            paintTargetEl(q, s.quote, groups, 'sentence');
        }
        paintTargetEl(mt, s.main, groups, 'message', 'em, q, blockquote');
        finalizeGroups(groups);
        markDone(mes);
    }

    function maybeProcess(m) {
        if (!m || !m.isConnected) return;
        if (m.dataset.yyx === '1' && m.dataset.yyxRev === rev) return;
        restoreMes(m);
        applyMes(m);
    }

    // 流式生成期间增量上色：只染新增文本节点，颜色按当前字符序号近似映射，
    // 不做整条重排，避免逐 token 重染闪烁；生成结束后 repaintAll 统一按真实位置校正。
    // 稳定窗口门控：消息最近刚被酒馆重建时跳过逐字精确化（CSS 近似兜底已着色），
    // 待 DOM 稳定后再补精确渐变，避免「酒馆重建 → 原生色 → 重新 wrap」的闪烁循环。
    function paintStreamChunk(mes) {
        const mt = mes.querySelector('.mes_text');
        if (!mt) return;
        if (settings.enabled === false) return;
        mes.setAttribute('data-yyx-stream', '1'); // 先保证 CSS 近似兜底生效
        const last = mutTs.get(mes);
        if (last && Date.now() - last < STREAM_SETTLE_MS) return; // 变动太频繁，交给 CSS 近似兜底
        const nodes = [];
        const w = document.createTreeWalker(mt, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
            const p = n.parentNode;
            if (!p) continue;
            if (p.closest('code, pre')) continue;
            // 只跳过父级本身就是染色 span 的节点；消息级 data-yyx 标记不能跳过新增 token
            if (p.hasAttribute && p.hasAttribute('data-yyx')) continue;
            nodes.push(n);
        }
        if (!nodes.length) return;
        let existing = mt.querySelectorAll('.yyx-ch').length;
        for (const node of nodes) {
            if (!node.nodeValue.trim()) continue;
            const anc = node.parentNode;
            const em = anc.closest('em');
            const qq = anc.closest('q, blockquote');
            let cfg = settings.main;
            if (em) cfg = settings.italic;
            else if (qq) cfg = settings.quote;
            if (!cfg || cfg.mode === 'theme') continue;
            if (cfg.mode === 'solid') { wrapSolidText(node, cfg.color); continue; }
            const stops = stopsOf(cfg);
            const chars = graphemes(node.nodeValue || '');
            if (!chars.length) continue;
            const strength = cfg.glow ? Math.min(1, Math.max(0, (Number(cfg.strength) || 0) / 100)) : 0;
            const total = existing + chars.length;
            const frag = document.createDocumentFragment();
            for (let i = 0; i < chars.length; i++) {
                const t = total <= 1 ? 0 : (existing + i) / (total - 1);
                const hex = colorAt(stops, t);
                const sp = document.createElement('span');
                sp.className = 'yyx-ch';
                sp.setAttribute('data-yyx', 'ch');
                sp.textContent = chars[i];
                sp.style.setProperty('color', hex, 'important');
                sp.style.setProperty('-webkit-text-fill-color', hex, 'important');
                sp.style.setProperty('text-shadow', glowShadow(hex, strength), 'important');
                frag.appendChild(sp);
            }
            node.parentNode.replaceChild(frag, node);
            existing += chars.length;
        }
    }

    // 重新渲染：已染色消息 + 视口附近的未染色消息
    function repaintAll() {
        const c = chat.el;
        if (!c || !c.isConnected) return;
        applying = true;
        try {
            const vh = window.innerHeight || 900;
            for (const m of c.querySelectorAll('.mes')) {
                const processed = m.dataset.yyx === '1';
                if (!processed) {
                    const rr = m.getBoundingClientRect();
                    if (rr.width === 0 && rr.height === 0) continue;
                    if (rr.bottom < -vh || rr.top > vh * 2) continue;
                }
                restoreMes(m);
                applyMes(m);
            }
            // 精确染色完成后移除流式近似兜底标记（CSS 近似色随之失效，无原生色窗口）
            for (const el of c.querySelectorAll('[data-yyx-stream]')) el.removeAttribute('data-yyx-stream');
            mutTs.clear();
        } finally {
            applying = false;
        }
    }

    // ===== 调度 =====
    function flushPending() {
        paintTimer = null;
        const arr = [...pendingMes];
        pendingMes.clear();
        if (!arr.length) return;
        applying = true;
        try {
            for (const m of arr) {
                if (streaming) paintStreamChunk(m); // 流式期间增量上色，结束后统一校正
                else maybeProcess(m);
            }
        } finally {
            applying = false;
        }
    }

    function scheduleMes(list, delay = 250) {
        for (const m of list) pendingMes.add(m);
        if (!paintTimer) paintTimer = setTimeout(flushPending, delay);
    }

    function scheduleRepaint(ms = 300) {
        if (repaintTimer) clearTimeout(repaintTimer);
        repaintTimer = setTimeout(() => { repaintTimer = null; repaintAll(); }, ms);
    }

    function anyGradient() {
        return TARGET_KEYS.some(k => settings[k] && settings[k].mode === 'gradient');
    }

    // ===== 观察器 =====
    function isOurNode(n) {
        if (n.nodeType !== 1) return false;
        return n.classList.contains('yyx-ch') || n.classList.contains('yyx-sol');
    }

    function nodeBelongsToUs(n) {
        if (n.nodeType !== 1) return false;
        if (isOurNode(n)) return true;
        return !!(n.closest && n.closest('[data-yyx]'));
    }

    function observeMes(mes) {
        if (!chat.io || observed.has(mes)) return;
        observed.add(mes);
        chat.io.observe(mes);
    }

    function onChatMutation(muts) {
        if (applying) return;
        const targets = new Set();
        const now = Date.now();
        for (const mu of muts) {
            if (mu.type === 'characterData') {
                // 酒馆流式时可能直接改 textContent：同样会清掉染色结构，需要兜底与稳定门控
                const el = mu.target && mu.target.parentNode;
                const mes = el && el.closest ? el.closest('.mes') : null;
                if (mes) targets.add(mes);
                continue;
            }
            if (mu.type !== 'childList') continue;
            for (const n of mu.addedNodes) {
                if (nodeBelongsToUs(n)) continue;
                const rootEl = n.nodeType === 1 ? n : n.parentNode;
                const mes = rootEl && rootEl.closest ? rootEl.closest('.mes') : null;
                if (mes) targets.add(mes);
            }
        }
        if (!targets.size) return;
        for (const m of targets) {
            mutTs.set(m, now);
            if (streaming) m.setAttribute('data-yyx-stream', '1');
            observeMes(m);
        }
        scheduleMes([...targets]);
    }

    function ensureObservers() {
        const c = chat.el;
        if (!c) return;
        if (!chat.mo) {
            chat.mo = new MutationObserver(onChatMutation);
            chat.mo.observe(c, { childList: true, subtree: true });
        }
        if (!chat.io && typeof IntersectionObserver !== 'undefined') {
            chat.io = new IntersectionObserver(entries => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const m = e.target;
                    if (!m.isConnected) continue;
                    if (m.dataset.yyx === '1' && m.dataset.yyxRev === rev) continue;
                    if (applying) { scheduleMes([m]); continue; }
                    if (streaming) paintStreamChunk(m);
                    else maybeProcess(m);
                }
            }, { root: c, rootMargin: '150% 0px 150% 0px' });
            for (const m of c.querySelectorAll('.mes')) observeMes(m);
        }
        if (!chat.ro) {
            if (typeof ResizeObserver !== 'undefined') {
                chat.ro = new ResizeObserver(() => { if (anyGradient()) scheduleRepaint(300); });
                chat.ro.observe(c);
            }
            window.addEventListener('resize', () => { if (anyGradient()) scheduleRepaint(300); });
        }
    }

    // ===== 事件注册 =====
    function registerEvents() {
        const es = ctx && ctx.eventSource;
        const et = (ctx && ctx.event_types) || {};
        if (!es || typeof es.on !== 'function') return;
        const on = (name, fn) => { if (et[name]) es.on(et[name], fn); };

        on('GENERATION_STARTED', () => {
            streaming = true;
            if (streamTimer) clearTimeout(streamTimer);
            streamTimer = setTimeout(() => {
                streamTimer = null;
                if (streaming) { streaming = false; scheduleRepaint(400); }
            }, 120000); // 兜底：万一 ENDED 事件丢失
        });
        const endStream = () => {
            streaming = false;
            if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
            scheduleRepaint(50); // 尽快按真实位置精确校正；期间 CSS 近似兜底持续生效，无原生色窗口
        };
        on('GENERATION_ENDED', endStream);
        on('GENERATION_STOPPED', endStream);

        on('MESSAGE_RECEIVED', () => scheduleRepaint(600));
        on('MESSAGE_SENT', () => scheduleRepaint(600));
        on('MESSAGE_EDITED', () => scheduleRepaint(300));
        on('MESSAGE_SWIPED', () => scheduleRepaint(300));
        on('MESSAGE_DELETED', () => scheduleRepaint(300));
        on('CHAT_CHANGED', () => scheduleRepaint(500));
        on('APP_READY', () => scheduleRepaint(300));
    }

    // ===== 设置面板：取色器（参考图 2：色板 + 色相条 + Hex/RGB） =====
    function closeOpenPicker() {
        if (openPickerEl) { openPickerEl.remove(); openPickerEl = null; }
        if (openPickerBtn) { openPickerBtn.removeClass('yyx-active'); openPickerBtn = null; }
    }

    function buildPicker(currentHex, onCommit) {
        const hsv = hexToHsv(currentHex);
        const $box = $(`
        <div class="yyx-picker">
          <div class="yyx-picker-top">
            <canvas class="yyx-sv" width="176" height="120"></canvas>
            <div class="yyx-hue"><div class="yyx-hue-knob"></div></div>
            <div class="yyx-picker-side">
              <div class="yyx-side-row"><span class="yyx-sw yyx-prev"></span><span class="yyx-prevhex"></span></div>
              <div class="yyx-side-row"><span class="yyx-side-lbl">Hex</span><input type="text" class="yyx-in yyx-fhex" maxlength="7" spellcheck="false"></div>
              <div class="yyx-side-row"><span class="yyx-side-lbl">RGB</span><input type="number" class="yyx-in yyx-fnum" min="0" max="255" step="1"><input type="number" class="yyx-in yyx-fnum" min="0" max="255" step="1"><input type="number" class="yyx-in yyx-fnum" min="0" max="255" step="1"></div>
              <div class="yyx-picker-actions"><button type="button" class="menu_button yyx-picker-ok">确定</button></div>
            </div>
          </div>
        </div>`);
        const canvas = $box.find('.yyx-sv')[0];
        const ctx2d = canvas.getContext('2d');
        const $hue = $box.find('.yyx-hue');
        const $knob = $box.find('.yyx-hue-knob');
        let h = hsv[0], s = hsv[1], v = hsv[2];
        let active = false;

        function drawSV() {
            ctx2d.fillStyle = `hsl(${h}, 100%, 50%)`;
            ctx2d.fillRect(0, 0, 176, 120);
            const gx = ctx2d.createLinearGradient(0, 0, 176, 0);
            gx.addColorStop(0, '#ffffff');
            gx.addColorStop(1, 'rgba(255,255,255,0)');
            ctx2d.fillStyle = gx;
            ctx2d.fillRect(0, 0, 176, 120);
            const gy = ctx2d.createLinearGradient(0, 0, 0, 120);
            gy.addColorStop(0, 'rgba(0,0,0,0)');
            gy.addColorStop(1, '#000000');
            ctx2d.fillStyle = gy;
            ctx2d.fillRect(0, 0, 176, 120);
            const px = (s / 100) * 176;
            const py = (1 - v / 100) * 120;
            ctx2d.strokeStyle = '#ffffff';
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            ctx2d.arc(px, py, 6, 0, Math.PI * 2);
            ctx2d.stroke();
            ctx2d.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx2d.lineWidth = 1;
            ctx2d.beginPath();
            ctx2d.arc(px, py, 7.5, 0, Math.PI * 2);
            ctx2d.stroke();
        }

        function render(commit) {
            drawSV();
            $knob.css('top', `${(h / 360) * 100}%`);
            const hex = hsvToHex(h, s, v);
            $box.find('.yyx-prev').css('background', hex);
            $box.find('.yyx-prevhex').text('#' + hex.slice(1).toUpperCase());
            $box.find('.yyx-fhex').val(hex.slice(1).toUpperCase());
            const [r, g, b] = hsvToRgb(h, s, v);
            const nums = $box.find('.yyx-fnum');
            nums.eq(0).val(r); nums.eq(1).val(g); nums.eq(2).val(b);
            if (commit) onCommit(hex);
        }

        function fromSV(e) {
            const rect = canvas.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
            s = x * 100;
            v = (1 - y) * 100;
        }
        canvas.addEventListener('pointerdown', e => {
            active = true;
            try { canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            fromSV(e); render(false);
        });
        canvas.addEventListener('pointermove', e => { if (active) { fromSV(e); render(false); } });
        canvas.addEventListener('pointerup', e => { if (active) { active = false; fromSV(e); render(true); } });
        canvas.addEventListener('pointercancel', () => { active = false; });

        function fromHue(e) {
            const rect = $hue[0].getBoundingClientRect();
            const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
            h = y * 360;
            if (h >= 360) h = 359.99;
        }
        $hue[0].addEventListener('pointerdown', e => {
            active = true;
            try { $hue[0].setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
            fromHue(e); render(false);
        });
        $hue[0].addEventListener('pointermove', e => { if (active) { fromHue(e); render(false); } });
        $hue[0].addEventListener('pointerup', e => { if (active) { active = false; fromHue(e); render(true); } });
        $hue[0].addEventListener('pointercancel', () => { active = false; });

        $box.find('.yyx-fhex').on('change', function () {
            const nh = normHex(this.value);
            if (nh) {
                [h, s, v] = hexToHsv(nh);
                render(true);
            } else {
                render(false);
            }
        });
        $box.find('.yyx-fnum').on('change', function () {
            const nums = $box.find('.yyx-fnum');
            const r = Math.min(255, Math.max(0, Number(nums.eq(0).val()) || 0));
            const g = Math.min(255, Math.max(0, Number(nums.eq(1).val()) || 0));
            const b = Math.min(255, Math.max(0, Number(nums.eq(2).val()) || 0));
            [h, s, v] = rgbToHsv(r, g, b);
            render(true);
        });
        $box.find('.yyx-picker-ok').on('click', () => { closeOpenPicker(); });

        render(false);
        return $box;
    }

    // 颜色行：色块 + hex 输入 + 取色器按钮
    function buildColorRow(hex, onCommit) {
        const $row = $(`<div class="yyx-stoprow">
          <span class="yyx-sw" style="background:${hex}"></span>
          <input type="text" class="yyx-in yyx-hexbox" maxlength="7" spellcheck="false" value="${hex.toUpperCase()}">
          <button type="button" class="menu_button yyx-pickbtn" title="打开取色器"><i class="fa-solid fa-palette"></i></button>
        </div>`);
        let cur = hex;
        function setHex(v) {
            cur = v;
            $row.find('.yyx-sw').css('background', v);
            $row.find('.yyx-hexbox').val(v.toUpperCase());
        }
        $row.find('.yyx-hexbox').on('change', function () {
            const nh = normHex(this.value);
            if (nh) { setHex(nh); onCommit(nh); } else { $(this).val(cur.toUpperCase()); }
        });
        $row.find('.yyx-pickbtn').on('click', function () {
            const $btn = $(this);
            if (openPickerBtn && openPickerBtn.is($btn)) { closeOpenPicker(); return; }
            closeOpenPicker();
            const $pk = buildPicker(cur, nh => { setHex(nh); onCommit(nh); });
            $row.after($pk);
            openPickerEl = $pk;
            openPickerBtn = $btn;
            $btn.addClass('yyx-active');
        });
        return $row;
    }

    // ===== 设置面板：文字类型配置区 =====
    function renderTargetArea() {
        closeOpenPicker();
        const key = uiKey;
        const t = settings[key];
        const $body = $('#yyx-tab-body').empty();

        // 配色模式
        const $modes = $(`<div class="yyx-row"><label class="yyx-lbl">配色模式</label><span class="yyx-modes"></span></div>`);
        for (const [m, name] of [['theme', '跟随主题'], ['solid', '纯色'], ['gradient', '渐变']]) {
            const $b = $(`<button type="button" class="yyx-modebtn${t.mode === m ? ' yyx-on' : ''}" data-m="${m}">${name}</button>`);
            $b.on('click', () => { settings[key].mode = m; renderTargetArea(); onChange(); });
            $modes.find('.yyx-modes').append($b);
        }
        $body.append($modes);

        if (t.mode === 'theme') {
            $body.append(`<div class="yyx-note">当前跟随酒馆主题，不做任何处理。</div>`);
        } else if (t.mode === 'solid') {
            const $sec = $(`<div class="yyx-sec"><div class="yyx-sec-title">纯色</div></div>`);
            $sec.append(buildColorRow(t.color, nh => { settings[key].color = nh; onChange(); }));
            $body.append($sec);
        } else {
            const $sec = $(`<div class="yyx-sec">
              <div class="yyx-sec-title">渐变颜色（2-4 色）</div>
              <div class="yyx-stops"></div>
            </div>`);
            t.stops.forEach((stop, i) => {
                const $row = buildColorRow(stop, nh => {
                    settings[key].stops[i] = nh;
                    onChange();
                });
                if (t.stops.length > MIN_STOPS) {
                    const $del = $(`<button type="button" class="menu_button" title="移除该颜色"><i class="fa-solid fa-minus"></i></button>`);
                    $del.on('click', () => {
                        settings[key].stops.splice(i, 1);
                        renderTargetArea();
                        onChange();
                    });
                    $row.append($del);
                }
                $sec.find('.yyx-stops').append($row);
            });
            if (t.stops.length < MAX_STOPS) {
                const $add = $(`<button type="button" class="menu_button yyx-add"><i class="fa-solid fa-plus"></i> 添加颜色</button>`);
                $add.on('click', () => {
                    const a = t.stops[t.stops.length - 2] || t.stops[0];
                    const b = t.stops[t.stops.length - 1];
                    settings[key].stops.splice(t.stops.length - 1, 0, colorAt([a, b], 0.5));
                    renderTargetArea();
                    onChange();
                });
                $sec.append($add);
            }

            const $ang = $(`<div class="yyx-row"><label class="yyx-lbl">渐变角度</label>
              <input type="range" class="yyx-range" min="0" max="360" step="1" value="${t.angle}">
              <span class="yyx-val">${t.angle}°</span></div>`);
            $ang.find('input').on('input', function () {
                settings[key].angle = Number(this.value);
                $ang.find('.yyx-val').text(this.value + '°');
                onChange();
            });
            $sec.append($ang);

            const $glow = $(`<div class="yyx-row"><label class="yyx-toggle"><input type="checkbox" ${t.glow ? 'checked' : ''}><span class="yyx-track"><span class="yyx-thumb"></span></span><span class="yyx-lbl">霓虹光晕</span></label></div>`);
            $glow.find('input').on('change', function () {
                settings[key].glow = !!this.checked;
                renderTargetArea();
                onChange();
            });
            $sec.append($glow);

            if (t.glow) {
                const $str = $(`<div class="yyx-row"><label class="yyx-lbl">光晕强度</label>
                  <input type="range" class="yyx-range" min="0" max="100" step="1" value="${t.strength}">
                  <span class="yyx-val">${t.strength}%</span></div>`);
                $str.find('input').on('input', function () {
                    settings[key].strength = Number(this.value);
                    $str.find('.yyx-val').text(this.value + '%');
                    onChange();
                });
                $sec.append($str);
            }
            $body.append($sec);
        }
    }

    function refreshTabs() {
        const $tabs = $('#yyx-tabs');
        if (!$tabs.length) return;
        $tabs.find('.yyx-tab').each(function () {
            $(this).toggleClass('yyx-on', this.dataset.k === uiKey);
        });
        renderTargetArea();
    }

    function renderCustomSlots() {
        const $box = $('#yyx-custom-slots');
        if (!$box.length) return;
        $box.empty();
        const cps = settings.customPresets || [];
        for (let i = 0; i < 3; i++) {
            const entry = cps[i] || null;
            const $row = $(`<div class="yyx-slot">
              <span class="yyx-slotname">预设${i + 1}</span>
              <span class="yyx-slotpreview"></span>
              <button type="button" class="menu_button yyx-use"${entry ? '' : ' disabled'}>使用</button>
              <button type="button" class="menu_button yyx-save">存入</button>
            </div>`);
            if (entry && Array.isArray(entry.stops) && entry.stops.length >= 2) {
                for (const c of entry.stops.slice(0, MAX_STOPS)) {
                    $row.find('.yyx-slotpreview').append(`<span class="yyx-sw" style="background:${c}"></span>`);
                }
            } else {
                $row.find('.yyx-slotpreview').append(`<span class="yyx-slotempty">空</span>`);
            }
            $row.find('.yyx-use').on('click', () => { if (entry) applyGradientStyle(entry); });
            $row.find('.yyx-save').on('click', () => {
                const t = settings[uiKey];
                settings.customPresets[i] = {
                    stops: t.stops.slice(),
                    angle: t.angle,
                    glow: t.glow,
                    strength: t.strength,
                };
                saveNow();
                renderCustomSlots();
            });
            $box.append($row);
        }
    }

    // 应用一整套渐变风格：斜体与引用应用渐变，主要文本改为跟随主题
    function applyGradientStyle(entry) {
        const stops = (Array.isArray(entry.stops) && entry.stops.length >= 2)
            ? entry.stops.slice(0, MAX_STOPS)
            : ['#ffffff', '#ffffff'];
        const angle = Number.isFinite(entry.angle) ? entry.angle : 90;
        const glow = !!entry.glow;
        const strength = Number.isFinite(entry.strength) ? entry.strength : 30;
        for (const k of ['italic', 'quote']) {
            settings[k].mode = 'gradient';
            settings[k].stops = stops.slice();
            settings[k].angle = angle;
            settings[k].glow = glow;
            settings[k].strength = strength;
        }
        settings.main.mode = 'theme';
        refreshAllUI();
        onChange();
    }

    function resetAll() {
        closeOpenPicker();
        const keep = Array.isArray(settings.customPresets) ? settings.customPresets : [null, null, null];
        const keepEnabled = settings.enabled !== false;
        settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        settings.customPresets = keep;
        settings.enabled = keepEnabled;
        const store = ctx ? (ctx.extensionSettings ?? ctx.extension_settings) : null;
        if (store) store[MODULE] = settings;
        refreshAllUI();
        onChange();
    }

    function onChange() {
        saveNow();
        rev = JSON.stringify(settings);
        updateStreamCss();
        scheduleRepaint(250);
    }

    function refreshAllUI() {
        if (typeof $ === 'undefined') return; // Node 测试环境无 jQuery
        refreshTabs();
        renderCustomSlots();
    }

    function buildPanel($root) {
        const $panel = $(`
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>聊天文字调色</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content yyx-panel">
            <div class="yyx-row"><label class="yyx-toggle"><input type="checkbox" class="yyx-enable" ${settings.enabled !== false ? 'checked' : ''}><span class="yyx-track"><span class="yyx-thumb"></span></span><span class="yyx-lbl">启用聊天文字调色（总开关）</span></label></div>
            <div class="yyx-tabs" id="yyx-tabs"></div>
            <div id="yyx-tab-body"></div>
            <div class="yyx-sec">
              <div class="yyx-sec-title">内置预设</div>
              <div class="yyx-presets" id="yyx-presets"></div>
            </div>
            <div class="yyx-sec">
              <div class="yyx-sec-title">自定义预设（3 套，可保存）</div>
              <div id="yyx-custom-slots"></div>
            </div>
            <div class="yyx-row">
              <button type="button" class="menu_button yyx-reset">全部恢复跟随主题</button>
              <button type="button" class="menu_button yyx-repaint">重新渲染可见消息</button>
            </div>
          </div>
        </div>`);
        $root.append($panel);

        // 插件总开关
        $panel.find('.yyx-enable').on('change', function () {
            settings.enabled = !!this.checked;
            onChange();
        });

        // 顶部横排文字类型标签
        const $tabs = $panel.find('#yyx-tabs');
        for (const k of TARGET_KEYS) {
            const $b = $(`<button type="button" class="yyx-tab" data-k="${k}">${TARGET_LABELS[k]}</button>`);
            $b.on('click', () => { uiKey = k; refreshTabs(); });
            $tabs.append($b);
        }

        // 内置预设
        const $pres = $panel.find('#yyx-presets');
        for (const p of PRESETS) {
            const grad = `linear-gradient(90deg, ${p.stops.join(', ')})`;
            const $btn = $(`<button type="button" class="yyx-chip" title="应用「${p.name}」配色"><span class="yyx-sw" style="background:${grad}"></span><span>${p.name}</span></button>`);
            $btn.on('click', () => applyGradientStyle({ stops: p.stops, angle: 90, glow: true, strength: 50 }));
            $pres.append($btn);
        }

        $panel.find('.yyx-reset').on('click', resetAll);
        $panel.find('.yyx-repaint').on('click', () => repaintAll());
        refreshAllUI();
    }

    function ensureSettingsUI() {
        if (uiBuilt) return;
        const target = document.querySelector('#extensions_settings2, #extensions_settings');
        if (!target) return;
        uiBuilt = true;
        try { buildPanel($(target)); } catch (e) { console.warn(TAG, '设置面板构建失败', e); }
    }

    // ===== 启动 =====
    function initChatHooks() {
        let tries = 0;
        const t = setInterval(() => {
            const c = document.getElementById('chat');
            if (c) {
                clearInterval(t);
                chat.el = c;
                ensureObservers();
                scheduleRepaint(400);
                return;
            }
            if (++tries > 200) clearInterval(t);
        }, 300);
    }

    async function boot() {
        if (booted) return;
        booted = true;
        ctx = await resolveContextWithRetry();
        if (!ctx) {
            console.warn(TAG, '未检测到酒馆运行环境，插件不生效。');
            return;
        }
        settings = initSettings();
        rev = JSON.stringify(settings);
        injectCss();
        registerEvents();
        console.log(`${TAG} v${VERSION} 已加载`);
        initChatHooks();
        uiTimerId = setInterval(() => {
            if (uiBuilt) { clearInterval(uiTimerId); uiTimerId = null; return; }
            ensureSettingsUI();
        }, 500);
        uiCapTimerId = setTimeout(() => {
            if (uiTimerId) { clearInterval(uiTimerId); uiTimerId = null; }
            uiCapTimerId = null;
        }, 10 * 60 * 1000);
    }

    // ===== Node 测试接口（浏览器中不存在 module，此块不生效） =====
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            VERSION, MODULE, TARGET_KEYS, TARGET_LABELS, PRESETS, SENTENCE_END,
            colorAt, glowShadow, graphemes, stopsOf, quoteSegments, approxOf, buildStreamCss,
            gradientTextCss, streamGlowFilter,
            hexToRgb, rgbToHex, normHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex,
            collectText, applyMes, restoreMes, finalizeGroups, applyGradientStyle, paintStreamChunk,
            _setSettingsForTest: (s) => { settings = s; rev = JSON.stringify(settings); },
            _getSettingsForTest: () => settings,
            _setMutTsForTest: (mes, ts) => { if (ts == null) mutTs.delete(mes); else mutTs.set(mes, ts); },
            _stopTimers: () => {
                if (uiTimerId) { clearInterval(uiTimerId); uiTimerId = null; }
                if (uiCapTimerId) { clearTimeout(uiCapTimerId); uiCapTimerId = null; }
                if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
                if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
                if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
            },
        };
    }

    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    if (typeof jQuery !== 'undefined') {
        jQuery(boot);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
