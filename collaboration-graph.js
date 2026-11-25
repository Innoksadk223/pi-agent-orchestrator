/* CollaborationGraph · 只读原生协作图
 * 复用现有 Dashboard 字体/状态 tokens；不连接 SSE、不读取通信正文、不派工。
 * 收边卡（状态竖条）＋ 定向涌动线（纯 CSS，无逐帧循环）；通信仅为新投递播放有限脉冲。
 * Hallmark · component: collaboration graph · genre: modern-minimal · theme: existing Cobalt
 */
(function (global) {
	"use strict";
	var SVG = "http://www.w3.org/2000/svg";
	var MAX_MESSAGES = 200, MAX_BURSTS = 8, RECENT_MS = 30000, BURST_MS = 2100;
	var CARD_H = 96, CARD_GAP = 128, LEADER_H = 146;
	/* 并行：共享主干上的车道（最多 5 条，间距 7px）与统一涌动周期 1450ms。 */
	var LANE_COUNT = 5, LANE_GAP = 7, FLOW_MS = 1450;
	/* 自适应：画布宽跟着容器走，缩放退居保底——只有画布宽被下限顶住、比容器还宽时才等比缩小；
	 * 0.75 是可读下限，再窄就让它横向滚动。 */
	var FIT_FLOOR = 0.75, FIT_MAX = 1, FIT_STEPS = 1000;
	/* 画布宽：非紧凑 clamp(容器内容宽, 640, 980)，紧凑 clamp(容器内容宽, 560, 820)。
	 * 紧凑下限 560 = 主卡 196 + 成员卡 168 的硬下限排得开的宽；再窄就整张图缩放，
	 * 缩放到底（0.75）还放不下才横向滚动。宽度未知（未挂载）时取上限，保持原样。 */
	var CANVAS_MIN = 640, CANVAS_MAX = 980, COMPACT_MIN = 560, COMPACT_MAX = 820;
	var ACTIVE = { STARTING: 1, RUNNING: 1, TOOL: 1, RETRY: 1 };
	/* 停止的席位默认不画在图上：它已不可继续执行，留着只是一排死卡。
	 * 重新派发会先进入 STARTING/RUNNING，于是自动重新出现。 */
	var HIDDEN = { STOPPED: 1 };
	var LABELS = { UNKNOWN: "未获取", APPROVED: "已授权", STARTING: "启动中", RUNNING: "运行中", TOOL: "工具中", IDLE: "空闲", SETTLED: "已完成", INTERRUPTED: "已中断", STOPPED: "已停止", ERROR: "错误", RETRY: "重试中", REPORT_INVALID: "格式错误" };
	var KINDS = { dispatch: "派发", steer: "引导", report: "回报", question: "提问", answer: "回答", message: "留言", request_answer: "应答" };
	var DELIVERY = { QUEUED: "排队", ACCEPTED: "已接受", DELIVERED: "已投递", SUBMITTED: "已提交", READY: "结果就绪", FAILED: "失败", CANCELED: "已取消", INTERRUPTED: "已中断", REPORT_INVALID: "格式错误" };
	var SENT = { ACCEPTED: true, DELIVERED: true, SUBMITTED: true, READY: true };
	/* 涌动：固定空间周期（dasharray 28+212=240px）与统一时长，所有路径速度一致，
	 * 相位由脚本写入的负 animation-delay 对齐到同一时钟；各层 dasharray 与 keyframes 的 240 周期必须同步。 */
	var CSS = `
.cg-root { --cg-paper:rgb(255 255 255 / .5); --cg-ink:var(--ink,#13211b); --cg-soft:var(--ink-soft,#3d5348); --cg-rule:var(--rule,rgb(20 60 45 / .14)); --cg-blue:var(--accent-ink,#12543a); --cg-warn:var(--warn-ink,#8a5a1e); --cg-red:var(--status-error-ink,#a33732); --cg-green:var(--status-settled-ink,#1d7a56); --cg-rail-idle:var(--status-idle-line,var(--cg-rule)); --cg-rail-run:var(--status-running-line,var(--cg-blue)); --cg-rail-warn:var(--status-starting-line,var(--cg-warn)); --cg-rail-error:var(--status-error-line,var(--cg-red)); --cg-rail-settled:var(--status-settled-line,var(--cg-green)); --cg-flow:var(--status-running-ink,var(--cg-blue)); --cg-ribbon:rgb(18 84 58 / .12); --cg-ribbon-live:rgb(18 84 58 / .34); position:relative; color:var(--cg-ink); font-family:var(--font-body,system-ui,sans-serif); min-width:0; border:1px solid rgb(255 255 255 / .6); border-radius:8px; overflow:hidden; }
.cg-root * { box-sizing:border-box; }
.cg-scroll { overflow:auto; overscroll-behavior:contain; height:100%; min-height:350px; max-height:76svh; scrollbar-color:var(--cg-rule) transparent; }
.cg-canvas { position:relative; margin-inline:auto; isolation:isolate; }
/* 适配层：canvas 用 transform 缩放，布局尺寸仍是原图；外层 frame 必须显式收成缩放后的宽高，
 * 否则滚动区按原尺寸计算，内容缩了、下面却留一大片空白。 */
.cg-frame { position:relative; margin-inline:auto; overflow:hidden; }
.cg-lines { position:absolute; inset:0; z-index:0; overflow:visible; pointer-events:none; }
.cg-node { position:absolute; z-index:2; display:flex; flex-direction:column; border:1px solid rgb(255 255 255 / .66); border-radius:8px; background:var(--cg-paper); -webkit-backdrop-filter:blur(18px) saturate(1.3); backdrop-filter:blur(18px) saturate(1.3); padding:12px 14px 12px 17px; color:var(--cg-ink); text-align:left; font:inherit; min-width:0; transition:border-color 140ms, background 140ms; }
button.cg-node { cursor:pointer; }
button.cg-node:hover { border-color:var(--cg-blue); }
button.cg-node:active { background:rgb(255 255 255 / .66); }
.cg-node:focus-visible { outline:3px solid var(--cg-blue); outline-offset:4px; }
.cg-rail { position:absolute; top:8px; bottom:8px; left:5px; width:4px; border-radius:2px; background:var(--cg-rail-idle); pointer-events:none; }
.cg-node[data-state="RUNNING"] .cg-rail,.cg-node[data-state="TOOL"] .cg-rail { background:var(--cg-rail-run); }
.cg-node[data-state="STARTING"] .cg-rail,.cg-node[data-state="RETRY"] .cg-rail,.cg-node[data-state="INTERRUPTED"] .cg-rail { background:var(--cg-rail-warn); }
.cg-node[data-state="ERROR"] .cg-rail { background:var(--cg-rail-error); }
.cg-node[data-state="SETTLED"] .cg-rail { background:var(--cg-rail-settled); }
.cg-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0; }
/* 卡片高度是固定值时，overflow:hidden 的文本行会被 flex 压成几像素高；行一律不许缩，
 * 装不下就把卡片加高（layout 里按 scrollHeight 量），而不是把字挤扁。 */
.cg-heading,.cg-role,.cg-stats,.cg-action { flex-shrink:0; }
.cg-name { font-size:15px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cg-role { color:var(--cg-soft); font-size:12px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cg-badge { flex-shrink:0; font-size:12px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--cg-soft); white-space:nowrap; }
.cg-badge[data-state="RUNNING"],.cg-badge[data-state="TOOL"] { color:var(--cg-blue); }
.cg-badge[data-state="STARTING"],.cg-badge[data-state="RETRY"],.cg-badge[data-state="INTERRUPTED"] { color:var(--cg-warn); }
.cg-badge[data-state="ERROR"] { color:var(--cg-red); }
.cg-badge[data-state="SETTLED"] { color:var(--cg-green); }
.cg-action { margin-top:auto; padding-top:8px; border-top:1px solid var(--cg-rule); font-size:12px; color:var(--cg-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cg-node[aria-pressed="true"] { border-color:var(--cg-blue); background:rgb(255 255 255 / .7); }
.cg-node[data-leader="true"] { padding:16px 18px; border-color:rgb(255 255 255 / .24); color:#fff; background:linear-gradient(165deg,rgb(22 80 60 / .97) 0%,rgb(13 58 43 / .97) 100%); }
/* 窄画布里名字（88px）不该被 33px 的状态徽标挤成省略号：让徽标换到下一行。 */
.cg-node[data-leader="true"] .cg-heading { flex-wrap:wrap; }
.cg-node[data-leader="true"] .cg-name { font-size:19px; color:#fff; }
.cg-node[data-leader="true"] .cg-role { color:rgb(255 255 255 / .72); margin-top:4px; }
.cg-node[data-leader="true"] .cg-badge { color:rgb(255 255 255 / .84); }
.cg-node[data-leader="true"] .cg-action { color:rgb(255 255 255 / .88); border-top-color:rgb(255 255 255 / .2); }
.cg-stats { display:flex; flex-wrap:wrap; gap:14px; margin-top:10px; font-family:var(--font-mono,ui-monospace); font-size:11px; color:rgb(255 255 255 / .72); }
.cg-stat { display:flex; flex:0 0 auto; gap:4px; align-items:baseline; white-space:nowrap; }
.cg-stat b { font-weight:650; font-size:13px; color:#fff; font-variant-numeric:tabular-nums; }
.cg-team { position:absolute; font-size:12px; font-weight:650; color:var(--cg-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* 归属光带：4px 半透明带，与关系线及流光共轨，两端由脚本按自身走向渐隐。 */
.cg-ribbon { fill:none; stroke:var(--cg-ribbon); stroke-width:4; stroke-linecap:round; stroke-linejoin:round; }
.cg-ribbon[data-live="true"] { stroke:var(--cg-ribbon-live); stroke-width:4; }
.cg-edge { stroke:var(--cg-blue); stroke-width:1.1; stroke-linecap:round; stroke-linejoin:round; fill:none; }
.cg-edge[data-status="QUEUED"] { stroke:var(--cg-warn); stroke-dasharray:5 5; }
.cg-edge[data-status="FAILED"] { stroke:var(--cg-red); }
.cg-edge[data-status="CANCELED"],.cg-edge[data-status="INTERRUPTED"] { stroke:var(--cg-soft); stroke-dasharray:3 5; }
/* 涌动：借鉴 uiverse.io/loaders/G27XLEO_spotty-chipmunk-84.html 双层同轨光点微晕、
 * uiverse.io/loaders/Z4drus_cowardly-deer-31.html 短脉冲同轴滑行轨迹与
 * uiverse.io/loaders/PhilibertGentien_smart-pug-99.html 渐变弧段结构。
 * 三层共享 240px 空间周期与 1450ms 统一时长，相位由负 animation-delay 对齐到同一时钟；
 * 柔光层（12+228）与白瓷头粒子（2+238）分别前移 16px / 26px 精准锁定在 28px 主流光前端。 */
.cg-flow-glow { fill:none; stroke:var(--cg-flow); stroke-width:5.8; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:12 228; stroke-dashoffset:224; stroke-opacity:0; }
.cg-flow { fill:none; stroke:var(--cg-flow); stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:28 212; stroke-dashoffset:0; stroke-opacity:0; }
.cg-flow-head { fill:none; stroke:var(--cg-flow); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:2 238; stroke-dashoffset:214; stroke-opacity:0; }
.cg-flow[data-active="true"] { stroke-opacity:.82; animation:cg-wave 1450ms linear infinite; }
.cg-flow-glow[data-active="true"] { stroke-opacity:.2; animation:cg-wave-glow 1450ms linear infinite; }
.cg-flow-head[data-active="true"] { stroke-opacity:.96; animation:cg-wave-head 1450ms linear infinite; }
.cg-flow[data-burst="true"] { stroke-width:3; stroke-opacity:1; animation:cg-wave 480ms linear 3; }
.cg-flow-glow[data-burst="true"] { stroke-width:5.8; stroke-opacity:.3; animation:cg-wave-glow 480ms linear 3; }
.cg-flow-head[data-burst="true"] { stroke-width:3.6; stroke-opacity:1; animation:cg-wave-head 480ms linear 3; }
.cg-flow[data-muted="true"],.cg-flow-glow[data-muted="true"],.cg-flow-head[data-muted="true"] { stroke-opacity:0; }
.cg-root[data-motion="off"] .cg-flow,.cg-root[data-motion="off"] .cg-flow-glow,.cg-root[data-motion="off"] .cg-flow-head { animation:none; stroke-opacity:0; }
@keyframes cg-wave { from { stroke-dashoffset:240; } to { stroke-dashoffset:0; } }
@keyframes cg-wave-glow { from { stroke-dashoffset:224; } to { stroke-dashoffset:-16; } }
@keyframes cg-wave-head { from { stroke-dashoffset:214; } to { stroke-dashoffset:-26; } }
/* 端子收到 0：光带直接贴到卡边，卡缘不再挂圆点。 */
.cg-port { r:0; fill:var(--cg-paper); stroke:var(--cg-ribbon-live); stroke-width:1.25; }
.cg-port[data-live="true"] { fill:var(--cg-flow); stroke:var(--cg-flow); }
/* 方向交给涌动本身；箭头元素留着承载状态色，只是不画出来。 */
.cg-arrow { fill:var(--cg-blue); visibility:hidden; }
.cg-arrow[data-status="QUEUED"] { fill:var(--cg-warn); }
.cg-arrow[data-status="FAILED"] { fill:var(--cg-red); }
.cg-arrow[data-status="CANCELED"],.cg-arrow[data-status="INTERRUPTED"] { fill:var(--cg-soft); }
/* 标签不再是胶囊：无边框小字压在一道径向软晕上，线经过字时被吃掉，既不断字也不露框。 */
.cg-edge-label { position:absolute; z-index:3; padding:0 12px; background:radial-gradient(150% 130% at 50% 50%, rgb(10 11 14 / 0.92) 34%, rgb(10 11 14 / 0) 100%); border:0; border-radius:0; color:var(--cg-blue); font-size:11px; line-height:1.45; white-space:nowrap; pointer-events:none; }
.cg-edge-label[data-status="QUEUED"] { color:var(--cg-warn); }
.cg-edge-label[data-status="FAILED"] { color:var(--cg-red); }
.cg-ribbon[data-muted="true"],.cg-edge[data-muted="true"],.cg-arrow[data-muted="true"],.cg-port[data-muted="true"] { opacity:.15; }
.cg-ribbon[data-hidden="true"] { stroke-opacity:0; }
.cg-root [data-secondary="true"] { opacity:.72; }
.cg-root .cg-port[data-hidden="true"] { opacity:0; }
.cg-edge-label[data-muted="true"] { opacity:.25; }
.cg-legend { display:flex; align-items:center; flex-wrap:wrap; gap:10px 18px; padding:11px 16px; border-top:1px solid var(--cg-rule); background:var(--cg-paper); font-size:12px; color:var(--cg-soft); }
.cg-legend span { display:flex; gap:6px; align-items:center; }
.cg-legend i { display:inline-block; width:22px; height:0; border-top:2px solid var(--cg-rule); }
.cg-legend .cg-legend-base { border-top:0; height:3px; border-radius:2px; background:linear-gradient(90deg,transparent,var(--cg-ribbon-live) 50%,transparent); }
.cg-legend .cg-legend-flow { border-top-width:0; height:3px; border-radius:2px; background:linear-gradient(90deg,transparent,var(--cg-flow) 50%,transparent); }
.cg-legend .cg-legend-message { border-top-width:1.5px; border-color:var(--cg-blue); }
.cg-legend .cg-legend-queued { border-color:var(--cg-warn); border-top-style:dashed; }
.cg-legend .cg-legend-failed { border-color:var(--cg-red); }
.cg-hidden { color:var(--cg-soft); }
.cg-offline { margin-left:auto; color:var(--cg-warn); }
.cg-empty { position:absolute; color:var(--cg-soft); font-size:14px; padding:18px; }
@media(prefers-reduced-motion:reduce) { .cg-node { transition:none; } .cg-flow,.cg-flow-glow,.cg-flow-head { animation:none; stroke-opacity:0; } }
`;

	function status(value) {
		var key = String(value || "UNKNOWN").toUpperCase().split(" · ")[0];
		if (key.indexOf("RETRY") === 0) return "RETRY";
		return LABELS[key] ? key : "UNKNOWN";
	}
	function text(value, limit) { return String(value == null ? "" : value).slice(0, limit || 160); }
	/* 同伴连线：两端都在卡片右缘，控制点统一向右撑开，读作向外让出的一条弧。 */
	function bulgeData(a, b, bulge) {
		return "M" + a[0] + " " + a[1] + " C" + (a[0] + bulge) + " " + a[1] + " " + (b[0] + bulge) + " " + b[1] + " " + b[0] + " " + b[1];
	}
	function bulgeAt(a, b, bulge, t) {
		var c1 = [a[0] + bulge, a[1]], c2 = [b[0] + bulge, b[1]], mt = 1 - t;
		return [mt * mt * mt * a[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * b[0], mt * mt * mt * a[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * b[1]];
	}
	/* 箭头按真实切线画，使用小巧锐利的燕尾窄角箭头，竖向同伴连线也能指对方向。 */
	function arrowMarks(tip, near) {
		var ux = tip[0] - near[0], uy = tip[1] - near[1], len = Math.sqrt(ux * ux + uy * uy) || 1;
		ux /= len; uy /= len;
		var bx = tip[0] - ux * 7.2, by = tip[1] - uy * 7.2, nx = tip[0] - ux * 5.2, ny = tip[1] - uy * 5.2, px = -uy * 2.8, py = ux * 2.8;
		return tip[0].toFixed(1) + "," + tip[1].toFixed(1) + " " + (bx + px).toFixed(1) + "," + (by + py).toFixed(1) + " " + nx.toFixed(1) + "," + ny.toFixed(1) + " " + (bx - px).toFixed(1) + "," + (by - py).toFixed(1);
	}
	/* 同轴 S 型水平切线三次贝塞尔：C1 = [a.x + reach * dir, a.y], C2 = [b.x - reach * dir, b.y]，
	 * 两端严格水平切线进出卡片，C1 连续无反弓扭曲。 */
	function curveReach(a, b) { return Math.max(48, Math.abs(b[0] - a[0]) * 0.48); }
	function curveDirection(a, b) { return b[0] >= a[0] ? 1 : -1; }
	function curveData(a, b) {
		var dir = curveDirection(a, b), reach = curveReach(a, b);
		return "M" + a[0] + " " + a[1] + " C" + (a[0] + reach * dir) + " " + a[1] + " " + (b[0] - reach * dir) + " " + b[1] + " " + b[0] + " " + b[1];
	}
	function cubicAt(a, b, t) {
		var dir = curveDirection(a, b), reach = curveReach(a, b), c1 = [a[0] + reach * dir, a[1]], c2 = [b[0] - reach * dir, b[1]], mt = 1 - t;
		return [mt * mt * mt * a[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * b[0], mt * mt * mt * a[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * b[1]];
	}
	/* 归属底轨与通信轨同轴同曲线（stroke 描边），以 M <startX> <startY> 开头，不再另画偏移轮廓。 */
	function ribbonData(a, b) {
		return curveData(a, b);
	}
	/* 沿弦渐隐：光带两端各收 26px，线在卡边不会一刀截断。用的是 mask，不改几何、不改 stroke，
	 * 所以 d 与状态配色都原样；角度按两端连线取，陡峭的长弧中段才不会被横向遮罩吃掉。
	 * 收边距离取定值而不是百分比：短线上按百分比扣会扣掉一大半，看起来像没接到卡片。 */
	function taperMask(a, b) {
		var dx = b[0] - a[0], dy = b[1] - a[1];
		var chord = Math.sqrt(dx * dx + dy * dy);
		if (!chord || !isFinite(chord)) return "";
		var pct = Math.max(8, Math.min(26, Math.round(2600 / chord)));
		var deg = Math.atan2(dx, -dy) * 180 / Math.PI;
		return "linear-gradient(" + deg.toFixed(1) + "deg, transparent 0%, #000 " + pct + "%, #000 " + (100 - pct) + "%, transparent 100%)";
	}
	function applyTaper(element, a, b) {
		if (!element || !element.style) return;
		var mask = taperMask(a, b);
		if (!mask) return;
		element.style.maskImage = mask;
		element.style.webkitMaskImage = mask;
	}

	/* 纯函数：输入容器宽与未缩放的图宽，输出 clamp(容器宽 / 图宽, 0.75, 1)，无副作用。
	 * 比值向下取到三位小数：亚像素没看得出的差别，却会让「图宽×k」堪堪越过容器，
	 * 白白多出一条横向滚动条；向下取整则保证永远不超。画布宽随容器收窄后，只有画布被
	 * 下限顶住（容器比 560/640 还窄）时才会小于 1。 */
	function fitScale(containerWidth, canvasWidth) {
		var box = Number(containerWidth), canvas = Number(canvasWidth);
		if (!(box > 0) || !(canvas > 0)) return FIT_MAX;
		var exact = Math.floor((box / canvas) * FIT_STEPS) / FIT_STEPS;
		return Math.min(FIT_MAX, Math.max(FIT_FLOOR, exact));
	}

	/* 纯函数：容器内容宽 → 画布宽。宽度跟着容器走，所以半屏时不需要靠缩放去「塞」。
	 * 宽度未知（0/NaN）时给上限：未挂载的图先按原尺寸排，挂载后由 ResizeObserver 重算。 */
	function canvasWidth(containerWidth, compact) {
		var box = Number(containerWidth), min = compact ? COMPACT_MIN : CANVAS_MIN, max = compact ? COMPACT_MAX : CANVAS_MAX;
		if (!(box > 0) || !isFinite(box)) return max;
		return Math.min(max, Math.max(min, Math.floor(box)));
	}

	/* 纯函数：画布宽 → 各列坐标。参考原图 980 宽下的 主卡 28/236、主干 340、成员列 420/278，
	 * 以及紧凑 820 宽下的 主卡 28/196、主干 240、成员列 320/250：先按画布宽等比分配，
	 * 再把两个下限当硬约束套上去：主卡 ≥196（「主 Agent」+ 三个计数一行排得下的实测宽），
	 * 成员卡 ≥168（名字 + 状态徽标 + 两侧内边距）。画布 ≥560 时任何百分比都不能把它们算小，
	 * 挤不下就先收窄带宽、把成员列左移，而不是缩卡片。
	 * 不变式：leaderRight < memberX，memberRight = memberX + memberW ≤ width - 12。 */
	function graphMetrics(width, compact) {
		var w = Number(width) > 0 ? Math.round(Number(width)) : (compact ? COMPACT_MAX : CANVAS_MAX);
		var base = compact ? COMPACT_MAX : CANVAS_MAX;
		var padL = Math.max(12, Math.round(w * 28 / base));
		var leadMax = compact ? 196 : 236, leadFloor = 196;
		var leaderW = Math.min(leadMax, Math.max(leadFloor, Math.round(w * leadMax / base)));
		/* 两列之间的带宽是标签的家：紧凑布局留 64px，挤不下时先牺牲它（最低 16px）。 */
		var gap = compact ? Math.min(64, Math.max(16, Math.round(w * 0.075))) : 40;
		var memberX = Math.max(Math.round(w * (compact ? 320 : 420) / base), padL + leaderW + gap);
		var memberW = Math.max(168, Math.round(w * (compact ? 250 : 278) / base));
		/* 硬下限不让步：放不下就把成员列整体左移，最后才由画布宽的下限（560/640）兑底。 */
		if (memberX + memberW > w - 12) memberX = Math.max(padL + leaderW + 16, w - 12 - memberW);
		var lowTrunk = padL + leaderW + 16, highTrunk = memberX - 12, target = memberX - Math.round(w * 80 / base);
		var trunk = highTrunk <= lowTrunk ? highTrunk : Math.min(highTrunk, Math.max(lowTrunk, target));
		return { width: w, leaderX: padL, leaderW: leaderW, leaderRight: padL + leaderW, memberX: memberX, memberW: memberW, memberRight: memberX + memberW, trunk: trunk };
	}

	function create(root, options) {
		if (!root || typeof root.appendChild !== "function") throw new TypeError("CollaborationGraph.create 需要根节点");
		var opts = options || {}, doc = root.ownerDocument || global.document;
		var now = opts.now || function () { return Date.now(); };
		var timeout = opts.setTimer || global.setTimeout.bind(global), cancelTimeout = opts.clearTimer || global.clearTimeout.bind(global);
		var nodes = new Map(), messages = new Map(), edges = new Map(), seen = new Set(), bursts = new Map();
		var selected = null, visible = true, connected = true, destroyed = false, expiry = null;
		var leader = { status: "UNKNOWN", tools: [] }, layoutKey = "", geometry = null, statsKey = "", fit = { scale: 1, width: 0, height: 0 };
		var lanes = new Map(), laneSig = "", hiddenCount = 0, hiddenTeams = new Map();
		var mql = typeof global.matchMedia === "function" ? global.matchMedia("(prefers-reduced-motion: reduce)") : null;
		var motion = opts.reducedMotion === undefined ? !(mql && mql.matches) : !opts.reducedMotion;

		function el(tag, cls, content) { var n = doc.createElement(tag); if (cls) n.className = cls; if (content != null) n.textContent = content; return n; }
		function svg(tag, cls) { var n = doc.createElementNS(SVG, tag); if (cls) n.setAttribute("class", cls); return n; }
		var shell = el("section", "cg-root"), style = el("style"), scroll = el("div", "cg-scroll"), frame = el("div", "cg-frame"), canvas = el("div", "cg-canvas"), lines = svg("svg", "cg-lines");
		/* uiverse.io/loaders/G27XLEO_spotty-chipmunk-84.html 柔光模糊滤镜，纯中性白瓷光晕；
		 * 使用 userSpaceOnUse 并在 layout() 同步画布包围区域，防止严格水平路径（height===0）在浏览器中被 objectBoundingBox 裁为空图。 */
		var defs = svg("defs"), glowFilter = svg("filter"), glowBlur = svg("feGaussianBlur");
		glowFilter.setAttribute("id", "cg-platinum-glow");
		glowFilter.setAttribute("filterUnits", "userSpaceOnUse");
		glowFilter.setAttribute("x", "-24"); glowFilter.setAttribute("y", "-24");
		glowFilter.setAttribute("width", "1028"); glowFilter.setAttribute("height", "488");
		glowBlur.setAttribute("stdDeviation", "1.6");
		glowFilter.appendChild(glowBlur); defs.appendChild(glowFilter); lines.appendChild(defs);
		/* 九层固定分组：节点层（归属轨/锚点 → 柔光晕 → 常驻流光 → 头粒子）与边层（通信关系 → 脉冲柔光 → 脉冲主束 → 脉冲头粒子 → 箭头）分离，重排不误删边脉冲。 */
		var gBases = svg("g", "cg-layer"), gFlowGlows = svg("g", "cg-layer"), gFlows = svg("g", "cg-layer"), gFlowHeads = svg("g", "cg-layer"), gEdges = svg("g", "cg-layer"), gBurstGlows = svg("g", "cg-layer"), gBursts = svg("g", "cg-layer"), gBurstHeads = svg("g", "cg-layer"), gHeads = svg("g", "cg-layer");
		gFlowGlows.setAttribute("filter", "url(#cg-platinum-glow)");
		gBurstGlows.setAttribute("filter", "url(#cg-platinum-glow)");
		[gBases, gFlowGlows, gFlows, gFlowHeads, gEdges, gBurstGlows, gBursts, gBurstHeads, gHeads].forEach(function (g) { lines.appendChild(g); });
		function clearGroup(g) { while (g.firstChild) g.firstChild.remove(); }
		style.nonce = opts.nonce || (doc.currentScript && doc.currentScript.nonce) || "";
		style.textContent = CSS;
		shell.setAttribute("aria-label", "Agent 协作图");
		scroll.setAttribute("tabindex", "0"); scroll.setAttribute("aria-label", "协作图画布，可上下左右滚动");
		lines.setAttribute("aria-hidden", "true");
		canvas.appendChild(lines); frame.appendChild(canvas); scroll.appendChild(frame); shell.appendChild(style); shell.appendChild(scroll);
		var legend = el("div", "cg-legend"), offline = el("span", "cg-offline"), hiddenNote = el("span", "cg-hidden");
		[['cg-legend-base', "归属"], ["cg-legend-flow", "活动"], ["cg-legend-message", "真实通信"], ["cg-legend-queued", "排队"], ["cg-legend-failed", "失败"]].forEach(function (item) { var span = el("span"); span.appendChild(el("i", item[0])); span.appendChild(el("span", "", item[1])); legend.appendChild(span); });
		legend.appendChild(hiddenNote); legend.appendChild(offline); shell.appendChild(legend); root.appendChild(shell);

		function makeNode(key, isLeader) {
			var button = el(isLeader ? "div" : "button", "cg-node"), heading = el("div", "cg-heading"), name = el("span", "cg-name"), badge = el("span", "cg-badge"), role = el("div", "cg-role"), action = el("div", "cg-action");
			heading.appendChild(name); heading.appendChild(badge); button.appendChild(heading); button.appendChild(role);
			var rail = null, stats = null, statValues = [];
			if (isLeader) {
				stats = el("div", "cg-stats");
				[["成员", "0"], ["进行中", "0"], ["排队", "0"]].forEach(function (pair) {
					var item = el("span", "cg-stat"), value = el("b", "", pair[1]);
					item.appendChild(value); item.appendChild(el("span", "", pair[0]));
					stats.appendChild(item); statValues.push(value);
				});
				button.appendChild(stats);
			} else { rail = el("span", "cg-rail"); rail.setAttribute("aria-hidden", "true"); button.appendChild(rail); }
			button.appendChild(action);
			button.dataset.leader = String(isLeader);
			button.dataset.key = key;
			if (!isLeader) { button.type = "button"; button.setAttribute("aria-pressed", "false"); button.addEventListener("click", function () { setSelected(key); if (opts.onSelect) opts.onSelect(key); }); }
			canvas.appendChild(button);
			return { key: key, element: button, name: name, badge: badge, role: role, action: action, rail: rail, stats: stats, statValues: statValues, raw: {}, box: null, bases: [], ports: [], flow: null, flowGlow: null, flowHead: null };
		}
		var main = makeNode("@leader", true), empty = el("div", "cg-empty", "暂无成员。注册团队后在此显示。");
		canvas.appendChild(empty);
		var headings = [];

		function setBadge(n, value) { var s = status(value); n.badge.textContent = LABELS[s]; n.badge.dataset.state = s; n.element.dataset.state = s; return s; }
		function isActive(n) { return ACTIVE[n.element.dataset.state] === 1; }
		function actionFor(raw, s) {
			var comm = raw.communication;
			if (comm && comm.active) return "回答同伴" + (comm.label && comm.label !== "回答同伴" ? " · " + text(comm.label, 40) : "") + (comm.detail && /^工具|执行工具/.test(comm.label) ? " · " + text(comm.detail, 40) : "");
			if (s === "STARTING") return "准备成员会话";
			if (s === "ERROR") return "本轮运行出错";
			if (s === "STOPPED" || s === "INTERRUPTED") return raw.control && raw.control.canResume ? "手动暂停，等待继续" : "本轮已中断";
			if (s === "APPROVED") return "已授权，尚未开工";
			if (s === "IDLE" || s === "SETTLED") return "当前无活动任务";
			if (s === "UNKNOWN") return "暂无实时状态";
			if (s === "RETRY") return "自动重试中";
			if (raw.action) return text(raw.action, 96);
			var activities = raw.activities || (raw.state && raw.state.activities) || [];
			var phases = ["思考中", "执行工具", "工具完成", "工具失败", "压缩上下文"];
			for (var i = activities.length - 1; i >= 0; i--) { var a = activities[i]; if (phases.indexOf(a.label) >= 0) return text(a.label + (a.detail && /^工具|执行工具/.test(a.label) ? " · " + a.detail : ""), 96); }
			return "等待阶段事件";
		}
		function updateNode(n, raw) {
			n.raw = raw;
			n.name.textContent = text(raw.id || raw.name, 100);
			n.role.textContent = text(raw.role || "团队成员", 180);
			var s = setBadge(n, raw.communication && raw.communication.active ? raw.communication.status : raw.status || (raw.state && raw.state.status));
			n.action.textContent = actionFor(raw, s); n.action.title = n.action.textContent; n.name.title = n.name.textContent; n.role.title = n.role.textContent;
			n.element.setAttribute("aria-label", n.name.textContent + "，" + LABELS[s] + "，" + n.action.textContent + "，展开详情");
		}
		function renderStats() {
			var active = 0, queued = 0;
			nodes.forEach(function (n) { if (isActive(n)) active++; });
			messages.forEach(function (m) { if (m.status === "QUEUED") queued++; });
			var key = (nodes.size + hiddenCount) + "/" + active + "/" + queued;
			if (key === statsKey || !main.statValues.length) return;
			statsKey = key;
			main.statValues[0].textContent = String(nodes.size + hiddenCount);
			main.statValues[1].textContent = String(active);
			main.statValues[2].textContent = String(queued);
		}
		function renderLeader() {
			main.name.textContent = "主 Agent"; main.role.textContent = "主会话 · 团队调度与回报";
			var s = setBadge(main, connected ? leader.status : "UNKNOWN");
			main.action.textContent = !connected ? "连接中断，等待快照恢复" : s === "TOOL" ? "工具 · " + ((leader.tools || []).slice(0, 2).map(function (t) { return text(t, 30); }).join(" / ") || "执行中") : s === "RUNNING" ? "处理当前回合" : s === "IDLE" ? "等待下一步" : "暂无主会话状态";
			main.action.title = main.action.textContent;
			offline.textContent = !connected ? "断连 · 动效已停止" : "";
			renderStats();
		}
		function setBox(n, x, y, width, height) { n.box = { x: x, y: y, width: width, height: height }; Object.assign(n.element.style, { left: x + "px", top: y + "px", width: width + "px", height: height + "px" }); }
		/* 内容高：scrollHeight 含内边距但不含边框，而 setBox 写的是 border-box 高，补回 2px；
		 * 量不到（未挂载、假 DOM）时退回给定高度，不会凭空长高。 */
		function contentHeight(element, fallback) {
			var value = Math.ceil(Number(element.scrollHeight) || 0);
			return value > 0 ? value + 2 : fallback;
		}
		/* 主卡内容（名字、角色、三项计数、动作）在窄画布里会换成多行：内容超过已有高度时
		 * 要重排一次把卡片长高，否则那几行只能靠压缩自己挤进固定高度。 */
		function leaderOverflow() {
			return !!main.box && contentHeight(main.element, LEADER_H) > main.box.height + 0.5;
		}
		/* 量的是滚动区的内容宽：root 上那 1px 边框不算画布空间，拿 root.clientWidth 当图宽会让
		 * 缩放后仍差出 2px，平白留一条横向滚动条；未挂载（宽 0）时回退到 root。 */
		function viewportWidth() { return scroll.clientWidth || root.clientWidth || 0; }
		/* 缩放只作用在同时装着节点与线条的 canvas 上（origin 左上），节点、线条、标签都还在
		 * 未缩放的坐标系里布点；transform 不改布局，所以 frame 要显式拿到缩放后的宽高。 */
		function applyFit() {
			if (!geometry) return;
			var scale = fitScale(viewportWidth(), geometry.width);
			var width = geometry.width * scale, height = geometry.height * scale;
			if (scale === fit.scale && width === fit.width && height === fit.height) return;
			fit = { scale: scale, width: width, height: height };
			canvas.style.transformOrigin = "0 0";
			canvas.style.transform = "scale(" + scale + ")";
			frame.style.width = width + "px";
			frame.style.height = height + "px";
			shell.dataset.scale = String(scale);
		}
		function layout(force) {
			/* compact 断点只看未缩放的容器宽度：缩放不该改变「窄了就收紧列宽」这件事。 */
			var compact = (root.clientWidth || 1000) < 640;
			/* 画布宽跟着容器走：同一批成员换到别的容器宽要重新分配列宽，所以宽度进 layoutKey；
			 * 容器没变时仍然命中缓存，只重算缩放，不重建节点与线条。 */
			var width = canvasWidth(viewportWidth() || root.clientWidth, compact), box = graphMetrics(width, compact);
			var key = (compact ? "s" : "l") + width + Array.from(nodes.keys()).join("\u0001");
			/* 成员与画布宽都没变时 layoutKey 命中，只重算缩放，不重建节点与线条；
			 * 只有主卡内容偷偷长高（计数换行）时补一次重排。 */
			if (!force && key === layoutKey && !leaderOverflow()) { applyFit(); return; }
			layoutKey = key; stopBursts();
			headings.forEach(function (h) { h.remove(); }); headings = [];
			var memberX = box.memberX, memberW = box.memberW, groups = new Map(), y = 24, firstY = null, lastY = null, placed = 0;
			nodes.forEach(function (n) { var team = n.raw.team || "default"; if (!groups.has(team)) groups.set(team, []); groups.get(team).push(n); });
			groups.forEach(function (list, team) {
				var h = el("div", "cg-team", text(team, 100) + " · " + (list.length + (hiddenTeams.get(team) || 0)) + " 位成员");
				Object.assign(h.style, { left: memberX + "px", top: y + "px", width: memberW + "px" });
				canvas.appendChild(h); headings.push(h); y += 34;
				list.forEach(function (n) {
					if (firstY == null) firstY = y;
					/* 主 Agent 只对齐整张图最前 4 位成员，跨团队时不会随最后一个团队下漂。 */
					if (placed < 4) lastY = y + CARD_H;
					placed++;
					setBox(n, memberX, y, memberW, CARD_H); y += CARD_GAP;
				});
				y += 10;
			});
			var height = Math.max(440, y + 12);
			/* 主 Agent 垂直居中于最前 4 位成员，并夹在可视上沿附近，长名单下不滚出视野。 */
			var leaderY = firstY == null ? 148 : Math.min(320, Math.max(24, (firstY + lastY) / 2 - LEADER_H / 2));
			setBox(main, box.leaderX, leaderY, box.leaderW, LEADER_H);
			/* 先按常规高度排一次拿到真实宽度，再量内容：窄画布里三行计数、角色、动作加起来会超过 146，
			 * 那就把主卡加高并重新居中，而不是让那几行被压成 4px 高的条。 */
			var leaderH = Math.max(LEADER_H, contentHeight(main.element, LEADER_H));
			if (leaderH !== LEADER_H) {
				leaderY = firstY == null ? 148 : Math.min(320, Math.max(24, (firstY + lastY) / 2 - leaderH / 2));
				setBox(main, box.leaderX, leaderY, box.leaderW, leaderH);
			}
			geometry = { width: width, height: height, memberX: memberX, memberRight: box.memberRight, leaderRight: box.leaderRight, trunk: box.trunk };
			canvas.style.width = geometry.width + "px"; canvas.style.height = height + "px";
			lines.setAttribute("width", String(geometry.width)); lines.setAttribute("height", String(height));
			lines.setAttribute("viewBox", "0 0 " + geometry.width + " " + height);
			glowFilter.setAttribute("x", "-24"); glowFilter.setAttribute("y", "-24");
			glowFilter.setAttribute("width", String(geometry.width + 48)); glowFilter.setAttribute("height", String(height + 48));
			Object.assign(empty.style, { left: memberX + "px", top: "60px" });
			clearGroup(gBases); clearGroup(gFlowGlows); clearGroup(gFlows); clearGroup(gFlowHeads);
			nodes.forEach(function (n) { n.bases = []; n.ports = []; n.flow = null; n.flowGlow = null; n.flowHead = null; });
			applyLanes();
			nodes.forEach(function (n, nodeKey) { buildNode(nodeKey, n); paintNode(nodeKey, n); });
			renderEdges(); syncFlows(); applySelection();
			applyFit();
		}
		/* 车道：活跃成员先占互不相同的车道，空闲成员回落到按名册序的稳定车道。 */
		function applyLanes() {
			var next = new Map(), actives = [], others = [];
			nodes.forEach(function (n, key) { (isActive(n) ? actives : others).push(key); });
			actives.forEach(function (key, i) { next.set(key, i % LANE_COUNT); });
			others.forEach(function (key, i) { next.set(key, (i + actives.length) % LANE_COUNT); });
			var sig = "";
			next.forEach(function (value, key) { sig += key + ":" + value + "|"; });
			if (sig === laneSig) return false;
			laneSig = sig; lanes = next; return true;
		}
		/* 车道向曲线控制点与起点做小幅偏移，几条丝带在主干处分开而不是叠成一捆。 */
		/* 主 Agent 卡右缘的锚点：按成员顺序均分卡高，并行成员各有自己的交点；
		 * 只有一名成员时仍取正中，避免单线看着偏斜。 */
		function leaderAnchor(key) {
			if (!main.box) return null;
			var keys = Array.from(nodes.keys()), index = keys.indexOf(key), count = keys.length;
			if (index < 0) return null;
			var pad = 16, span = main.box.height - pad * 2;
			return main.box.y + pad + (count <= 1 ? span / 2 : (span * index) / (count - 1));
		}
		function laneShift(key) {
			var index = lanes.get(key);
			return ((index == null ? 2 : index) - 2) * LANE_GAP;
		}
		function buildNode(key, n) {
			if (n.flow) return;
			n.base = svg("path", "cg-ribbon"); n.base.dataset.key = key;
			n.portStart = svg("circle", "cg-port"); n.portStart.setAttribute("r", "2.2"); n.portStart.dataset.key = key;
			n.portEnd = svg("circle", "cg-port"); n.portEnd.setAttribute("r", "2.2"); n.portEnd.dataset.key = key;
			n.bases = [n.base];
			n.ports = [n.portStart, n.portEnd];
			n.flowGlow = svg("path", "cg-flow-glow"); n.flowGlow.dataset.key = key;
			n.flow = svg("path", "cg-flow"); n.flow.dataset.key = key;
			n.flowHead = svg("path", "cg-flow-head"); n.flowHead.dataset.key = key;
			gBases.appendChild(n.base); gBases.appendChild(n.portStart); gBases.appendChild(n.portEnd);
			gFlowGlows.appendChild(n.flowGlow); gFlows.appendChild(n.flow); gFlowHeads.appendChild(n.flowHead);
		}
		function paintNode(key, n) {
			if (!n.flow || !geometry) return;
			var points = route("@leader", key, 0);
			if (!points) return;
			var a = points[0], b = points[points.length - 1];
			var d = ribbonData(a, b);
			n.base.setAttribute("d", d);
			applyTaper(n.base, a, b);
			n.flowGlow.setAttribute("d", d);
			n.flow.setAttribute("d", d);
			n.flowHead.setAttribute("d", d);
			n.portStart.setAttribute("cx", String(a[0])); n.portStart.setAttribute("cy", String(a[1]));
			n.portEnd.setAttribute("cx", String(b[0])); n.portEnd.setAttribute("cy", String(b[1]));
		}
		function route(from, to, lane) {
			var a = from === "@leader" ? main : nodes.get(from), b = to === "@leader" ? main : nodes.get(to);
			if (!a || !b || !a.box || !b.box) return null;
			var ab = a.box, bb = b.box, ay = ab.y + ab.height / 2, by = bb.y + bb.height / 2;
			/* 主从沿用各自在主卡右缘的独立锚点（leaderAnchor）与成员左缘中点（by），两端水平切线进出。 */
			if (from === "@leader") { var x = geometry.trunk + laneShift(to), sy = leaderAnchor(to) ?? ay; return [[ab.x + ab.width, sy], [x, sy], [x, by], [bb.x, by]]; }
			if (to === "@leader") { var rx = geometry.trunk - 22 - laneShift(from), ty = leaderAnchor(from) ?? by; return [[ab.x, ay], [rx, ay], [rx, by], [bb.x + bb.width, ty]]; }
			/* 同伴：只给两端卡片右缘，曲率由 bulgeData 向外撑开。 */
			return [[ab.x + ab.width, ay + 12], [bb.x + bb.width, by - 12]];
		}
		/* 同伴车道按无序对哈希固定，不受消息顺序/过期影响。 */
		function pairLane(from, to) {
			var pair = from < to ? from + "|" + to : to + "|" + from, hash = 0;
			for (var i = 0; i < pair.length; i++) hash = (hash * 31 + pair.charCodeAt(i)) % 9973;
			return hash % 5;
		}
		function normalizeMessage(raw) {
			if (!raw || !raw.id || !raw.from || !raw.to) return null;
			if (raw.from !== "@leader" && !nodes.has(raw.from)) return null;
			if (raw.to !== "@leader" && !nodes.has(raw.to)) return null;
			if (raw.from === raw.to) return null;
			if (raw.from !== "@leader" && raw.to !== "@leader" && nodes.get(raw.from).raw.team !== nodes.get(raw.to).raw.team) return null;
			return { id: text(raw.id, 256), from: raw.from, to: raw.to, kind: KINDS[raw.kind] ? raw.kind : "message", status: DELIVERY[raw.status] ? raw.status : "QUEUED", at: Number(raw.at) || now(), replyTo: text(raw.replyTo, 256), reason: raw.reason === "answer" ? "回答失败" : "投递失败" };
		}
		/* 方向感知：提问与回答、派发与回报各自一条边，箭头方向不再被另一种方向顶掉。 */
		function relationKey(m) { return m.from + "\u2192" + m.to; }
		function trimMessages() { while (messages.size > MAX_MESSAGES) messages.delete(messages.keys().next().value); while (seen.size > MAX_MESSAGES * 2) seen.delete(seen.values().next().value); }
		function putMessage(raw) { var m = normalizeMessage(raw); if (!m) return null; messages.delete(m.id); messages.set(m.id, m); trimMessages(); return m; }
		/* 标签避让：同一竖直带内的标签逐个下移，直到不压住已放置的任何一个。 */
		function placeLabels() {
			var placed = [];
			edges.forEach(function (e) {
				if (!e.labelPos) return;
				var width = e.label.offsetWidth || 96, height = e.label.offsetHeight || 22;
				var centerX = !!e.labelPos.centerX;
				/* 标签不能跑出画布：居中标签按 [x - width/2, x + width/2] 算碰撞与安全边距。 */
				var minLeft = 4, maxLeft = Math.max(4, geometry.width - width - 4), maxY = Math.max(4, geometry.height - height - 4);
				var rawLeft = centerX ? e.labelPos.x - width / 2 : e.labelPos.x;
				var clampedLeft = Math.min(maxLeft, Math.max(minLeft, rawLeft));
				placed.push({ e: e, width: width, height: height, maxY: maxY, x: clampedLeft, y: Math.min(maxY, Math.max(4, e.labelPos.y)), center: e.labelPos.center, centerX: centerX });
			});
			placed.sort(function (a, b) { return a.y - b.y; });
			var settled = [];
			placed.forEach(function (item) {
				var guard = 0;
				while (guard++ < 12 && settled.some(function (other) {
					return Math.abs(other.y - item.y) < (other.height + item.height) / 2 + 4 && item.x < other.x + other.width + 4 && other.x < item.x + item.width + 4;
				})) item.y += item.height + 5;
				settled.push(item);
				Object.assign(item.e.label.style, {
					left: (item.centerX ? item.x + item.width / 2 : item.x) + "px",
					top: Math.min(item.maxY, item.y) + "px",
					transform: item.centerX ? "translate(-50%, -50%)" : (item.center ? "translateY(-50%)" : ""),
				});
			});
		}
		function applySelection() {
			function weigh(parts, outside, live) {
				parts.forEach(function (part) {
					if (outside && !live) part.dataset.muted = "true"; else delete part.dataset.muted;
					if (outside && live) part.dataset.secondary = "true"; else delete part.dataset.secondary;
				});
			}
			nodes.forEach(function (n, key) {
				n.element.setAttribute("aria-pressed", String(selected === key));
				weigh((n.bases || []).concat(n.ports || [], n.flow || [], n.flowGlow || [], n.flowHead || []), selected && selected !== key, isActive(n));
			});
			edges.forEach(function (e) {
				var from = nodes.get(e.message.from), to = nodes.get(e.message.to);
				weigh([e.path, e.flow, e.flowGlow, e.flowHead, e.arrow, e.label], selected && selected !== e.message.from && selected !== e.message.to,
					(from && isActive(from)) || (to && isActive(to)));
			});
		}
		function setSelected(key) { if (destroyed) return; selected = nodes.has(key) ? key : null; applySelection(); }
		function syncFlows() {
			/* 同一路径上已有排队/失败关系时，不再叠常驻涌动：那一段由关系线自己的虚线/颜色表达。 */
			var blocked = new Set();
			messages.forEach(function (m) {
				if (m.status !== "QUEUED" && m.status !== "FAILED") return;
				if (m.from === "@leader") blocked.add(m.to);
				else if (m.to === "@leader") blocked.add(m.from);
			});
			if (applyLanes()) {
				nodes.forEach(function (n, key) { paintNode(key, n); });
				renderEdges();
			}
			nodes.forEach(function (n, key) {
				/* 涌动只跟成员是否在跑：并发成员哪怕还带着排队/失败的关系线，也照样亮着，
				 * 否则「几个成员在并行」这件事在图上看不出来。关系线接管路径时只让归属丝带让位。 */
				var live = isActive(n);
				(n.bases || []).concat(n.ports || []).forEach(function (part) {
					/* 只有「没在跑」的成员才把丝带让给关系线；在跑的成员两样都保留，
					 * 否则并发成员的忙态会被排队色盖掉，看起来像没在动。 */
					part.dataset.hidden = String(blocked.has(key) && !live);
					if (live) part.dataset.live = "true"; else delete part.dataset.live;
				});
				setFlowActive(n, live);
			});
		}
		/* 相位对齐：新变活跃的线用全局时钟取负 delay，和其他活跃线同一步调；主尾流与柔光/头脉冲同频同相。 */
		function setFlowActive(n, on) {
			var layers = [n.flow, n.flowGlow, n.flowHead].filter(Boolean);
			if (!layers.length) return;
			if (on) {
				var phase = "-" + (now() % FLOW_MS) + "ms";
				layers.forEach(function (layer) {
					if (layer.dataset.active === "true") return;
					layer.style.animationDelay = phase;
					layer.dataset.active = "true";
				});
			} else {
				layers.forEach(function (layer) {
					if (!layer.dataset.active) return;
					delete layer.dataset.active;
					layer.style.animationDelay = "";
				});
			}
		}
		function renderEdges() {
			if (!geometry || destroyed) return;
			var relations = new Map(), failures = new Map(), t = now(), nextExpiry = null;
			messages.forEach(function (m) {
				if (!normalizeMessage(m)) return;
				var durable = m.status === "QUEUED" || m.status === "FAILED";
				if (!durable && t - m.at >= RECENT_MS) return;
				var k = relationKey(m), prior = relations.get(k);
				// 未解决失败/排队不可被同关系的新成功遮盖；合并线仍明确标出失败数。
				if (m.status === "FAILED") failures.set(k, (failures.get(k) || 0) + 1);
				var priority = function (entry) { return entry.status === "QUEUED" ? 3 : entry.status === "FAILED" ? 2 : 1; };
				if (!prior || priority(m) > priority(prior) || (priority(m) === priority(prior) && m.at >= prior.at)) relations.set(k, m);
				if (!durable) nextExpiry = nextExpiry == null ? m.at + RECENT_MS : Math.min(nextExpiry, m.at + RECENT_MS);
			});
			edges.forEach(function (e, key) { if (!relations.has(key)) { e.path.remove(); e.flow.remove(); e.flowGlow.remove(); e.flowHead.remove(); e.arrow.remove(); e.label.remove(); edges.delete(key); } });
			relations.forEach(function (m, key) {
				var peer = m.from !== "@leader" && m.to !== "@leader";
				var points = route(m.from, m.to, peer ? pairLane(m.from, m.to) : 0); if (!points) return;
				var e = edges.get(key);
				if (!e) {
					e = { path: svg("path", "cg-edge"), flowGlow: svg("path", "cg-flow-glow"), flow: svg("path", "cg-flow"), flowHead: svg("path", "cg-flow-head"), arrow: svg("polygon", "cg-arrow"), label: el("div", "cg-edge-label") };
					gEdges.appendChild(e.path); gBurstGlows.appendChild(e.flowGlow); gBursts.appendChild(e.flow); gBurstHeads.appendChild(e.flowHead); gHeads.appendChild(e.arrow); canvas.appendChild(e.label);
					edges.set(key, e);
				}
				e.message = m; e.points = points;
				var a, b, d, near, labelX, labelY;
				if (peer) {
					/* 同伴：从卡片右缘向外拱开；同一对的两个方向半径不同，问与答各占一条弧。 */
					var bulge = 22 + pairLane(m.from, m.to) * 12 + (m.from < m.to ? 0 : 12);
					a = points[0]; b = points[1];
					d = bulgeData(a, b, bulge);
					near = bulgeAt(a, b, bulge, 0.93);
					labelX = b[0] + bulge * 0.72 + 6;
					labelY = (a[1] + b[1]) / 2;
				} else {
					/* 主 Agent 连线：单向关系与归属底轨/流光完全同轴；仅当同一成员同时存在往返两条边时做 ±5px 平行分轨。 */
					var hasReverse = relations.has(m.to + "\u2192" + m.from);
					var railOffset = hasReverse ? (m.from === "@leader" ? -5 : 5) : 0;
					a = [points[0][0], points[0][1] + railOffset];
					b = [points[points.length - 1][0], points[points.length - 1][1] + railOffset];
					d = curveData(a, b);
					near = cubicAt(a, b, 0.93);
					var middle = cubicAt(a, b, 0.5);
					labelX = middle[0];
					labelY = middle[1] + (hasReverse ? (m.from === "@leader" ? -16 : 16) : 0);
				}
				e.path.setAttribute("d", d); e.flow.setAttribute("d", d); e.flowGlow.setAttribute("d", d); e.flowHead.setAttribute("d", d);
				applyTaper(e.path, a, b);
				e.arrow.setAttribute("points", arrowMarks(b, near));
				e.path.dataset.status = m.status; e.arrow.dataset.status = m.status; e.label.dataset.status = m.status;
				e.label.textContent = KINDS[m.kind] + " · " + (m.status === "FAILED" ? m.kind === "report" ? "失败" : m.reason : DELIVERY[m.status]) + (m.status !== "FAILED" && failures.has(key) ? " · " + failures.get(key) + "失败" : "");
				e.labelPos = peer ? { x: labelX, y: labelY, center: true, centerX: false } : { x: labelX, y: labelY, center: true, centerX: true };
			});
			placeLabels();
			applySelection(); syncFlows();
			if (expiry != null) cancelTimeout(expiry); expiry = null;
			if (nextExpiry != null && visible && connected) expiry = timeout(function () { expiry = null; renderEdges(); renderStats(); }, Math.max(20, nextExpiry - now() + 20));
		}
		function stopBursts() {
			bursts.forEach(function (entry) { cancelTimeout(entry.timer); entry.elements.forEach(function (el) { delete el.dataset.burst; }); });
			bursts.clear();
		}
		function burst(m, e) {
			if (bursts.has(m.id) || bursts.size >= MAX_BURSTS) return;
			var els = [e.flow, e.flowGlow, e.flowHead];
			var entry = { elements: els, timer: null };
			entry.timer = timeout(function () { bursts.delete(m.id); els.forEach(function (el) { delete el.dataset.burst; }); }, BURST_MS);
			bursts.set(m.id, entry);
			els.forEach(function (el) { el.dataset.burst = "true"; });
		}
		function communication(raw, animate) {
			if (destroyed) return;
			var m = putMessage(raw); if (!m) return;
			renderEdges(); syncFlows(); renderStats();
			if (!SENT[m.status]) return;
			if (seen.has(m.id)) return;
			seen.add(m.id); trimMessages();
			if (animate === false || !visible || !connected || !motion) return;
			var e = edges.get(relationKey(m)); if (e) burst(m, e);
		}
		function restoreCommunications(list) { if (destroyed) return; stopBursts(); messages.clear(); (Array.isArray(list) ? list : []).slice(-MAX_MESSAGES).forEach(function (raw) { var m = putMessage(raw); if (m && SENT[m.status]) seen.add(m.id); }); trimMessages(); renderEdges(); renderStats(); }
		function removeCommunications(ids) { if (destroyed) return; (Array.isArray(ids) ? ids : []).forEach(function (id) { messages.delete(id); }); renderEdges(); renderStats(); }
		function update(list, selectedKey) {
			if (destroyed) return;
			var keys = new Set();
			hiddenCount = 0;
			hiddenTeams = new Map();
			(Array.isArray(list) ? list : []).forEach(function (raw) {
				if (!raw || !raw.id) return;
				var key = raw.key || (String(raw.team || "default") + "\u0000" + String(raw.id));
				if (keys.has(key)) return;
				keys.add(key);
				if (HIDDEN[status(raw.status || (raw.state && raw.state.status) || raw.communication && raw.communication.status)] === 1 && !(raw.communication && raw.communication.active)) {
					hiddenCount++;
					var teamKey = String(raw.team || "default");
					hiddenTeams.set(teamKey, (hiddenTeams.get(teamKey) || 0) + 1);
					var gone = nodes.get(key);
					if (gone) { gone.element.remove(); if (gone.base) gone.base.remove(); if (gone.portStart) gone.portStart.remove(); if (gone.portEnd) gone.portEnd.remove(); if (gone.flow) gone.flow.remove(); if (gone.flowGlow) gone.flowGlow.remove(); if (gone.flowHead) gone.flowHead.remove(); nodes.delete(key); }
					return;
				}
				var n = nodes.get(key);
				if (!n) { n = makeNode(key, false); nodes.set(key, n); }
				updateNode(n, raw);
			});
			nodes.forEach(function (n, key) { if (!keys.has(key)) { n.element.remove(); if (n.base) n.base.remove(); if (n.portStart) n.portStart.remove(); if (n.portEnd) n.portEnd.remove(); if (n.flow) n.flow.remove(); if (n.flowGlow) n.flowGlow.remove(); if (n.flowHead) n.flowHead.remove(); nodes.delete(key); } });
			if (arguments.length > 1) selected = nodes.has(selectedKey) ? selectedKey : null;
			else if (!nodes.has(selected)) selected = null;
			empty.hidden = nodes.size > 0 || hiddenCount > 0;
			hiddenNote.textContent = hiddenCount ? "已隐藏 " + hiddenCount + " 位已停止成员" : "";
			layout(false); syncFlows(); applySelection(); renderStats();
		}
		function setLeaderState(value) { if (destroyed) return; leader = value && typeof value === "object" ? value : { status: "UNKNOWN", tools: [] }; renderLeader(); }
		function applyMotion() { shell.dataset.motion = visible && connected && motion ? "on" : "off"; }
		function setVisible(value) { if (destroyed) return; visible = value !== false; applyMotion(); if (!visible) { stopBursts(); if (expiry != null) cancelTimeout(expiry); expiry = null; } else renderEdges(); }
		function setConnected(value) { if (destroyed) return; connected = value !== false; applyMotion(); if (!connected) { stopBursts(); if (expiry != null) cancelTimeout(expiry); expiry = null; } else renderEdges(); renderLeader(); }
		function setReducedMotion(value) { motion = !value; applyMotion(); if (!motion) stopBursts(); }
		function onMotion(event) { if (opts.reducedMotion === undefined) setReducedMotion(event.matches); }
		if (mql && mql.addEventListener) mql.addEventListener("change", onMotion);
		var observer = typeof global.ResizeObserver === "function" ? new global.ResizeObserver(function () { layout(false); applyFit(); syncFlows(); }) : null;
		if (observer) observer.observe(root);
		function destroy() { if (destroyed) return; destroyed = true; stopBursts(); if (expiry != null) cancelTimeout(expiry); if (observer) observer.disconnect(); if (mql && mql.removeEventListener) mql.removeEventListener("change", onMotion); nodes.clear(); messages.clear(); edges.clear(); seen.clear(); shell.remove(); }
		applyMotion(); renderLeader(); layout(true);
		return { update: update, setLeaderState: setLeaderState, communication: communication, restoreCommunications: restoreCommunications, removeCommunications: removeCommunications, setSelected: setSelected, setVisible: setVisible, setConnected: setConnected, setReducedMotion: setReducedMotion, destroy: destroy };
	}
	global.CollaborationGraph = { create: create, fitScale: fitScale, canvasWidth: canvasWidth, graphMetrics: graphMetrics };
})(typeof window !== "undefined" ? window : globalThis);
