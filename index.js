/*!
 * 聊天文字调色 v1.2.7
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
 *   流式期间「锁定」为元素级渐变（background-clip:text）+ text-shadow 光晕这一种呈现，
 *   期间任何渲染路径都不升级成逐字 span（避免「兜底 ↔ 逐字」来回切造成闪烁）；
 *   生成结束后统一解锁并做唯一一次逐字精确重建；外部改动消息 DOM 时自动重新染色。
 */
(() => {
    'use strict';

    // ===== 基础常量 =====
    const MODULE = 'yyyx_chat_color';
    const VERSION = '1.2.9';
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
    // 只发光一层/两层的轻量档：观感接近三层，但每个字少 1~2 次模糊光栅化。
    // 手机上长消息（几千个发光字）会累积成很大的光栅化工作量，是"文字越长越闪"的可疑来源，
    // 所以提供可切换的渲染档位，让真机可以直接验证是不是光晕成本导致的。
    const GLOW_PRESETS = {
        layer3: GLOW_LAYERS,
        layer2: [{ radius: 2, alpha: 1.00 }, { radius: 10, alpha: 0.72 }],
        layer1: [{ radius: 6, alpha: 0.85 }],
    };

    // ===== 渐变可视终点（对齐「雨夜回响」主题的观感）=====
    // 主题里 q / 名字 / 顶栏都是把 linear-gradient 铺在元素整个盒子宽度上，而文字只占盒子左侧
    // 大约八成，所以真实渲染中文字永远读不到满值的尾色（粉蓝的 #a8d8ff），只呈现
    // 「首色 → 白 → 极淡的冷白」。插件过去把一整个渐变循环压在文字的实际宽度上，
    // 末字必然打到满值尾色，于是同一组色标看起来明显更蓝、更艳（用户反馈「蓝色太蓝」）。
    // 现在逐字取色同样只走完色标的前 STOP_REACH 段：尾字落在中途色，而不是满值尾色。
    const STOP_REACH = 0.8;

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

    // 强度 0~1 → 光晕半径/透明度缓动系数。
    // 低段（拖弱光时）衰减放缓：半径走幂曲线保留扩散范围，透明度叠加下限保留可见辉光，
    // 避免「稍微调低就完全看不见光晕」；满档 s=1 与无光 s=0 口径保持不变。
    function glowEase(s) {
        return {
            r: Math.pow(s, 0.5),           // 半径：平方根曲线，低段衰减更慢，保留扩散范围
            a: 0.38 + 0.62 * s,            // 透明度：低段保留 38% 基准辉光，避免深背景下被吞掉
        };
    }

    // 逐字辉光：颜色 = 该字自身的颜色，强度 0~1 同时缩放半径与透明度
    // mode: layer3（默认，三层）/ layer2 / layer1，由设置里的「光晕渲染」决定
    function glowShadow(hex, strength, mode) {
        if (!(strength > 0)) return 'none';
        const s = Math.min(1, Math.max(0, Number(strength) || 0));
        const m = GLOW_PRESETS[mode] ? mode : (GLOW_PRESETS[glowMode] ? glowMode : 'layer3');
        const layers = GLOW_PRESETS[m];
        const [r, g, b] = hexToRgb(hex);
        const key = `${r},${g},${b}|${Math.round(s * 100)}|${m}`;
        let v = shadowCache.get(key);
        if (!v) {
            const ease = glowEase(s);
            v = layers.map(L => {
                const rr = (L.radius * ease.r).toFixed(2);
                const aa = (L.alpha * ease.a).toFixed(3);
                return `0 0 ${rr}px rgba(${r},${g},${b},${aa})`;
            }).join(', ');
            shadowCache.set(key, v);
        }
        return v;
    }
    let glowMode = 'layer3';   // 运行时生效的光晕渲染档（来自 settings.glowMode）

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
    // 半径/透明度随强度经缓动缩放（低段保可见下限），100% 时为强霓虹档（内层首色 3px/0.60、外层尾色 10px/0.45），
    // 明显强于「雨夜回响」名字光晕（3px/0.45、8px/0.25），保证暗色尾色下光晕也清晰可见。
    function glowFilter(stops, strength) {
        const s = Math.min(1, Math.max(0, (Number(strength) || 0) / 100));
        if (!(s > 0)) return 'none';
        const list = stopsOf({ stops });
        const first = hexToRgb(list[0]);
        const last = hexToRgb(list[list.length - 1]);
        const ease = glowEase(s);
        return [
            `drop-shadow(0 0 ${(3 * ease.r).toFixed(2)}px rgba(${first[0]},${first[1]},${first[2]},${(0.60 * ease.a).toFixed(3)}))`,
            `drop-shadow(0 0 ${(10 * ease.r).toFixed(2)}px rgba(${last[0]},${last[1]},${last[2]},${(0.45 * ease.a).toFixed(3)}))`,
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
        // v1.2.5：元素级兜底改用「text-shadow」发光，而不是 filter:drop-shadow。
        // 真机证据表明手机端元素级 filter 完全不出光，而 span 上的 text-shadow 正常发光，
        // 所以兜底也必须用 text-shadow，否则「重新染色这几百毫秒」就是一段没有光晕的黑洞，
        // 长消息每次重建要 200~400ms，正好呈现为持续的一亮一暗。
        const shadow = strength100 > 0 ? glowShadow(stops[0], strength) : 'none';
        let d = `background:linear-gradient(${angle}deg,${stops.join(',')})!important;-webkit-background-clip:text!important;background-clip:text!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:${shadow}!important;filter:none!important;`;
        return d;
    }

    // 生成流式兜底 CSS：只给「还没逐字染色的那一瞬」用，一旦消息被逐字染上就立刻让位。
    // 现在流式期间也走逐字染色（paintStreamChunk），这个兜底只是从「消息刚出现」到
    // 「首次逐字命中（毫秒级）」之间的过渡，且被 :not([data-yyx="1"]) 严格互斥，
    // 不会再和逐字 span 抢同一帧，因此不会出现「有光/无光」交替。
    function buildStreamCss(s) {
        const A = '#chat .mes:not([data-yyx="1"])[data-yyx-stream] .mes_text';
        const B = '#chat.yyx-streaming .mes:not([data-yyx="1"]) .mes_text';
        const rows = [
            ['main', `${A}`, `${B}`],
            ['italic', `${A} em, ${A} i`, `${B} em, ${B} i`],
            ['quote', `${A} q, ${A} blockquote`, `${B} q, ${B} blockquote`],
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
        // 同样改用 text-shadow（手机端 filter 不出光），兜底与逐字染色都用同一种发光机制。
        // 颜色取色标首色而不是中点色：粉蓝这类「中间是白」的配色若用中点色发光，
        // 会在暗底上糊成一片白雾，把渐变冲淡（这也是之前「流式偏灰白」的来源）。
        const strength = cfg.glow ? Math.min(1, Math.max(0, (Number(cfg.strength) || 0) / 100)) : 0;
        const shadow = strength > 0 ? glowShadow(stops[0], strength) : 'none';
        return `background:linear-gradient(${angle}deg,${stops.join(',')})!important;-webkit-background-clip:text!important;background-clip:text!important;color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:${shadow}!important;filter:none!important;`;
    }

    // 生成完整动态配色 CSS，只作用于「还没逐字染色」的消息（:not([data-yyx="1"])）。
    // 一旦消息被逐字染过，颜色与光晕就全部由每个 span 自己承担，元素级渐变/filter 一律让位，
    // 避免两套发光机制在同一条消息上反复抢占（这是「一闪一闪」「调强度就掉光」的根源）。
    function buildColorCss(s) {
        const NEUTRAL = `[data-yyx="1"]`;
        const sel = {
            main: `#chat .mes:not(${NEUTRAL}) .mes_text`,
            italic: `#chat .mes:not(${NEUTRAL}) .mes_text em, #chat .mes:not(${NEUTRAL}) .mes_text i`,
            quote: `#chat .mes:not(${NEUTRAL}) .mes_text q, #chat .mes:not(${NEUTRAL}) .mes_text blockquote`,
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
        // 已逐字染色的消息：元素本身必须回到中性，否则祖先的 background-clip:text
        // 会把子 span 的 text-shadow 一起裁掉（手机端表现为「有字无色光」）。
        css += `#chat .mes[data-yyx="1"] .mes_text, #chat .mes[data-yyx="1"] .mes_text em, #chat .mes[data-yyx="1"] .mes_text i, #chat .mes[data-yyx="1"] .mes_text q, #chat .mes[data-yyx="1"] .mes_text blockquote{background:none!important;-webkit-background-clip:border-box!important;background-clip:border-box!important;-webkit-text-fill-color:currentColor!important;text-shadow:none!important;filter:none!important;color:inherit!important;}`;
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
        glowMode: 'layer3',     // 光晕渲染档：layer3 / layer2 / layer1（轻量档用于排查长文闪烁）
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
    let restyleTimer = null;      // 原地重刷（改强度/光晕，不拆 span）
    let lastSig = '';             // 上次的结构签名（模式/色标/角度），决定要不要重建 span

    // 闪烁监测：流式期间逐帧采样「屏幕上最新那条消息是否已有逐字 span」。
    // 只要有一帧拍到裸状态（无 span = 元素级路径 = 该设备可能不出光），就会被计入。
    const flicker = {
        raf: null, frames: 0, bareFrames: 0, bareLastAt: null, bareLastLen: null,
        sync: 0, deferred: 0, fail: 0, lastMs: 0, maxMs: 0, reason: {},
        // v1.2.6：这两项直接量化用户抱怨的「两种呈现来回切」。
        // fallbackFrames = 尾条消息处于「元素级兜底」的帧数（按设计允许，流式全程应如此）
        // switches = 尾条消息在「兜底」与「逐字 span」之间来回切换的次数（目标必须是 0）
        fallbackFrames: 0, switches: 0, lastMode: null,
        reset() {
            this.frames = 0; this.bareFrames = 0; this.bareLastAt = null; this.bareLastLen = null;
            this.sync = 0; this.deferred = 0; this.fail = 0; this.lastMs = 0; this.maxMs = 0; this.reason = {};
            this.fallbackFrames = 0; this.switches = 0; this.lastMode = null;
        },
    };

    // v1.2.6「流式锁定」：流式期间正在生成的那条消息只允许一种呈现（元素级渐变 + 光晕），
    // 绝不中途升级成逐字 span。任何一条渲染路径（MO / 定时排程 / 守护帧 / 一次性修复 / 全量重染）
    // 命中带 data-yyx-stream 标记的消息都直接跳过，从结构上消灭「兜底 ↔ 逐字」来回切换。
    const lock = { marked: 0, skips: 0 };

    function isLocked(m) {
        return !!(m && m.hasAttribute && m.hasAttribute('data-yyx-stream'));
    }

    function lockTarget(m) {
        if (!m || isLocked(m)) return false;
        m.setAttribute('data-yyx-stream', '1');
        lock.marked++;
        note('lock', (m.querySelector('.mes_text') || {}).textContent ? 'text' : 'empty');
        return true;
    }

    function clearStreamLocks() {
        let n = 0;
        for (const m of document.querySelectorAll('#chat .mes[data-yyx-stream]')) {
            m.removeAttribute('data-yyx-stream');
            n++;
        }
        if (n) note('unlock', n);
        return n;
    }

    function lastMes() {
        const c = chat.el || document.getElementById('chat');
        if (!c) return null;
        const list = c.querySelectorAll('.mes');
        return list.length ? list[list.length - 1] : null;
    }

    function probeFrame() {
        if (!streaming) { flicker.raf = null; return; }
        flicker.frames++;
        const m = lastMes();
        if (m) {
            const mt = m.querySelector('.mes_text');
            const hasText = mt && (mt.textContent || '').trim().length > 0;
            const painted = m.dataset.yyx === '1' && !!m.querySelector('[data-yyx="ch"], [data-yyx="sol"]');
            const mode = !hasText ? null : (painted ? 'span' : 'fallback');
            if (mode) {
                if (mode === 'fallback') {
                    // 流式期间锁定后「兜底」是唯一合法呈现，不算裸状态，只记帧数
                    if (isLocked(m)) flicker.fallbackFrames++;
                    else {
                        flicker.bareFrames++;
                        flicker.bareLastAt = new Date().toISOString();
                        flicker.bareLastLen = (mt.textContent || '').length;
                        flicker.reason.bare = (flicker.reason.bare || 0) + 1;
                    }
                }
                // 呈现形态来回切换 = 肉眼看到的「一亮一暗」；这个计数必须为 0
                if (flicker.lastMode && flicker.lastMode !== mode) {
                    flicker.switches++;
                    flicker.reason.switch = (flicker.reason.switch || 0) + 1;
                }
                flicker.lastMode = mode;
            }
        }
        flicker.raf = (typeof requestAnimationFrame === 'function')
            ? requestAnimationFrame(probeFrame)
            : (setTimeout(probeFrame, 32), null);
    }

    function startProbe() {
        if (typeof requestAnimationFrame !== 'function') return;
        if (flicker.raf) return;
        flicker.raf = requestAnimationFrame(probeFrame);
    }

    // ===== 诊断时间线（最近 60 条事件，随诊断信息一起导出） =====
    // 闪烁类问题只有「事件顺序」能说明问题：谁在什么时候拆了 span、什么时候补上。
    const timeline = [];
    let lastMutAt = 0;
    let mutCount = 0;
    function note(kind, detail) {
        timeline.push({ t: Date.now() % 1000000, k: kind, d: detail || '' });
        if (timeline.length > 60) timeline.shift();
    }

    // ===== 同步守护（对应「前十几秒不闪、之后开始闪」「重启后几秒才有光晕」） =====
    // 每帧只做一次极便宜的判定：这条消息的文本比上次染完时长，或 span 变少了 → 立刻同步补染。
    // 不依赖 MutationObserver 是否健全，所以容器重建 / 观察器丢失 / 事件漏发都能自愈。
    const PAINT_CACHE = new WeakMap();   // 染完时记下 {total, spans}，作为"是否需要再染"的基线
    const guard = {
        raf: null, frames: 0, fixes: 0, lastFixAt: 0, lastFixChars: 0, bareGlowFrames: 0,
    };

    // 酒馆切聊天/重启后会重建 #chat 容器；观察器若绑在旧节点上，之后的 chunk 全都收不到通知。
    function chatLive() {
        const c = document.getElementById('chat');
        if (!c) return chat.el;
        if (c !== chat.el) {
            chat.el = c;
            ensureObservers();
            note('chat-rebind', '容器重建');
        }
        return chat.el;
    }

    function mesNeedsPaint(m) {
        if (!m || !m.isConnected) return false;
        const mt = m.querySelector('.mes_text');
        if (!mt || !(mt.textContent || '').trim()) return false;
        if (m.dataset.yyx !== '1' || m.dataset.yyxSig !== structSig()) return true;
        const c = PAINT_CACHE.get(m);
        if (!c) return true;
        const total = (mt.textContent || '').length;
        const spans = m.querySelectorAll('[data-yyx="ch"], [data-yyx="sol"]').length;
        return total > c.total || spans < c.spans;
    }

    function tailMes(limit) {
        const c = chat.el;
        if (!c) return [];
        const all = c.querySelectorAll('.mes');
        const out = [];
        for (let i = all.length - 1; i >= 0 && out.length < limit; i--) out.push(all[i]);
        return out;
    }

    function guardTick() {
        guard.raf = null;
        if (!streaming) return;
        guard.frames++;
        // 流式期间正在密集吐字时不做整条重建（见 scheduleMes 的说明），只在静默后才补；
        // 这样长消息不会每 0.6 秒卡两三百毫秒。逐字增量的情况在 MO 回调里已经处理。
        if (Date.now() - lastMutAt < 900) {
            guard.raf = requestAnimationFrame(guardTick);
            return;
        }
        const vh = window.innerHeight || 900;
        let fixed = 0;
        for (const m of tailMes(3)) {
            if (!m.isConnected) continue;
            if (isLocked(m)) { lock.skips++; continue; } // 流式锁定：只保留元素级兜底，不中途升级
            const r2 = m.getBoundingClientRect();
            if (r2.bottom < -vh * 0.5) continue;
            if (!mesNeedsPaint(m)) continue;
            const mt = m.querySelector('.mes_text');
            guard.lastFixChars = mt ? (mt.textContent || '').length : 0;
            paintNow(m, m.dataset.yyx === '1');
            fixed++;
        }
        if (fixed) { guard.fixes += fixed; guard.lastFixAt = Date.now(); note('guard', fixed); }
        guard.raf = requestAnimationFrame(guardTick);
    }

    function startGuard() {
        if (typeof requestAnimationFrame !== 'function') return;
        if (!guard.raf) guard.raf = requestAnimationFrame(guardTick);
    }

    function stopGuard() {
        if (guard.raf) {
            try { cancelAnimationFrame(guard.raf); } catch { /* 忽略 */ }
            guard.raf = null;
        }
    }

    // 一次性修复：只碰「视口附近且确实缺染色」的消息，开销极小，可以放心在启动阶段连打几枪。
    function repairVisible(tag) {
        const c = chatLive();
        if (!c || settings.enabled === false) return 0;
        // 流式密集吐字期间不重建（会卡 200~400ms），静默后再补
        if (streaming && Date.now() - lastMutAt < 900) return 0;
        const vh = window.innerHeight || 900;
        let fixed = 0;
        for (const m of tailMes(40)) {
            if (!m.isConnected) continue;
            if (isLocked(m)) { lock.skips++; continue; } // 流式锁定：交给元素级兜底
            const rr = m.getBoundingClientRect();
            if (rr.width === 0 && rr.height === 0) continue;
            if (rr.bottom < -vh || rr.top > vh * 2) continue;
            if (!mesNeedsPaint(m)) continue;
            applying = true;
            try {
                if (m.dataset.yyx === '1') paintChars(m);
                else if (streaming) paintStreamChunk(m);
                else maybeProcess(m);
                fixed++;
            } catch (e) { console.warn(TAG, 'repair failed', e); }
            finally { applying = false; }
        }
        if (fixed) note('repair:' + (tag || ''), fixed);
        return fixed;
    }

    // 启动/切换聊天时连打几枪：手机端布局慢，一次可能全部「宽高为 0」被跳过，
    // 这正是「重启后先有渐变、几秒后才冒光晕」的成因。
    let burstTimers = [];
    function fastPaintBurst() {
        for (const t of burstTimers) clearTimeout(t);
        burstTimers = [];
        repairVisible('now');
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => repairVisible('raf'));
        for (const ms of [120, 350, 800, 1600]) {
            burstTimers.push(setTimeout(() => repairVisible('burst'), ms));
        }
    }
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
            if (!GLOW_PRESETS[s.glowMode]) s.glowMode = 'layer3';
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
.yyx-debug-out { width: 100%; margin-top: 6px; font-size: .82em; line-height: 1.4; resize: vertical; }
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
        // 流式兜底样式表：流式期间给尚未逐字染色的文字提供中点色 + 同色光晕近似，
        // 待 DOM 稳定后由逐字引擎（paintStreamChunk / repaintAll）补上精确颜色。
        let sc = document.getElementById('yyyx-stream');
        if (!sc) {
            sc = document.createElement('style');
            sc.id = 'yyyx-stream';
            document.head.appendChild(sc);
        }
        sc.textContent = buildStreamCss(settings);
        // 元素级配色表（渐变背景裁剪 + drop-shadow 光晕）：启动即创建，
        // 不依赖消息事件兜底才首次建表，避免首屏空窗。
        let cc = document.getElementById('yyyx-color');
        if (!cc) {
            cc = document.createElement('style');
            cc.id = 'yyyx-color';
            document.head.appendChild(cc);
        }
        cc.textContent = buildColorCss(settings);
    }

    // 设置变化时刷新动态配色样式（表缺失则创建，避免面板改设置后元素级规则落空）
    function updateColorCss() {
        if (typeof document === 'undefined') return; // Node 纯函数测试环境
        let sc = document.getElementById('yyyx-color');
        if (!sc) {
            sc = document.createElement('style');
            sc.id = 'yyyx-color';
            document.head.appendChild(sc);
        }
        sc.textContent = buildColorCss(settings);
    }

    // 设置变化时刷新流式兜底样式（逐字引擎运行时路径）
    function updateStreamCss() {
        if (typeof document === 'undefined') return;
        const sc = document.getElementById('yyyx-stream');
        if (sc) sc.textContent = buildStreamCss(settings);
    }

    // 强制重载配色样式表：先移除再重建 style 节点，确保浏览器重新合成
    // background-clip:text + filter drop-shadow（修复编辑保存后光晕丢失）。
    function reloadColorCss() {
        if (typeof document === 'undefined') return;
        let sc = document.getElementById('yyyx-color');
        if (sc) sc.remove();
        sc = document.createElement('style');
        sc.id = 'yyyx-color';
        document.head.appendChild(sc);
        sc.textContent = buildColorCss(settings);
    }

    // 消息 DOM 被酒馆重建后兜底：清理历史染色 span、强制重载配色样式，并重新逐字染色（防抖）。
    // 注意：拆 span 后必须补一次逐字重染，否则会退回纯文本 + 元素级 filter，丢掉每字同色光晕。
    function scheduleColorReload(ms = 250) {
        if (typeof document === 'undefined') return;
        if (colorCssTimer) clearTimeout(colorCssTimer);
        colorCssTimer = setTimeout(() => {
            colorCssTimer = null;
            clearAllSpans();
            reloadColorCss();
            scheduleRepaint(50);
        }, ms);
    }

    // 轻量事件桥：消息编辑/新增/切换后酒馆会重建消息 DOM。
    // 旧染色引擎观察器已停用，这里只做「清理残留 span + 重载 CSS」，保持元素级 drop-shadow 光晕。
    function bindChatEvents() {
        const es = ctx && ctx.eventSource;
        const et = (ctx && ctx.event_types) || {};
        if (!es || typeof es.on !== 'function') return;
        const on = (name, fn) => { if (et[name]) es.on(et[name], fn); };
        on('GENERATION_STARTED', () => { streaming = true; });
        // 结束后的逐字校正由 registerEvents 的 endStream（scheduleRepaint）负责；
        // 这里只轻量刷新元素级规则，不拆逐字 span，避免把每字同色光晕拆掉退回纯文本。
        const endStream = () => { streaming = false; updateColorCss(); };
        on('GENERATION_ENDED', endStream);
        on('GENERATION_STOPPED', endStream);
        on('MESSAGE_EDITED', () => scheduleColorReload(200));
        on('MESSAGE_SWIPED', () => scheduleColorReload(200));
        on('MESSAGE_RECEIVED', () => scheduleColorReload(200));
        on('MESSAGE_SENT', () => scheduleColorReload(200));
        on('MESSAGE_DELETED', () => scheduleColorReload(200));
        on('CHAT_CHANGED', () => scheduleColorReload(300));
    }

    // 兜底观察器：酒馆某些路径不派发事件，直接监听 #chat 子树变化。
    // 仅在「消息元素」被新增/替换且非流式时重载 CSS，避免流式每 chunk 重建导致的闪烁。
    function watchChatMutations() {
        const c = chat.el;
        if (!c || chat.cssMo) return;
        if (typeof MutationObserver === 'undefined') return;
        chat.cssMo = new MutationObserver(muts => {
            if (applying || streaming) return;
            for (const mu of muts) {
                if (mu.type !== 'childList') continue;
                for (const n of mu.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    const mes = n.classList && n.classList.contains('mes') ? n
                        : (n.querySelector ? n.querySelector('.mes') : null);
                    if (mes) { scheduleColorReload(250); return; }
                }
            }
        });
        chat.cssMo.observe(c, { childList: true, subtree: true });
    }

    // ===== 染色引擎 =====
    // 收集文本节点：跳过代码块、代码行内、已染色的 span 及额外排除的子树。
    // 注意只能排除 span 级的 data-yyx="ch"/"sol"，不能排除消息级的 data-yyx="1" ——
    // 流式增量染色时消息已经带 data-yyx="1"，若用 [data-yyx] 匹配，closest 会一路命到
    // .mes 自身，导致新文字一个都染不上（表现为「流式期间只有部分字有色」）。
    function collectText(root, extraSkip) {
        const out = [];
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
            const p = n.parentNode;
            if (!p) continue;
            if (p.closest('code, pre, [data-yyx="ch"], [data-yyx="sol"]')) continue;
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

    // 引用解析状态按元素保存：流式增量包裹时，后续文本节点要接着上一段引号状态继续。
    const QSTATE = new WeakMap();

    function paintGradient(el, cfg, granularity, groups, extraSkip) {
        const stops = stopsOf(cfg);
        let container = el;
        if (granularity === 'block') {
            container = el.closest('p, li, div, blockquote, h1, h2, h3, h4, h5, h6, .mes_text') || el.parentElement || el;
        }
        let key = groups.get(container);
        if (!key) { key = new Map(); groups.set(container, key); }
        const byQuote = granularity === 'quote';     // 引用：每对引号一个循环，叙述不染
        const byEm = granularity === 'em';           // 斜体：每对 * 包裹的 em 一个循环
        const byOrder = byQuote || byEm;             // 引号内 / 斜体按字符顺序线性取色
        // 组号 / 引号状态从上次包裹处延续，保证流式增量追加时不会和已有分组串在一起
        let gid = Number(el.dataset.yyxG || 0) || 0;
        let qstate = byQuote ? (QSTATE.get(el) || null) : null;
        const kindAttr = byQuote ? 'quote' : byEm ? 'em' : 'main';
        const getList = (g) => {
            let L = key.get(g);
            if (!L) { L = { spans: [], cfg, stops, order: byOrder }; key.set(g, L); }
            return L;
        };
        for (const n of collectText(el, extraSkip)) {
            if (!n.nodeValue.trim()) continue; // 纯空白节点无可见颜色，跳过
            const chars = graphemes(n.nodeValue || '');
            if (!chars.length) continue;
            const frag = document.createDocumentFragment();
            if (byQuote) {
                // 引用：只染引号内的对话，每对引号一个完整循环；引号外叙述保持酒馆原色（textNode 保留）
                const r = quoteSegments(chars, gid, qstate);
                qstate = r.state;
                let plain = '';
                const flushPlain = () => { if (plain) { frag.appendChild(document.createTextNode(plain)); plain = ''; } };
                for (let i = 0; i < chars.length; i++) {
                    const g = r.segs[i];
                    if (g == null) { plain += chars[i]; continue; }
                    flushPlain();
                    const sp = document.createElement('span');
                    sp.className = 'yyx-ch';
                    sp.setAttribute('data-yyx', 'ch');
                    sp.setAttribute('data-k', kindAttr);
                    sp.setAttribute('data-g', String(g));
                    sp.textContent = chars[i];
                    frag.appendChild(sp);
                    getList(g).spans.push(sp);
                }
                flushPlain();
                gid = r.gid;
            } else {
                for (const ch of chars) {
                    const sp = document.createElement('span');
                    sp.className = 'yyx-ch';
                    sp.setAttribute('data-yyx', 'ch');
                    sp.setAttribute('data-k', kindAttr);
                    sp.setAttribute('data-g', String(gid));
                    sp.textContent = ch;
                    frag.appendChild(sp);
                    getList(gid).spans.push(sp);
                }
            }
            n.parentNode.replaceChild(frag, n);
        }
        el.dataset.yyxG = String(gid);
        if (byQuote) QSTATE.set(el, qstate);
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

    // 每个 span 上一次写入的样式缓存：流式每来一个 chunk 都要重算整条消息的取色，
    // 若每次都全量写 DOM，手机端会明显抖动；这里只写「颜色真的变了」的那几个字。
    const SPAN_CACHE = new WeakMap();

    // v1.2.8：取消「整组重算节流」。
    // 旧做法是流式期间 200ms 内只给新字上色、老字保持旧值；但单元的字符数在流式期间一直在变长，
    // 旧值是按「当时更短的单元」算出来的取色位置 —— 长引用因此会出现「中间比末尾更蓝」的非单调配色，
    // 看起来就像两段不一样蓝。现在每个 chunk 都整条重算，配色始终单调、首尾固定。
    function applySpan(sp, hex, strength) {
        const prev = SPAN_CACHE.get(sp);
        const key = hex + '|' + strength + '|' + glowMode;
        if (prev && prev.k === key) return;
        SPAN_CACHE.set(sp, { k: key });
        sp.style.setProperty('color', hex, 'important');
        sp.style.setProperty('-webkit-text-fill-color', hex, 'important');
        sp.style.setProperty('text-shadow', glowShadow(hex, strength), 'important');
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
                if (item.order) {
                    // 每个引号内对话 / 每对 *xxx* 独立循环：按字符顺序线性取色（首→尾），
                    // 不走空间投影，避免跨行方向反转。
                    // v1.2.9：去掉 v1.2.8 的「末端保色」（最后 8 字压成满值尾色会在长引用尾部
                    // 铺出一条实色蓝带，是「蓝色太蓝」的主要来源），并让整段只走完色标前
                    // STOP_REACH 段 —— 与雨夜回响主题里「文字没走完整个渐变色盒」一致。
                    for (let i = 0; i < n; i++) {
                        const t = (n === 1) ? 0 : i / (n - 1);
                        applySpan(spans[i], colorAt(stops, t * STOP_REACH), strength);
                    }
                    continue;
                }
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
                    applySpan(spans[i], colorAt(stops, T * STOP_REACH), strength);
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
        delete mes.dataset.yyxSig;
        // 分组续接标记随文本一起作废，避免还原后再次包裹时沿用旧组号
        for (const el of mes.querySelectorAll('.mes_text, .mes_text em, .mes_text i, .mes_text q, .mes_text blockquote')) {
            delete el.dataset.yyxG;
        }
    }

    const MES_SIG = new WeakMap();   // 消息上次染完时的纯文本指纹（用于忽略自己写入产生的 DOM 回声）

    function textSig(mt) {
        const s = (mt && mt.textContent) || '';
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return s.length + ':' + h;
    }

    function markDone(mes) {
        mes.dataset.yyx = '1';
        mes.dataset.yyxRev = rev;
        mes.dataset.yyxSig = structSig();
        const mt = mes.querySelector('.mes_text');
        if (mt) {
            MES_SIG.set(mes, textSig(mt));
            // 同步守护的基线：此刻的字符数与 span 数，之后任一变大/变小就说明需要补染
            PAINT_CACHE.set(mes, {
                total: (mt.textContent || '').length,
                spans: mes.querySelectorAll('[data-yyx="ch"], [data-yyx="sol"]').length,
            });
        }
    }

    // 结构签名：只包含「决定 span 怎么排布」的项（模式 / 色标 / 角度）。
    // 强度、光晕开关、纯色只影响每个 span 的样式，不改变结构 —— 这类改动可以原地重刷，无需拆 span。
    function structSig() {
        return TARGET_KEYS.map((k) => {
            const t = settings[k] || {};
            const st = Array.isArray(t.stops) ? t.stops.join(',') : '';
            return `${t.mode}|${t.color || ''}|${st}|${t.angle || 0}`;
        }).join(';');
    }

    // 从 DOM 里现有的逐字 span 重建分组表，交给 finalizeGroups 重新上色。
    // 用于「只改样式、不重建结构」的原地刷新（调强度 / 开关光晕 / 颜色），
    // 这样光晕不会因为拆 span 而出现「消失一下再回来」的空窗。
    function finalizeFromDom(mes) {
        const mt = mes.querySelector('.mes_text');
        if (!mt) return;
        const groups = new Map();
        const sps = mes.querySelectorAll('[data-yyx="ch"]');
        if (!sps.length) return;
        for (const sp of sps) {
            const kind = sp.getAttribute('data-k') || 'main';
            const cfgKey = kind === 'em' ? 'italic' : kind === 'quote' ? 'quote' : 'main';
            const cfg = settings[cfgKey];
            if (!cfg || cfg.mode === 'theme') continue;
            // 容器必须和染色时一致：主要文本统一用 .mes_text（整条消息一个渐变），
            // 斜体/引用用它自己那个 em / q。若这里按最近的 p 分组，正文会变成「每段一个完整渐变」。
            const host = kind === 'main'
                ? mt
                : (sp.closest('em, i, q, blockquote') || mt);
            let key = groups.get(host);
            if (!key) { key = new Map(); groups.set(host, key); }
            const g = sp.getAttribute('data-g') || '0';
            let item = key.get(g);
            if (!item) {
                item = { spans: [], cfg, stops: stopsOf(cfg), order: kind !== 'main' };
                key.set(g, item);
            }
            item.spans.push(sp);
        }
        try { finalizeGroups(groups); } catch (e) { console.warn(TAG, 'finalize failed', e); }
    }

    // ===== 绘制耗时统计（诊断用：区分「JS 补染太慢」和「光栅化太慢」） =====
    const perf = { calls: 0, lastMs: 0, maxMs: 0, sumMs: 0, lastAt: 0, slowCount: 0, byKind: {} };
    function timePaint(kind, fn) {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        try {
            return fn();
        } finally {
            const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
            perf.calls++;
            perf.lastMs = Math.round(dt);
            perf.sumMs += dt;
            perf.lastAt = Date.now();
            if (dt > perf.maxMs) perf.maxMs = Math.round(dt);
            if (dt > 16) perf.slowCount++;
            const b = perf.byKind[kind] || (perf.byKind[kind] = { n: 0, last: 0, max: 0 });
            b.n++; b.last = Math.round(dt); if (dt > b.max) b.max = Math.round(dt);
        }
    }

    // 只补新增文字 + 原地重上色：不动已有 span，因此流式期间不会出现「没光晕的那一帧」。
    function paintChars(mes) { return timePaint('chars', () => _paintChars(mes)); }
    function _paintChars(mes) {
        if (!mes || !mes.isConnected) return;
        if (settings.enabled === false) return;
        const mt = mes.querySelector('.mes_text');
        if (!mt) return;
        const r = mt.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return; // 无布局，等可见再染
        const dummy = new Map();
        const s = settings;
        for (const em of mt.querySelectorAll('em, i')) {
            if (em.closest('code, pre')) continue;
            paintTargetEl(em, s.italic, dummy, 'em');
        }
        for (const q of mt.querySelectorAll('q, blockquote')) {
            if (q.closest('code, pre')) continue;
            paintTargetEl(q, s.quote, dummy, 'quote');
        }
        paintTargetEl(mt, s.main, dummy, 'message', 'em, i, q, blockquote');
        finalizeFromDom(mes);
        mes.removeAttribute('data-yyx-stream');
        markDone(mes);
    }

    function applyMes(mes) { return timePaint('full', () => _applyMes(mes)); }
    function _applyMes(mes) {
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
        for (const em of mt.querySelectorAll('em, i')) {
            if (em.closest('code, pre, [data-yyx="ch"], [data-yyx="sol"]')) continue;
            paintTargetEl(em, s.italic, groups, 'em');
        }
        for (const q of mt.querySelectorAll('q, blockquote')) {
            if (q.closest('code, pre')) continue;
            paintTargetEl(q, s.quote, groups, 'quote');
        }
        paintTargetEl(mt, s.main, groups, 'message', 'em, i, q, blockquote');
        finalizeGroups(groups);
        mes.removeAttribute('data-yyx-stream');
        markDone(mes);
    }

    function maybeProcess(m) {
        if (!m || !m.isConnected) return;
        if (m.dataset.yyx === '1' && m.dataset.yyxRev === rev && m.dataset.yyxSig === structSig()) return;
        if (m.dataset.yyx === '1' && m.dataset.yyxSig === structSig()) {
            // 结构没变、只是数值变了：原地重刷，不拆 span
            paintChars(m);
            return;
        }
        restoreMes(m);
        applyMes(m);
    }

    // 流式生成期间的染色：单一路径 —— 与结束后同一套逐字 span（每字同色 + 同色光晕）。
    // 新消息先完整染一次（含结构），之后每个 chunk 只补新增字符并原地重上色，
    // 不再往消息上贴元素级渐变兜底，从根上消除「有光/无光交替」的闪烁。
    function paintStreamChunk(mes) {
        if (!mes || !mes.isConnected) return;
        if (settings.enabled === false) return;
        const sig = structSig();
        if (mes.dataset.yyx !== '1' || mes.dataset.yyxSig !== sig) {
            applyMes(mes);
            return;
        }
        paintChars(mes);
    }
    // 重新渲染：已染色消息 + 视口附近的未染色消息
    function repaintAll() {
        const c = chat.el;
        if (!c || !c.isConnected) return;
        applying = true;
        try {
            const vh = window.innerHeight || 900;
            for (const m of c.querySelectorAll('.mes')) {
                if (streaming && isLocked(m)) { lock.skips++; continue; } // 流式锁定：不中途升级成逐字
                const processed = m.dataset.yyx === '1';
                if (!processed) {
                    const rr = m.getBoundingClientRect();
                    if (rr.width === 0 && rr.height === 0) continue;
                    // 流式期间只染屏幕附近的；非流式时只要已染过就全部刷新
                    if (streaming && rr.bottom < -vh * 0.5) continue;
                    if (!streaming && (rr.bottom < -vh || rr.top > vh * 2)) continue;
                }
                if (streaming) paintStreamChunk(m);
                else maybeProcess(m);
            }
            for (const m of c.querySelectorAll('.mes[data-yyx-stream]')) {
                if (m.dataset.yyx === '1') m.removeAttribute('data-yyx-stream');
            }
        } finally {
            applying = false;
        }
    }

    // 诊断用：读取浏览器「真实生效」的样式值（不是我们写进 CSS 的字符串），
    // 才能区分「规则没写对」和「写了但被主题覆盖/渲染不出来」。
    function computedOf(el, prop) {
        if (!el) return null;
        try {
            const cs = getComputedStyle(el);
            return cs.getPropertyValue(prop) || null;
        } catch { return null; }
    }

    // 某一时刻的状态快照：设置、消息标签命中、逐字 span、计算后的 filter/shadow。
    // 抽样取「最新的两条」消息 —— 真正在屏幕上滚动的就是它们；最早的消息通常在视口外，
    // 本来就按设计不染色，拿它们做样本会得出「span 数为 0」的假结论。
    function snapshotState() {
        const c = document.getElementById('chat');
        const all = [...document.querySelectorAll('#chat .mes')];
        const sample = all.slice(-2);
        const items = sample.map((m, idx) => {
            const i = all.length - sample.length + idx;
            const mt = m.querySelector('.mes_text');
            const q = mt ? mt.querySelector('q, blockquote') : null;
            const em = mt ? mt.querySelector('em, i') : null;
            const sp = m.querySelector('[data-yyx="ch"]') || m.querySelector('[data-yyx="sol"]');
            const r = mt && mt.getBoundingClientRect ? mt.getBoundingClientRect() : null;
            return {
                i,
                done: m.dataset.yyx === '1',
                stream: m.hasAttribute('data-yyx-stream'),
                sig: m.dataset.yyxSig || null,
                w: r ? Math.round(r.width) : null,
                h: r ? Math.round(r.height) : null,
                emTag: em ? em.tagName.toLowerCase() : null,
                emSpans: em ? em.querySelectorAll('[data-yyx="ch"]').length : 0,
                emFilter: computedOf(em, 'filter'),
                emShadow: computedOf(em, 'text-shadow'),
                emFill: computedOf(em, '-webkit-text-fill-color'),
                qSpans: q ? q.querySelectorAll('[data-yyx="ch"]').length : 0,
                qFilter: computedOf(q, 'filter'),
                qShadow: computedOf(q, 'text-shadow'),
                qFill: computedOf(q, '-webkit-text-fill-color'),
                spanShadow: computedOf(sp, 'text-shadow'),
                spanFill: computedOf(sp, '-webkit-text-fill-color'),
                spanColor: computedOf(sp, 'color'),
            };
        });
        // 全局计数：看清「到底有多少条染上了、屏幕附近有没有掉队的」
        const doneCount = all.filter((m) => m.dataset.yyx === '1').length;
        const spanTotal = document.querySelectorAll('#chat .mes [data-yyx="ch"]').length;
        const vh = window.innerHeight || 900;
        let nearUndone = 0;
        for (const m of all) {
            if (m.dataset.yyx === '1') continue;
            const rr = m.getBoundingClientRect();
            if (rr.height > 0 && rr.bottom > -vh && rr.top < vh * 2) nearUndone++;
        }
        return {
            at: new Date().toISOString(),
            streaming,
            chatClass: c ? c.className : null,
            enabled: settings.enabled !== false,
            strength: { italic: settings.italic && settings.italic.strength, quote: settings.quote && settings.quote.strength },
            glow: { italic: !!(settings.italic && settings.italic.glow), quote: !!(settings.quote && settings.quote.glow) },
            total: all.length,
            doneCount,
            spanTotal,
            nearUndone,
            items,
        };
    }

    // 生成结束后的自动快照：400ms / 1400ms 各拍一次，抓住收尾瞬间的真实状态，
    // 用户之后按「诊断信息」也能看到当时的样子，不必卡时间点。
    const endSnapshots = [];
    const snapTimers = [];
    function recordEndSnapshots() {
        for (const ms of [400, 1400]) {
            const t = setTimeout(() => {
                try { endSnapshots.push(snapshotState()); } catch { /* 忽略 */ }
                if (endSnapshots.length > 4) endSnapshots.splice(0, endSnapshots.length - 4);
            }, ms);
            snapTimers.push(t);
        }
    }

    // 诊断信息：挂到 window.__yyyx.debug()，面板「诊断信息」按钮也读同一份数据。
    function debugInfo() {
        const pick = (els) => [...els].slice(0, 2).map((el) => {
            const ch = el.querySelector('[data-yyx="ch"]');
            return {
                tag: el.tagName.toLowerCase(),
                spanCount: el.querySelectorAll('[data-yyx="ch"]').length,
                shadow: ch ? ch.style.textShadow || null : null,
                fill: ch ? ch.style.getPropertyValue('-webkit-text-fill-color') || null : null,
                text: el.textContent.slice(0, 24),
            };
        });
        // 同样只抽样「最新的几条」，最早的消息在视口外本来就按设计不染色
        const all = [...document.querySelectorAll('#chat .mes')];
        const messages = all.slice(-4).map((m, idx) => ({
            i: all.length - 4 + idx,
            done: m.dataset.yyx === '1',
            stream: m.hasAttribute('data-yyx-stream'),
            chars: ((m.querySelector('.mes_text') || {}).textContent || '').length,
            spans: m.querySelectorAll('[data-yyx="ch"], [data-yyx="sol"]').length,
            em: pick(m.querySelectorAll('em, i')),
            quote: pick(m.querySelectorAll('q, blockquote')),
        }));
        const table = (id) => { const t = document.getElementById(id); return t ? t.textContent.slice(0, 300) : null; };
        const c = document.getElementById('chat');
        const last = all.length ? all[all.length - 1] : null;
        return {
            version: VERSION,
            streaming,
            enabled: settings.enabled !== false,
            chatClass: c ? c.className : null,
            chatFound: !!c,
            settings: TARGET_KEYS.reduce((o, k) => { o[k] = settings[k]; return o; }, {}),
            // 闪烁监测：流式期间逐帧采样，bareFrames > 0 说明确实存在「无 span」的画面
            flicker: {
                frames: flicker.frames,
                bareFrames: flicker.bareFrames,
                bareRate: flicker.frames ? +(flicker.bareFrames / flicker.frames).toFixed(3) : 0,
                bareLastAt: flicker.bareLastAt,
                bareLastLen: flicker.bareLastLen,
                syncPaints: flicker.sync,
                deferredPaints: flicker.deferred,
                failedPaints: flicker.fail,
                lastPaintMs: flicker.lastMs,
                maxPaintMs: flicker.maxMs,
                reasons: flicker.reason,
                // v1.2.6：流式期间「兜底」是唯一合法呈现；fallbackFrames 应≈frames，
                // switches（兜底↔逐字来回切）必须是 0，>0 就说明还在闪。
                fallbackFrames: flicker.fallbackFrames,
                modeSwitches: flicker.switches,
            },
            // 流式锁定：marked = 这一轮被锁定（保持元素级兜底）的消息数，
            // skips = 各条渲染路径因为锁定而跳过的次数（它替我们挡掉了多少次整条重建）
            lock: { marked: lock.marked, skips: lock.skips, lockedNow: document.querySelectorAll('#chat .mes[data-yyx-stream]').length },
            lastMes: last ? (() => {
                const mt = last.querySelector('.mes_text');
                const sp = last.querySelector('[data-yyx="ch"]');
                const cache = PAINT_CACHE.get(last);
                const total = (mt ? mt.textContent : '').length;
                const spans = last.querySelectorAll('[data-yyx="ch"], [data-yyx="sol"]').length;
                return {
                    done: last.dataset.yyx === '1',
                    stream: last.hasAttribute('data-yyx-stream'),
                    chars: total,
                    spans,
                    // 与上次染完时的基线对比：total > base.total 或 spans < base.spans 就代表「有新文字没染上」
                    baseTotal: cache ? cache.total : null,
                    baseSpans: cache ? cache.spans : null,
                    lagChars: cache ? total - cache.total : null,
                    // 真正生效的光晕（不是我们写进去的字符串）：none 就说明这一帧肉眼看不到光
                    glowNow: sp ? (computedOf(sp, 'text-shadow') || 'none') : null,
                    // 流式兜底态没有 span，这时光晕要看 .mes_text 自己生效的 text-shadow
                    mesShadow: (() => {
                        const s = computedOf(mt, 'text-shadow');
                        return s ? s.slice(0, 80) : 'none';
                    })(),
                    mesFill: computedOf(mt, '-webkit-text-fill-color'),
                    syncLimit: SYNC_PAINT_MAX_CHARS,
                };
            })() : null,
            // 观察器健康度：容器是否被酒馆重建、观察器是否还挂在活节点上
            observers: {
                moTargetAlive: !!(chat.el && chat.el.isConnected),
                moTargetIsCurrentChat: !!chat.el && chat.el === document.getElementById('chat'),
                moAttached: !!chat.mo,
                ioAttached: !!chat.io,
            },
            // 同步守护：流式期间每帧自检的成果（fixes > 0 说明观察器/事件漏了、被守护补上）
            guard: {
                frames: guard.frames,
                fixes: guard.fixes,
                lastFixAt: guard.lastFixAt,
                lastFixChars: guard.lastFixChars,
            },
            mutations: mutCount,
            lastMutationAt: lastMutAt,
            // 绘制耗时：区分「JS 补染太慢」和「光栅化太慢（JS 很快但画面仍闪）」
            perf: {
                calls: perf.calls,
                lastMs: perf.lastMs,
                maxMs: perf.maxMs,
                avgMs: perf.calls ? +(perf.sumMs / perf.calls).toFixed(1) : 0,
                slowOver16ms: perf.slowCount,
                byKind: perf.byKind,
                lastAt: perf.lastAt,
            },
            // 发光成本：全场 span 数、带光晕的 span 数、模糊半径总和（判断是不是光栅化压力）
            cost: (() => {
                const sps = document.querySelectorAll('#chat .mes [data-yyx="ch"]');
                let glowSpans = 0, blurSum = 0;
                for (const sp of sps) {
                    const sh = sp.style.textShadow || '';
                    if (!sh || sh === 'none') continue;
                    glowSpans++;
                    for (const mm of sh.matchAll(/(\d+(?:\.\d+)?)px/g)) blurSum += parseFloat(mm[1]);
                }
                return {
                    totalSpans: sps.length,
                    glowSpans,
                    blurSumPx: Math.round(blurSum),
                    glowMode: glowMode,
                    stopReach: STOP_REACH,
                    lastMesHeight: last ? Math.round(last.getBoundingClientRect().height) : null,
                };
            })(),
            timeline: timeline.slice(),
            now: snapshotState().items,
            afterEnd: endSnapshots,
            messages,
            colorCss: table('yyyx-color'),
            streamCss: table('yyyx-stream'),
        };
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
                if (streaming && isLocked(m)) { lock.skips++; continue; } // 流式锁定：只保留兜底
                if (streaming) paintStreamChunk(m); // 非锁定消息流式期间增量上色
                else maybeProcess(m);
            }
        } finally {
            applying = false;
        }
    }

    function scheduleMes(list, delay = 250) {
        // v1.2.6：流式期间被锁定的消息一律不排队 —— 它们在生成结束前保持元素级兜底，
        // 这样「静默超过 1.2 秒」也不会突然升级成逐字 span、下一个 chunk 又被打回兜底（就是闪烁本身）。
        for (const m of list) {
            if (streaming && isLocked(m)) { lock.skips++; continue; }
            pendingMes.add(m);
        }
        if (streaming) delay = Math.max(delay, 1200);
        if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
        if (!pendingMes.size) return; // 全被锁定跳过：不排一个空定时器
        paintTimer = setTimeout(flushPending, delay);
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
        // 只认「染色 span」（yyx-ch / yyx-sol），不能把消息级 data-yyx='1' 已处理标记
        // 误判成「我们的节点」——否则酒馆编辑/重建消息后新增的节点会被整体跳过，消息不再重染。
        return !!(n.closest && n.closest('.yyx-ch, .yyx-sol'));
    }

    function observeMes(mes) {
        if (!chat.io || observed.has(mes)) return;
        observed.add(mes);
        chat.io.observe(mes);
    }

    function onChatMutation(muts) {
        if (applying) return;
        const targets = new Set();
        for (const mu of muts) {
            if (mu.type === 'characterData') {
                // 酒馆流式时可能直接改 textContent：同样会清掉染色结构，需要兜底
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
        mutCount++;
        lastMutAt = Date.now();
        if (streaming) armStreamTimer(); // 心跳：真在吐字就别让 120s 兜底误触发
        note('mut', targets.size);
        const deferred = [];
        for (const m of targets) {
            const mt = m.querySelector('.mes_text');
            const hasSpans = !!m.querySelector('[data-yyx="ch"], [data-yyx="sol"]');
            // 自己写 DOM 也会触发回调（引用段落的叙述文字会插回纯文本节点），
            // 这类回声必须忽略，否则会「重染 → 又触发 → 再重染」无限循环。
            // 判据：消息里仍有我们的 span，且文本指纹和上次染完时一致。
            if (hasSpans && mt && MES_SIG.get(m) === textSig(mt)) {
                observeMes(m);
                continue;
            }
            observeMes(m);
            // v1.2.7：已锁定的消息（同步重建连续失败的兜底）在生成结束前不再重试，
            // 保持元素级渐变 + 光晕，避免反复失败把界面拖住。
            if (streaming && isLocked(m)) { lock.skips++; continue; }
            // 结构还在（span 未被抹掉，只是文字增加了）：保留标记，走增量，已有 span 原地复用。
            // 增量补染只花 2~3ms（实测），继续保留。
            if (hasSpans && streaming && syncPaintable(m)) {
                paintNow(m, true);
                continue;
            }
            // 酒馆/外部改动了消息 DOM（流式重建、编辑、swipe、删除重插等）会抹掉逐字 span，
            // 清除「已处理」标记，强制重新染色，避免 maybeProcess 误判跳过而落回酒馆原生色。
            delete m.dataset.yyx;
            delete m.dataset.yyxRev;
            if (streaming) {
                // v1.2.7 关键：流式期间仍然逐字染色，且**在 MutationObserver 回调里同步做完**。
                // MO 回调是微任务，发生在浏览器下一次绘制之前，所以不存在「先看到元素级兜底、
                // 再跳成逐字色」的中间帧 —— 这也是「首色光晕 ↔ 每字同色光晕」交替闪烁的唯一来源。
                // 只有连续失败（见 paintNow 的 catch）才退回元素级兜底并锁定到生成结束。
                paintNow(m, false);
                continue;
            }
            deferred.push(m);
        }
        if (deferred.length) scheduleMes(deferred);
    }

    // 同步重染：出错绝不能把异常抛回 MutationObserver（会让后续 chunk 全部丢失），
    // 一律吞掉并退回防抖路径；同一条消息连续失败 3 次就锁定为元素级兜底，避免一直空转把界面拖住。
    const FAILS = new WeakMap();
    function paintNow(m, incremental) {
        applying = true;
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        try {
            if (incremental && m.dataset.yyx === '1') paintChars(m);
            else paintStreamChunk(m);
            FAILS.delete(m);
            flicker.sync++;
            note('sync', incremental ? 'inc' : 'full');
        } catch (e) {
            console.warn(TAG, 'sync paint failed', e);
            flicker.fail++;
            const n = (FAILS.get(m) || 0) + 1;
            FAILS.set(m, n);
            if (n >= 3) lockTarget(m); // 多次失败：本轮生成期间改用元素级兜底
            else scheduleMes([m]);
        } finally {
            const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
            flicker.lastMs = Math.round(dt);
            if (dt > flicker.maxMs) flicker.maxMs = Math.round(dt);
            applying = false;
        }
    }

    // 同步重染的上限只作为「极端兜底」：正常消息一律同步，
    // 上限放得很宽（>2 万字的历史长文才会走防抖），否则正在流出的长回复会持续闪烁。
    const SYNC_PAINT_MAX_CHARS = 20000;
    function syncPaintable(m) {
        if (!m || !m.isConnected) return false;
        const mt = m.querySelector('.mes_text');
        if (!mt) return false;
        const len = (mt.textContent || '').length;
        return len <= SYNC_PAINT_MAX_CHARS;
    }

    function ensureObservers() {
        const c = chat.el;
        if (!c) return;
        // 容器换了（重启/切聊天后酒馆重建 #chat）：旧观察器绑在已废弃节点上，必须重挂
        if (chat.mo && chat.moTarget && chat.moTarget !== c) {
            try { chat.mo.disconnect(); } catch { /* 忽略 */ }
            chat.mo = null;
            chat.moTarget = null;
        }
        if (chat.io && chat.ioTarget && chat.ioTarget !== c) {
            try { chat.io.disconnect(); } catch { /* 忽略 */ }
            chat.io = null;
            chat.ioTarget = null;
        }
        if (!chat.mo) {
            chat.mo = new MutationObserver(onChatMutation);
            // characterData 也必须在订阅范围内：酒馆流式有两种写法（整段重写 / 只改文本节点），
            // 只订阅 childList 时，后者一个通知都收不到 → 表面上「染到一半就停住」。
            chat.mo.observe(c, { childList: true, characterData: true, subtree: true });
            chat.moTarget = c;
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
            chat.ioTarget = c;
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
    // 120 秒「ENDED 事件丢了」兜底。每次收到新 chunk 都重置（见 onChatMutation），
    // 否则超长回复会在生成到一半时被误判结束 —— 解锁 + 重建 = 一次可见的闪。
    function armStreamTimer() {
        if (streamTimer) clearTimeout(streamTimer);
        streamTimer = setTimeout(() => {
            streamTimer = null;
            if (!streaming) return;
            streaming = false;
            if (chat.el) chat.el.classList.remove('yyx-streaming');
            clearStreamLocks();
            scheduleRepaint(400);
        }, 120000);
    }

    function registerEvents() {
        const es = ctx && ctx.eventSource;
        const et = (ctx && ctx.event_types) || {};
        if (!es || typeof es.on !== 'function') return;
        const on = (name, fn) => { if (et[name]) es.on(et[name], fn); };

        on('GENERATION_STARTED', () => {
            streaming = true;
            flicker.reset();
            lock.marked = 0; lock.skips = 0;
            // 清掉上一轮可能残留的锁定标记（例如 STOPPED 事件丢了），否则那条消息会一直停在兜底
            clearStreamLocks();
            startProbe();
            guard.frames = 0; guard.fixes = 0; guard.lastFixAt = 0;
            startGuard();
            if (chat.el) chat.el.classList.add('yyx-streaming'); // 流式类：未染色消息立即命中元素级渐变兜底
            armStreamTimer();
        });
        const endStream = () => {
            const wasStreaming = streaming;
            streaming = false;
            stopGuard();
            if (chat.el) chat.el.classList.remove('yyx-streaming');
            if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
            if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
            // 解锁 → 唯一一次精确重建。v1.2.6 之前这里是 3 次全量重染 + 一轮连打，
            // 一条长消息会被整条重染 4~8 次（每次 300~486ms），收尾那一两秒同样看得见闪。
            // 现在只重染一次，后续只做「确实还缺染色」的增量修复（mesNeedsPaint 会跳过已完成项）。
            clearStreamLocks();
            if (wasStreaming || anyGradient()) {
                try { repaintAll(); } catch (e) { console.warn(TAG, 'final repaint failed', e); }
                fastPaintBurst();
            }
            recordEndSnapshots();
        };
        on('GENERATION_ENDED', endStream);
        on('GENERATION_STOPPED', endStream);

        on('MESSAGE_RECEIVED', () => { scheduleRepaint(600); repairVisible('recv'); });
        on('MESSAGE_SENT', () => scheduleRepaint(600));
        on('MESSAGE_EDITED', () => scheduleRepaint(300));
        on('MESSAGE_SWIPED', () => scheduleRepaint(300));
        on('MESSAGE_DELETED', () => scheduleRepaint(300));
        on('CHAT_CHANGED', () => { scheduleRepaint(500); fastPaintBurst(); });
        on('APP_READY', () => { scheduleRepaint(300); fastPaintBurst(); });
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
        const strength = Number.isFinite(entry.strength) ? entry.strength : 100;
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
        const prevSig = lastSig;
        const prevMode = glowMode;
        glowMode = GLOW_PRESETS[settings.glowMode] ? settings.glowMode : 'layer3';
        rev = JSON.stringify(settings);
        const sig = structSig();
        lastSig = sig;
        updateStreamCss();
        updateColorCss(); // 元素级渐变/光晕规则随设置同步刷新（只是给未染色消息的过渡用）
        if (prevMode !== glowMode) note('glow-mode', glowMode);
        if (sig !== prevSig) {
            // 模式 / 色标 / 角度变了：span 的分组结构必须重建，只能整条重来
            clearAllSpans();
            scheduleRepaint(120);
            return;
        }
        // 只改强度 / 光晕开关 / 纯色：结构不变，原地重刷每个 span 的样式。
        // 绝不拆 span —— 拆了就有一帧「没有逐字颜色也没有光晕」，正是「调强度光晕消失」的来源。
        scheduleRestyle(60);
    }

    // 原地重刷：不重建 span，只按新设置重算每个字的颜色与同色光晕。
    function restyleAll() {
        const c = chat.el || document.getElementById('chat');
        if (!c) return;
        applying = true;
        try {
            for (const m of c.querySelectorAll('.mes[data-yyx="1"]')) {
                if (!m.querySelector('[data-yyx="ch"], [data-yyx="sol"]')) {
                    // 没有逐字结果（比如被还原过），按常规重新染一次
                    applyMes(m);
                    continue;
                }
                // 纯色模式或某类改成 theme 时，结构其实变了，走完整重建
                if (needRebuild(m)) { applyMes(m); continue; }
                finalizeFromDom(m);
                m.dataset.yyxRev = rev;
                m.dataset.yyxSig = structSig();
            }
        } finally {
            applying = false;
        }
    }

    // 是否有某一类文字因为模式/色标变化，已经无法沿用现有 span 结构
    function needRebuild(mes) {
        const kinds = mes.querySelectorAll('[data-yyx="ch"]');
        for (const sp of kinds) {
            const kind = sp.getAttribute('data-k') || 'main';
            const key = kind === 'em' ? 'italic' : kind === 'quote' ? 'quote' : 'main';
            const cfg = settings[key];
            if (!cfg || cfg.mode !== 'gradient') return true;
        }
        const mt = mes.querySelector('.mes_text');
        if (!mt) return true;
        const s = settings;
        if (s.italic && s.italic.mode === 'solid' && mt.querySelector('em, i') && !mt.querySelector('em [data-yyx="sol"]')) return true;
        if (s.quote && s.quote.mode === 'solid' && mt.querySelector('q, blockquote') && !mt.querySelector('q [data-yyx="sol"]')) return true;
        return false;
    }

    function scheduleRestyle(ms = 60) {
        if (restyleTimer) clearTimeout(restyleTimer);
        restyleTimer = setTimeout(() => {
            restyleTimer = null;
            if (applying) return;
            try { restyleAll(); } catch (e) { console.warn(TAG, 'restyle failed', e); }
        }, ms);
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
            <div class="yyx-row">
              <label class="yyx-lbl">光晕渲染</label>
              <select class="yyx-in yyx-glowmode">
                <option value="layer3">三层（默认，最亮）</option>
                <option value="layer2">两层（省一点）</option>
                <option value="layer1">一层（最省，长文最稳）</option>
              </select>
            </div>
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
              <button type="button" class="menu_button yyx-debug">诊断信息</button>
            </div>
            <textarea class="yyx-debug-out" rows="7" readonly hidden placeholder="点「诊断信息」后在此显示当前设置与命中状态，可长按复制或截图发给作者"></textarea>
          </div>
        </div>`);
        $root.append($panel);

        // 插件总开关
        $panel.find('.yyx-enable').on('change', function () {
            settings.enabled = !!this.checked;
            onChange();
        });

        // 光晕渲染档位：三层/两层/一层。手机上长消息发光字太多时光栅化成本很高，
        // 文字越长越容易出现闪动，切到省一点的档位可以直接验证这一点。
        const $glowMode = $panel.find('.yyx-glowmode');
        $glowMode.val(settings.glowMode || 'layer3');
        $glowMode.on('change', function () {
            settings.glowMode = this.value;
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
            $btn.on('click', () => applyGradientStyle({ stops: p.stops, angle: 90, glow: true, strength: 100 }));
            $pres.append($btn);
        }

        $panel.find('.yyx-reset').on('click', resetAll);
        $panel.find('.yyx-repaint').on('click', () => { clearAllSpans(); scheduleRepaint(50); });
        // 诊断信息：把当前设置、消息标签命中、逐字 span 与内联光晕、配色表规则填到文本框，
        // 手机端无 F12 控制台也能直接截图/长按复制反馈。
        $panel.find('.yyx-debug').on('click', () => {
            const $out = $panel.find('.yyx-debug-out');
            const text = JSON.stringify(debugInfo(), null, 2);
            $out.val(text).prop('hidden', false);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => { /* 剪贴板不可用则保留在文本框 */ });
            }
        });
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
        // 逐字引擎：等待 chat 出现后启用观察器（增量染色 + 流式稳定门控），并做首次全量染色。
        let tries = 0;
        const t = setInterval(() => {
            const c = document.getElementById('chat');
            if (c) {
                clearInterval(t);
                chat.el = c;
                clearAllSpans();
                ensureObservers();
                // 直接连打几枪同步修复，而不是只排一个 50ms 的防抖：
                // 单一防抖如果撞上「消息还没布局（宽高为 0 被跳过）」，就会退化成
                // 「先看到渐变、过几秒才冒出光晕」的两段式观感。
                fastPaintBurst();
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
        lastSig = structSig();
        injectCss();
        clearAllSpans();
        registerEvents();
        try { window.__yyyx = { version: VERSION, debug: debugInfo, getSettings: () => settings }; } catch { /* 无 window 环境忽略 */ }
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
            colorAt, glowShadow, graphemes, stopsOf, sentenceSegments, quoteSegments, approxOf, streamDecl, buildStreamCss,
            gradientTextCss, glowFilter, targetDecl, buildColorCss, clearAllSpans,
            hexToRgb, rgbToHex, normHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex,
            collectText, applyMes, restoreMes, finalizeGroups, applyGradientStyle, paintStreamChunk, repaintAll,
            onChange, updateColorCss, reloadColorCss, scheduleColorReload, buildStreamCss, buildColorCss, debugInfo, snapshotState,
            structSig, finalizeFromDom, paintChars, restyleAll, needRebuild,
            _setSettingsForTest: (s) => { settings = s; rev = JSON.stringify(settings); lastSig = structSig(); },
            _getSettingsForTest: () => settings,
            _setStreamingForTest: (v) => { streaming = v; },
            _reinitChatForTest: () => { chat.el = document.getElementById('chat'); },
            _stopTimers: () => {
                if (uiTimerId) { clearInterval(uiTimerId); uiTimerId = null; }
                if (uiCapTimerId) { clearTimeout(uiCapTimerId); uiCapTimerId = null; }
                if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
                if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
                if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
                if (colorCssTimer) { clearTimeout(colorCssTimer); colorCssTimer = null; }
                if (restyleTimer) { clearTimeout(restyleTimer); restyleTimer = null; }
                if (flicker.raf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(flicker.raf); flicker.raf = null; }
                stopGuard();
                while (burstTimers.length) { clearTimeout(burstTimers.pop()); }
                while (snapTimers.length) { clearTimeout(snapTimers.pop()); }
            },
            _repairVisibleForTest: (tag) => repairVisible(tag),
            _mesNeedsPaintForTest: (m) => mesNeedsPaint(m),
            // v1.2.6 测试钩子：模拟「生成结束 → 解锁 → 唯一一次精确重建」的服务端流程
            _endStreamForTest: () => {
                streaming = false;
                stopGuard();
                if (repaintTimer) { clearTimeout(repaintTimer); repaintTimer = null; }
                clearStreamLocks();
                repaintAll();
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
