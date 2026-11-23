/*!
 * 聊天文字调色 v1.1.20
 * SillyTavern UI 扩展
 *
 * 功能：
 * 1. 改色仅作用于酒馆聊天消息（#chat .mes），不影响任何其他界面。
 * 2. 主要文本 / 斜体文本 / 引用文本可分别调色：
 *    - 跟随酒馆主题（不做任何处理）
 *    - 纯色（可自定义颜色）
 *    - 渐变（自定义 2~4 个颜色，可调整渐变角度 0~360°）
 *      渐变带霓虹光晕开关与强度调节（逐字同色 text-shadow，蓝段蓝光、黄段黄光）
 * 3. 渐变粒度：主要文本 = 整条消息；斜体 = 每对 *xxx*（em）独立循环；引用 = 每个引号内对话独立循环（引号外叙述保持酒馆原色）。
 * 4. 内置 10 套配色预设 + 3 套可保存的自定义预设。
 * 5. 设置面板跟随酒馆主题与字体大小，顶部横排文字类型标签切换。
 *
 * 性能设计：
 * - 逐字染色按需触发（设置变化 / 生成结束 / 进入视口），每字同色 text-shadow 不创建合成层；
 *   流式期间以元素级渐变（background-clip:text）完整兜底（含渐变与光晕），
 *   生成结束后自动逐字精确校正为每字同色光晕；外部改动消息 DOM 时自动重新染色。
 */
(() => {
    'use strict';

    // ===== 基础常量 =====
    const MODULE = 'yyyx_chat_color';
    const VERSION = '1.1.20';
    const TAG = '[聊天文字调色]';
    const TARGET_KEYS = ['main', 'italic', 'quote'];
    const TARGET_LABELS = { main: '主要文本', italic: '斜体文本', quote: '引用文本' };
    const MAX_STOPS = 4;
    const MIN_STOPS = 2;

    // 句子结束符：备用（保留供 sentenceSegments 使用）。
    const SENTENCE_END = /[。！？!?…\n]/;

    // 引用渐变口径：只染「引号内的对话」，每对引号是一个完整渐变循环；引号外的叙述文字保持酒馆原色。
    // 配对引号（开/闭不同字符）与同字符 toggle 引号（英文直双引号）都支持。
    const QUOTE_PAIRS = [
        ['\u201C', '\u201D'], // “ ”
        ['\u300C', '\u300D'], // 「 」
        ['\u300E', '\u300F'], // 『 』
        ['\u00AB', '\u00BB'], // « »
        ['\uFF02', '\uFF02'], // ＂ ＂（同字符 toggle）
        ['\u0022', '\u0022'], // " "（同字符 toggle）
    ];
    const QUOTE_OPEN = new Set();
    const QUOTE_CLOSE = new Set();
    const QUOTE_TOGGLE = new Set();
    for (const [o, c] of QUOTE_PAIRS) {
        QUOTE_OPEN.add(o);
        QUOTE_CLOSE.add(c);
        if (o === c) QUOTE_TOGGLE.add(o);
    }
    // 开引号 -> 对应闭引号
    const QUOTE_CLOSER = new Map();
    for (const [o, c] of QUOTE_PAIRS) QUOTE_CLOSER.set(o, c);

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

    // 光晕：每字同色三层 text-shadow（贴字亮边/中层/外晕），颜色 = 该字在渐变中的颜色。
    // v1.1.14 起：运行时主路径回到逐字引擎——每个字单独发光、光晕色跟随该字，不再用元素级一刀切 drop-shadow。
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
                const rr = (L.radius * s).toFixed(2);
                const aa = (L.alpha * s).toFixed(3);
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

    // 光晕：两层 drop-shadow 霓虹发光——内层取渐变首色（贴字亮边）、外层取渐变尾色（大范围扩散晕）。
    // 半径/透明度随强度线性缩放，100% 时为强霓虹档（内层首色 3px/0.60、外层尾色 10px/0.45），
    // 明显强于「雨夜回响」名字光晕（3px/0.45、8px/0.25），保证暗色尾色下光晕也清晰可见。
    function glowFilter(stops, strength) {
        const s = Math.min(1, Math.max(0, (Number(strength) || 0) / 100));
        if (!(s > 0)) return 'none';
        const list = stopsOf({ stops });
        const first = hexToRgb(list[0]);
        const last = hexToRgb(list[list.length - 1]);
        return [
            `drop-shadow(0 0 ${(3 * s).toFixed(2)}px rgba(${first[0]},${first[1]},${first[2]},${(0.60 * s).toFixed(3)}))`,
            `drop-shadow(0 0 ${(10 * s).toFixed(2)}px rgba(${last[0]},${last[1]},${last[2]},${(0.45 * s).toFixed(3)}))`,
        ].join(' ');
    }

    // 流式兜底声明：流式期间用「元素级渐变 + 彩色两层 drop-shadow」近似呈现，
    // 光晕取渐变首色（内层）/ 尾色（外层），与生成结束后的最终渲染同一套发光，
    // 避免白色中点 text-shadow 在短行斜体上铺成白雾、把渐变冲淡；
    // 生成结束后由逐字引擎 paintStreamChunk / repaintAll 精确校正为每字同色光晕。
    function streamDecl(cfg) {
        if (!cfg || cfg.mode === 'theme') return '';
        const strength100 = cfg.glow ? Math.min(100, Math.max(0, Number(cfg.strength) || 0)) : 0;
        const strength = strength100 / 100;
        if (cfg.mode === 'solid') {
            let d = `color:${cfg.color}!important;-webkit-text-fill-color:${cfg.color}!important;background:none!important;`;
            d += strength > 0 ? `text-shadow:${glowShadow(cfg.color, strength)}!important;` : `text-shadow:none!important;`;
            return d;
        }
        const stops = stopsOf(cfg);
        const angle = Number.isFinite(Number(cfg.angle)) ? Number(cfg.angle) : 90;
        const glow = strength100 > 0 ? glowFilter(stops, strength100) : 'none';
        let d = `background:linear-gradient(${angle}deg,${stops.join(',')})!important;-webkit-background-clip:text!important;background-clip:text!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;filter:${glow}!important;`;
        return d;
    }

    // 生成流式兜底 CSS：流式期间让「尚未逐字染色的消息」立即呈现完整渐变 + 光晕。
    // 双轨命中：
    //  A. data-yyx-stream 逐消息标记（兼容旧路径）；
    //  B. #chat.yyx-streaming——流式开始时给 #chat 加类，整页消息立刻命中元素级兜底。
    //     不再用 :not([data-yyx="1"]) 排除：消息刚被酒馆重建的瞬间旧完成标记尚未被观察器清除，
    //     若排除已处理消息会留下「主题色 → 渐变」的空窗造成闪烁；流式期间本就不跑逐字校正，
    //     已染色消息的逐字 span 内联 important 样式优先于本样式表，不会被兜底覆盖。
    // DOM 稳定后再精确逐字校正。
    function buildStreamCss(s) {
        const rows = [
            ['main', '#chat .mes[data-yyx-stream] .mes_text', '#chat.yyx-streaming .mes .mes_text'],
            ['italic', '#chat .mes[data-yyx-stream] .mes_text em, #chat .mes[data-yyx-stream] .mes_text i', '#chat.yyx-streaming .mes .mes_text em, #chat.yyx-streaming .mes .mes_text i'],
            ['quote', '#chat .mes[data-yyx-stream] .mes_text q, #chat .mes[data-yyx-stream] .mes_text blockquote', '#chat.yyx-streaming .mes .mes_text q, #chat.yyx-streaming .mes .mes_text blockquote'],
        ];
        let css = '';
        for (const [k, selA, selB] of rows) {
            const d = streamDecl(s && s[k]);
            if (d) css += `${selA}{${d}}${selB}{${d}}`;
        }
        return css;
    }

    // 某类文字的 CSS 声明（theme 返回空字符串）：
    // 渐变走元素级 background-clip:text + 多层 drop-shadow（复刻「雨夜回响」），
    // 不再使用逐字 span + text-shadow。方向由 CSS 的 linear-gradient 角度保证，中间色自然铺开。
    function targetDecl(cfg) {
        if (!cfg || cfg.mode === 'theme') return '';
        if (cfg.mode === 'solid') {
            const c = cfg.color || '#ffffff';
            return `color:${c}!important;-webkit-text-fill-color:${c}!important;background:none!important;text-shadow:none!important;filter:none!important;`;
        }
        const stops = stopsOf(cfg);
        const angle = Number.isFinite(Number(cfg.angle)) ? Number(cfg.angle) : 90;
        const glow = cfg.glow ? glowFilter(stops, cfg.strength) : 'none';
        return `background:linear-gradient(${angle}deg,${stops.join(',')})!important;-webkit-background-clip:text!important;background-clip:text!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;filter:${glow}!important;`;
    }

    // 生成完整动态配色 CSS：主要文本整条渐变，斜体按 em 段、引用按 q/blockquote 段渐变。
    // 斜体与引用选择器特异性更高，自然覆盖主要文本；后声明者优先（斜体 > 引用 > 主要文本）。
    function buildColorCss(s) {
        const sel = {
            main: '#chat .mes .mes_text',
            italic: '#chat .mes .mes_text em, #chat .mes .mes_text i',
            quote: '#chat .mes .mes_text q, #chat .mes .mes_text blockquote',
        };
        let css = '';
        for (const k of ['main', 'quote', 'italic']) {
            const d = targetDecl(s && s[k]);
            if (d) css += `${sel[k]}{${d}}`;
        }
        // 行内元素（q / em）为 drop-shadow 光晕留出渲染空间：左右各 3px 内边距，
        // 复刻「雨夜回响」.mes_text q 的 padding:0 3px，避免行末/行首字符被 filter 渲染层裁切。
        const qc = s && s.quote, ic = s && s.italic;
        if (qc && qc.mode === 'gradient' && qc.glow) {
            css += `#chat .mes .mes_text q{padding:0 3px!important}`;
        }
        if (ic && ic.mode === 'gradient' && ic.glow) {
            css += `#chat .mes .mes_text em, #chat .mes .mes_text i{padding:0 3px!important}`;
        }
        return css;
    }

    // 清除历史逐字染色 span，交给动态 CSS 接管（雨夜回响式）
    function clearAllSpans() {
        if (typeof document === 'undefined') return;
        const els = [...document.querySelectorAll('#chat .mes [data-yyx]')];
        for (const el of els) {
            const kind = el.getAttribute('data-yyx');
            if (kind !== 'ch' && kind !== 'sol') continue;
            const p = el.parentNode;
            if (p) p.replaceChild(document.createTextNode(el.textContent), el);
        }
        for (const m of document.querySelectorAll('#chat .mes')) {
            delete m.dataset.yyx;
            delete m.dataset.yyxRev;
            delete m.dataset.yyxStream;
        }
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

    // 把一段字符按句子结束符切成渐变段：返回每字符的段号数组与结束段号。
    // 每个句子（含结束符）为独立渐变循环，句子内按字符顺序首色→尾色线性取色。
    function sentenceSegments(chars, baseGid = 0) {
        const segs = [];
        let gid = baseGid;
        for (const ch of chars) {
            segs.push(gid);
            if (SENTENCE_END.test(ch)) gid++;
        }
        return { segs, gid };
    }

    // 引用渐变按「引号对」分段：返回每字符所属组号（segs[i]），引号外的叙述字符为 null（不染色）。
    // 每对引号（含开闭引号本身）是一个完整渐变循环，组内按字符顺序首色→尾色线性取色。
    function quoteSegments(chars, baseGid = 0, state = null) {
        const segs = new Array(chars.length).fill(null);
        let gid = baseGid;   // 下一个新组的 id
        let inQuote = state ? state.inQuote : false;
        let closer = state ? state.closer : null;
        let cur = state ? state.cur : null;      // 当前活跃引号组的 id
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            if (inQuote) {
                segs[i] = cur;
                if (ch === closer) {
                    inQuote = false;
                    closer = null;
                    cur = null;
                }
                continue;
            }
            // 叙述态：遇到开引号或 toggle 引号则进入新引号组（立即分配新 id）
            if (QUOTE_TOGGLE.has(ch)) {
                inQuote = true;
                closer = ch;
                cur = gid++;
                segs[i] = cur;
            } else if (QUOTE_OPEN.has(ch)) {
                inQuote = true;
                closer = QUOTE_CLOSER.get(ch) || ch;
                cur = gid++;
                segs[i] = cur;
            }
            // 其余叙述字符保持 null，不染色
        }
        return { segs, gid, state: { inQuote, closer, cur } };
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
            strength: 100,        // 光晕强度 0~100（100 = 原始霓虹参数）
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
    let colorCssTimer = null;    // 配色 CSS 重载防抖计时器（消息 DOM 重建后兜底）
    let booted = false;
    let uiBuilt = false;
    let uiTimerId = null;
    let uiCapTimerId = null;
    let uiKey = 'main';           // 当前选中的文字类型标签
    let openPickerEl = null;      // 当前展开的取色器
    let openPickerBtn = null;
    const pendingMes = new Set();
    const observed = new WeakSet();
    const chat = { el: null, mo: null, io: null, ro: null, cssMo: null };

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
