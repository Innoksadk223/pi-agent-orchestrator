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
	var ACTIVE = { STARTING: 1, RUNNING: 1, TOOL: 1, RETRY: 1 };
	/* 停止的席位默认不画在图上：它已不可继续执行，留着只是一排死卡。
	 * 重新派发会先进入 STARTING/RUNNING，于是自动重新出现。 */
	var HIDDEN = { STOPPED: 1 };
	var LABELS = { UNKNOWN: "未获取", APPROVED: "已授权", STARTING: "启动中", RUNNING: "运行中", TOOL: "工具中", IDLE: "空闲", SETTLED: "已完成", INTERRUPTED: "已中断", STOPPED: "已停止", ERROR: "错误", RETRY: "重试中", REPORT_INVALID: "格式错误" };
	var KINDS = { dispatch: "派发", steer: "引导", report: "回报", question: "提问", answer: "回答", message: "留言", request_answer: "应答" };
	var DELIVERY = { QUEUED: "排队", ACCEPTED: "已接受", DELIVERED: "已投递", SUBMITTED: "已提交", READY: "结果就绪", FAILED: "失败", CANCELED: "已取消", INTERRUPTED: "已中断", REPORT_INVALID: "格式错误" };
	var SENT = { ACCEPTED: true, DELIVERED: true, SUBMITTED: true, READY: true };
	/* 涌动：固定空间周期（dasharray 42+198=240px）与统一时长，所有路径速度一致，
	 * 相位由脚本写入的负 animation-delay 对齐到同一时钟；dasharray 与 keyframes 的 240 必须同步。 */
	var CSS = `
.cg-root { --cg-paper:rgb(255 255 255 / .5); --cg-ink:var(--ink,#13211b); --cg-soft:var(--ink-soft,#3d5348); --cg-rule:var(--rule,rgb(20 60 45 / .14)); --cg-blue:var(--accent-ink,#12543a); --cg-warn:var(--warn-ink,#8a5a1e); --cg-red:var(--status-error-ink,#a33732); --cg-green:var(--status-settled-ink,#1d7a56); --cg-rail-idle:var(--status-idle-line,var(--cg-rule)); --cg-rail-run:var(--status-running-line,var(--cg-blue)); --cg-rail-warn:var(--status-starting-line,var(--cg-warn)); --cg-rail-error:var(--status-error-line,var(--cg-red)); --cg-rail-settled:var(--status-settled-line,var(--cg-green)); --cg-flow:var(--status-running-ink,var(--cg-blue)); --cg-ribbon:rgb(18 84 58 / .12); --cg-ribbon-live:rgb(18 84 58 / .34); position:relative; color:var(--cg-ink); font-family:var(--font-body,system-ui,sans-serif); min-width:0; border:1px solid rgb(255 255 255 / .6); border-radius:8px; overflow:hidden; }
.cg-root * { box-sizing:border-box; }
.cg-scroll { overflow:auto; overscroll-behavior:contain; height:100%; min-height:350px; max-height:76svh; scrollbar-color:var(--cg-rule) transparent; }
.cg-canvas { position:relative; margin-inline:auto; isolation:isolate; }
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
.cg-node[data-leader="true"] .cg-name { font-size:19px; color:#fff; }
.cg-node[data-leader="true"] .cg-role { color:rgb(255 255 255 / .72); margin-top:4px; }
.cg-node[data-leader="true"] .cg-badge { color:rgb(255 255 255 / .84); }
.cg-node[data-leader="true"] .cg-action { color:rgb(255 255 255 / .88); border-top-color:rgb(255 255 255 / .2); }
.cg-stats { display:flex; gap:14px; margin-top:10px; font-family:var(--font-mono,ui-monospace); font-size:11px; color:rgb(255 255 255 / .72); }
.cg-stat { display:flex; gap:4px; align-items:baseline; }
.cg-stat b { font-weight:650; font-size:13px; color:#fff; font-variant-numeric:tabular-nums; }
.cg-team { position:absolute; font-size:12px; font-weight:650; color:var(--cg-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* 归属线：填充丝带（源头宽、末端窄），不用描边，避免与关系线抢质地。 */
.cg-ribbon { fill:var(--cg-ribbon); stroke:none; }
.cg-ribbon[data-live="true"] { fill:var(--cg-ribbon-live); }
.cg-edge { stroke:var(--cg-blue); stroke-width:1.7; stroke-linejoin:round; fill:none; }
.cg-edge[data-status="QUEUED"] { stroke:var(--cg-warn); stroke-dasharray:5 5; }
.cg-edge[data-status="FAILED"] { stroke:var(--cg-red); }
.cg-edge[data-status="CANCELED"],.cg-edge[data-status="INTERRUPTED"] { stroke:var(--cg-soft); stroke-dasharray:3 5; }
/* 涌动：固定空间周期（42+198=240px）与同一时长，所有路径速度一致；
 * 相位由脚本写入的负 animation-delay 对齐到同一时钟，并行成员步调一致。
 * dasharray 的 240 与 keyframes 的 240 必须同步。 */
.cg-flow { fill:none; stroke:var(--cg-flow); stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:42 198; stroke-dashoffset:0; stroke-opacity:0; }
.cg-flow[data-active="true"] { stroke-opacity:.72; animation:cg-wave 1450ms linear infinite; }
.cg-flow[data-burst="true"] { stroke-width:3.6; stroke-opacity:1; animation:cg-wave 480ms linear 3; }
.cg-flow[data-muted="true"] { stroke-opacity:0; }
.cg-root[data-motion="off"] .cg-flow { animation:none; stroke-opacity:0; }
@keyframes cg-wave { from { stroke-dashoffset:240; } to { stroke-dashoffset:0; } }
.cg-arrow { fill:var(--cg-blue); }
.cg-arrow[data-status="QUEUED"] { fill:var(--cg-warn); }
.cg-arrow[data-status="FAILED"] { fill:var(--cg-red); }
.cg-arrow[data-status="CANCELED"],.cg-arrow[data-status="INTERRUPTED"] { fill:var(--cg-soft); }
.cg-edge-label { position:absolute; z-index:3; padding:3px 7px; background:var(--cg-paper); border:1px solid var(--cg-rule); border-radius:4px; color:var(--cg-blue); font-size:11px; white-space:nowrap; pointer-events:none; }
.cg-edge-label[data-status="QUEUED"] { color:var(--cg-warn); }
.cg-edge-label[data-status="FAILED"] { color:var(--cg-red); }
.cg-ribbon[data-muted="true"],.cg-edge[data-muted="true"],.cg-arrow[data-muted="true"] { opacity:.15; }
.cg-ribbon[data-hidden="true"] { fill-opacity:0; }
.cg-edge-label[data-muted="true"] { opacity:.25; }
.cg-legend { display:flex; align-items:center; flex-wrap:wrap; gap:10px 18px; padding:11px 16px; border-top:1px solid var(--cg-rule); background:var(--cg-paper); font-size:12px; color:var(--cg-soft); }
.cg-legend span { display:flex; gap:6px; align-items:center; }
.cg-legend i { display:inline-block; width:22px; height:0; border-top:2px solid var(--cg-rule); }
.cg-legend .cg-legend-base { border-top:0; height:5px; border-radius:3px; background:var(--cg-ribbon-live); }
.cg-legend .cg-legend-flow { border-top-width:0; height:3px; border-radius:2px; background:linear-gradient(90deg,transparent,var(--cg-flow) 50%,transparent); }
.cg-legend .cg-legend-message { border-color:var(--cg-blue); }
.cg-legend .cg-legend-queued { border-color:var(--cg-warn); border-top-style:dashed; }
.cg-legend .cg-legend-failed { border-color:var(--cg-red); }
.cg-hidden { color:var(--cg-soft); }
.cg-offline { margin-left:auto; color:var(--cg-warn); }
.cg-empty { position:absolute; color:var(--cg-soft); font-size:14px; padding:18px; }
@media(prefers-reduced-motion:reduce) { .cg-node { transition:none; } .cg-flow { animation:none; stroke-opacity:0; } }
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
	/* 箭头按真实切线画，竖向的同伴连线也能指对方向。 */
	function arrowMarks(tip, near) {
		var ux = tip[0] - near[0], uy = tip[1] - near[1], len = Math.sqrt(ux * ux + uy * uy) || 1;
		ux /= len; uy /= len;
		var bx = tip[0] - ux * 8, by = tip[1] - uy * 8, px = -uy * 4.2, py = ux * 4.2;
		return tip[0] + "," + tip[1] + " " + (bx + px) + "," + (by + py) + " " + (bx - px) + "," + (by - py);
	}
	/* 丝带几何：起止点之间一条三次贝塞尔，lane 只改控制点，曲线自然拉开成束。 */
	function curveReach(a, b) { return Math.max(70, Math.abs(b[0] - a[0]) * 0.5); }
	function curveDirection(a, b) { return b[0] >= a[0] ? 1 : -1; }
	function curveData(a, b, off) {
		var dir = curveDirection(a, b), reach = curveReach(a, b);
		return "M" + a[0] + " " + a[1] + " C" + (a[0] + reach * dir) + " " + (a[1] + off) + " " + (b[0] - reach * dir) + " " + (b[1] + off) + " " + b[0] + " " + b[1];
	}
	function cubicAt(a, b, off, t) {
		var dir = curveDirection(a, b), reach = curveReach(a, b), c1 = [a[0] + reach * dir, a[1] + off], c2 = [b[0] - reach * dir, b[1] + off], mt = 1 - t;
		return [mt * mt * mt * a[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * b[0], mt * mt * mt * a[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * b[1]];
	}
	/* 按法线向两侧撑开中线：源头 2.8px 收到末端 1px，读作一根拉紧的丝带。 */
	function ribbonData(a, b, off) {
		var steps = 26, left = [], right = [], i;
		for (i = 0; i <= steps; i++) {
			var t = i / steps, p = cubicAt(a, b, off, t), before = cubicAt(a, b, off, Math.max(0, t - 0.05)), after = cubicAt(a, b, off, Math.min(1, t + 0.05));
			var tx = after[0] - before[0], ty = after[1] - before[1], len = Math.sqrt(tx * tx + ty * ty) || 1, w = 2.8 - 1.8 * t;
			left.push([(p[0] - ty / len * w).toFixed(1), (p[1] + tx / len * w).toFixed(1)]);
			right.push([(p[0] + ty / len * w).toFixed(1), (p[1] - tx / len * w).toFixed(1)]);
		}
		var d = "M" + left[0].join(" ");
		for (i = 1; i < left.length; i++) d += " L" + left[i].join(" ");
		for (i = right.length - 1; i >= 0; i--) d += " L" + right[i].join(" ");
		return d + " Z";
	}

	function create(root, options) {
		if (!root || typeof root.appendChild !== "function") throw new TypeError("CollaborationGraph.create 需要根节点");
		var opts = options || {}, doc = root.ownerDocument || global.document;
		var now = opts.now || function () { return Date.now(); };
		var timeout = opts.setTimer || global.setTimeout.bind(global), cancelTimeout = opts.clearTimer || global.clearTimeout.bind(global);
		var nodes = new Map(), messages = new Map(), edges = new Map(), seen = new Set(), bursts = new Map();
		var selected = null, visible = true, connected = true, destroyed = false, expiry = null;
		var leader = { status: "UNKNOWN", tools: [] }, layoutKey = "", geometry = null, statsKey = "";
		var lanes = new Map(), laneSig = "", hiddenCount = 0, hiddenTeams = new Map();
		var mql = typeof global.matchMedia === "function" ? global.matchMedia("(prefers-reduced-motion: reduce)") : null;
		var motion = opts.reducedMotion === undefined ? !(mql && mql.matches) : !opts.reducedMotion;

		function el(tag, cls, content) { var n = doc.createElement(tag); if (cls) n.className = cls; if (content != null) n.textContent = content; return n; }
		function svg(tag, cls) { var n = doc.createElementNS(SVG, tag); if (cls) n.setAttribute("class", cls); return n; }
		var shell = el("section", "cg-root"), style = el("style"), scroll = el("div", "cg-scroll"), canvas = el("div", "cg-canvas"), lines = svg("svg", "cg-lines");
		/* 五层固定分组：静态归属线 → 常驻涌动 → 通信关系 → 投递脉冲 → 箭头。DOM 顺序即绘制顺序。 */
		var gBases = svg("g", "cg-layer"), gFlows = svg("g", "cg-layer"), gEdges = svg("g", "cg-layer"), gBursts = svg("g", "cg-layer"), gHeads = svg("g", "cg-layer");
		[gBases, gFlows, gEdges, gBursts, gHeads].forEach(function (g) { lines.appendChild(g); });
		function clearGroup(g) { while (g.firstChild) g.firstChild.remove(); }
		style.nonce = opts.nonce || (doc.currentScript && doc.currentScript.nonce) || "";
		style.textContent = CSS;
		shell.setAttribute("aria-label", "Agent 协作图");
		scroll.setAttribute("tabindex", "0"); scroll.setAttribute("aria-label", "协作图画布，可上下左右滚动");
		lines.setAttribute("aria-hidden", "true");
		canvas.appendChild(lines); scroll.appendChild(canvas); shell.appendChild(style); shell.appendChild(scroll);
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
			return { key: key, element: button, name: name, badge: badge, role: role, action: action, rail: rail, stats: stats, statValues: statValues, raw: {}, box: null, bases: [], flow: null };
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
		function layout(force) {
			var compact = (root.clientWidth || 1000) < 640;
			var key = (compact ? "s" : "l") + Array.from(nodes.keys()).join("\u0001");
			if (!force && key === layoutKey) return;
			layoutKey = key; stopBursts();
			headings.forEach(function (h) { h.remove(); }); headings = [];
			var memberX = compact ? 320 : 420, memberW = compact ? 250 : 278, groups = new Map(), y = 24, firstY = null, lastY = null, placed = 0;
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
			setBox(main, 28, leaderY, compact ? 196 : 236, LEADER_H);
			geometry = { width: compact ? 820 : 980, height: height, memberX: memberX, memberRight: memberX + memberW, trunk: memberX - 80 };
			canvas.style.width = geometry.width + "px"; canvas.style.height = height + "px";
			lines.setAttribute("width", String(geometry.width)); lines.setAttribute("height", String(height));
			lines.setAttribute("viewBox", "0 0 " + geometry.width + " " + height);
			Object.assign(empty.style, { left: memberX + "px", top: "60px" });
			clearGroup(gBases); clearGroup(gFlows);
			nodes.forEach(function (n) { n.bases = []; n.flow = null; });
			applyLanes();
			nodes.forEach(function (n, nodeKey) { buildNode(nodeKey, n); paintNode(nodeKey, n); });
			renderEdges(); syncFlows(); applySelection();
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
			n.bases = [n.base];
			n.flow = svg("path", "cg-flow"); n.flow.dataset.key = key;
			gBases.appendChild(n.base); gFlows.appendChild(n.flow);
		}
		function paintNode(key, n) {
			if (!n.flow || !geometry) return;
			var points = route("@leader", key, 0);
			if (!points) return;
			var shift = laneShift(key), a = [points[0][0], points[0][1] + shift * 0.45], b = points[points.length - 1], off = shift * 1.6;
			n.base.setAttribute("d", ribbonData(a, b, off));
			n.flow.setAttribute("d", curveData(a, b, off));
		}
		function route(from, to, lane) {
			var a = from === "@leader" ? main : nodes.get(from), b = to === "@leader" ? main : nodes.get(to);
			if (!a || !b || !a.box || !b.box) return null;
			var ab = a.box, bb = b.box, ay = ab.y + ab.height / 2, by = bb.y + bb.height / 2;
			/* 曲线只用到首尾两点；中间点仍给箭头方向与标签定位用。 */
			if (from === "@leader") { var x = geometry.trunk + laneShift(to), sy = leaderAnchor(to) ?? ay; return [[ab.x + ab.width, sy], [x, sy], [x, by], [bb.x, by]]; }
			if (to === "@leader") { var rx = geometry.trunk - 22 - laneShift(from), ty = leaderAnchor(from) ?? ay; return [[ab.x, ay], [rx, ay], [rx, by], [bb.x + bb.width, ty]]; }
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
				placed.push({ e: e, width: width, height: height, x: e.labelPos.x, y: e.labelPos.y, center: e.labelPos.center });
			});
			placed.sort(function (a, b) { return a.y - b.y; });
			var settled = [];
			placed.forEach(function (item) {
				var guard = 0;
				while (guard++ < 12 && settled.some(function (other) {
					return Math.abs(other.y - item.y) < (other.height + item.height) / 2 + 2 && item.x < other.x + other.width + 4 && other.x < item.x + item.width + 4;
				})) item.y += item.height + 4;
				settled.push(item);
				Object.assign(item.e.label.style, {
					left: item.x + "px",
					top: item.y + "px",
					transform: item.center ? "translateY(-50%)" : "",
				});
			});
		}
		function applySelection() {
			nodes.forEach(function (n, key) {
				n.element.setAttribute("aria-pressed", String(selected === key));
				var muted = !!selected && selected !== key;
				(n.bases || []).forEach(function (part) { part.dataset.muted = String(muted); });
				if (n.flow) n.flow.dataset.muted = String(muted);
			});
			edges.forEach(function (e) {
				var muted = !!selected && e.message.from !== selected && e.message.to !== selected;
				[e.path, e.flow, e.arrow, e.label].forEach(function (n) { n.dataset.muted = String(muted); });
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
				(n.bases || []).forEach(function (part) {
					/* 只有「没在跑」的成员才把丝带让给关系线；在跑的成员两样都保留，
					 * 否则并发成员的忙态会被排队色盖掉，看起来像没在动。 */
					part.dataset.hidden = String(blocked.has(key) && !live);
					if (live) part.dataset.live = "true"; else delete part.dataset.live;
				});
				setFlowActive(n, live);
			});
		}
		/* 相位对齐：新变活跃的线用全局时钟取负 delay，和其他活跃线同一步调。 */
		function setFlowActive(n, on) {
			var flow = n.flow;
			if (!flow) return;
			if (on) {
				if (flow.dataset.active === "true") return;
				flow.style.animationDelay = "-" + (now() % FLOW_MS) + "ms";
				flow.dataset.active = "true";
			} else if (flow.dataset.active) {
				delete flow.dataset.active;
				flow.style.animationDelay = "";
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
			edges.forEach(function (e, key) { if (!relations.has(key)) { e.path.remove(); e.flow.remove(); e.arrow.remove(); e.label.remove(); edges.delete(key); } });
			relations.forEach(function (m, key) {
				var peer = m.from !== "@leader" && m.to !== "@leader";
				var points = route(m.from, m.to, peer ? pairLane(m.from, m.to) : 0); if (!points) return;
				var e = edges.get(key);
				if (!e) {
					e = { path: svg("path", "cg-edge"), flow: svg("path", "cg-flow"), arrow: svg("polygon", "cg-arrow"), label: el("div", "cg-edge-label") };
					gEdges.appendChild(e.path); gBursts.appendChild(e.flow); gHeads.appendChild(e.arrow); canvas.appendChild(e.label);
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
					/* 主 Agent 连线：骑在自己的丝带上，派发与回报上下分开 ±9px。 */
					var shift = laneShift(m.from === "@leader" ? m.to : m.from) * 1.6 + (m.from === "@leader" ? 9 : -9);
					a = [points[0][0], points[0][1] + shift * 0.45]; b = points[points.length - 1];
					d = curveData(a, b, shift);
					near = cubicAt(a, b, shift, 0.93);
					var middle = cubicAt(a, b, shift, 0.46);
					labelX = middle[0] - 34;
					labelY = middle[1] - 30;
				}
				e.path.setAttribute("d", d); e.flow.setAttribute("d", d);
				e.arrow.setAttribute("points", arrowMarks(b, near));
				e.path.dataset.status = m.status; e.arrow.dataset.status = m.status; e.label.dataset.status = m.status;
				e.label.textContent = KINDS[m.kind] + " · " + (m.status === "FAILED" ? m.kind === "report" ? "失败" : m.reason : DELIVERY[m.status]) + (m.status !== "FAILED" && failures.has(key) ? " · " + failures.get(key) + "失败" : "");
				e.labelPos = { x: labelX, y: labelY, center: peer };
			});
			placeLabels();
			applySelection(); syncFlows();
			if (expiry != null) cancelTimeout(expiry); expiry = null;
			if (nextExpiry != null && visible && connected) expiry = timeout(function () { expiry = null; renderEdges(); renderStats(); }, Math.max(20, nextExpiry - now() + 20));
		}
		function stopBursts() {
			bursts.forEach(function (entry) { cancelTimeout(entry.timer); delete entry.element.dataset.burst; });
			bursts.clear();
		}
		function burst(m, e) {
			if (bursts.has(m.id) || bursts.size >= MAX_BURSTS) return;
			var entry = { element: e.flow, timer: null };
			entry.timer = timeout(function () { bursts.delete(m.id); delete entry.element.dataset.burst; }, BURST_MS);
			bursts.set(m.id, entry);
			e.flow.dataset.burst = "true";
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
					if (gone) { gone.element.remove(); if (gone.base) gone.base.remove(); if (gone.flow) gone.flow.remove(); nodes.delete(key); }
					return;
				}
				var n = nodes.get(key);
				if (!n) { n = makeNode(key, false); nodes.set(key, n); }
				updateNode(n, raw);
			});
			nodes.forEach(function (n, key) { if (!keys.has(key)) { n.element.remove(); if (n.base) n.base.remove(); if (n.flow) n.flow.remove(); nodes.delete(key); } });
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
		var observer = typeof global.ResizeObserver === "function" ? new global.ResizeObserver(function () { layout(false); syncFlows(); }) : null;
		if (observer) observer.observe(root);
		function destroy() { if (destroyed) return; destroyed = true; stopBursts(); if (expiry != null) cancelTimeout(expiry); if (observer) observer.disconnect(); if (mql && mql.removeEventListener) mql.removeEventListener("change", onMotion); nodes.clear(); messages.clear(); edges.clear(); seen.clear(); shell.remove(); }
		applyMotion(); renderLeader(); layout(true);
		return { update: update, setLeaderState: setLeaderState, communication: communication, restoreCommunications: restoreCommunications, removeCommunications: removeCommunications, setSelected: setSelected, setVisible: setVisible, setConnected: setConnected, setReducedMotion: setReducedMotion, destroy: destroy };
	}
	global.CollaborationGraph = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
