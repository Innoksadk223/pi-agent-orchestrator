// 原生图面确定性检查：复用原办公室检查的假 DOM/时钟思路，无依赖、无真实模型。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const SOURCE = readFileSync(new URL("./collaboration-graph.js", import.meta.url), "utf8");
class Element {
	children: Element[] = [];
	parentNode?: Element;
	className = "";
	textContent = "";
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	attributes = new Map<string, string>();
	listeners = new Map<string, () => void>();
	clientWidth = 1200;
	writes = 0;
	// node 的 strip-only 类型擦除不支持参数属性（constructor(readonly tag)），所以显式赋值。
	tag: string;
	ownerDocument: any;
	constructor(tag: string, ownerDocument: any) {
		this.tag = tag;
		this.ownerDocument = ownerDocument;
	}
	get firstChild() { return this.children[0]; }
	appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
	insertBefore(child: Element, before?: Element) { child.remove(); child.parentNode = this; const at = this.children.indexOf(before!); this.children.splice(at < 0 ? 0 : at, 0, child); }
	remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = undefined; } }
	setAttribute(key: string, value: string) { this.writes++; this.attributes.set(key, value); if (key === "class") this.className = value; }
	getAttribute(key: string) { return this.attributes.get(key); }
	addEventListener(type: string, callback: () => void) { this.listeners.set(type, callback); }
	click() { this.listeners.get("click")?.(); }
	querySelectorAll(selector: string): Element[] { const found: Element[] = []; for (const child of this.children) { if (child.className.split(" ").includes(selector.slice(1))) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
}
function fixture() {
	let time = 1000, seq = 0, disconnected = 0;
	const timers = new Map<number, { at: number; run: () => void }>(), frames = new Map<number, () => void>();
	const mediaListeners = new Set<(event: any) => void>();
	let resizeCallback: (() => void) | null = null;
	const doc: any = { createElement: (tag: string) => new Element(tag, doc), createElementNS: (_: string, tag: string) => new Element(tag, doc) };
	const window: any = { document: doc, requestAnimationFrame: (run: () => void) => { frames.set(++seq, run); return seq; }, cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout: (run: () => void, ms: number) => { timers.set(++seq, { at: time + ms, run }); return seq; }, clearTimeout: (id: number) => timers.delete(id), matchMedia: () => ({ matches: false, addEventListener: (_: string, run: (event: any) => void) => mediaListeners.add(run), removeEventListener: (_: string, run: (event: any) => void) => mediaListeners.delete(run) }), ResizeObserver: class { constructor(run: () => void) { resizeCallback = run; } observe() {} disconnect() { disconnected++; } } };
	runInNewContext(SOURCE, { window });
	const root = new Element("main", doc), selections: string[] = [];
	const graph = window.CollaborationGraph.create(root, { now: () => time, onSelect: (key: string) => selections.push(key), nonce: "safe-nonce" });
	const members = ["a", "b", "c"].map((id) => ({ key: `t\u0000${id}`, team: "t", id, role: "角色", status: "RUNNING", activities: [{ label: "思考中", detail: "不可显示的正文" }] }));
	graph.update(members);
	const flows = () => root.querySelectorAll(".cg-flow");
	/* 容器变宽/变窄：真实浏览器走 ResizeObserver，这里手动激同一个回调。
	 * 缩放按滚动区的内容宽算，假 DOM 里两处同步成同一个容器宽。 */
	const scrollBox = root.querySelectorAll(".cg-scroll")[0];
	const resize = (width: number) => { root.clientWidth = width; scrollBox.clientWidth = width; resizeCallback?.(); };
	return {
		root, graph, members, selections, timers, frames, mediaListeners, flows, window,
		get disconnected() { return disconnected; },
		get shell() { return root.children[0]; },
		resize,
		canvas: () => root.querySelectorAll(".cg-canvas")[0],
		frame: () => root.querySelectorAll(".cg-frame")[0],
		advance(ms: number) { time += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((run) => run()); for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.run(); } },
		message(overrides: any = {}) { return { id: `m${++seq}`, from: "t\u0000a", to: "t\u0000b", kind: "question", status: "DELIVERED", at: time, ...overrides }; },
	};
}

test("keyed nodes stay stable during streamed updates; click selection is keyboard-compatible", () => {
	const f = fixture(), first = f.root.querySelectorAll(".cg-node")[1];
	const bases = f.root.querySelectorAll(".cg-ribbon"), counts = bases.map((n) => n.writes);
	for (let i = 0; i < 500; i++) f.graph.update(f.members, null);
	assert.equal(f.root.querySelectorAll(".cg-node")[1], first);
	assert.deepEqual(bases.map((n) => n.writes), counts.map((n) => n));
	assert.equal(first.tag, "button"); first.click(); assert.deepEqual(f.selections, ["t\u0000a"]);
	assert.equal(first.getAttribute("aria-pressed"), "true");
	f.graph.setSelected(null); assert.equal(first.getAttribute("aria-pressed"), "false"); f.graph.destroy();
});

test("leader status remains unknown until an actual independent state arrives", () => {
	const f = fixture();
	assert.equal(f.root.querySelectorAll(".cg-badge")[0].textContent, "未获取");
	f.graph.setLeaderState({ status: "IDLE", tools: [] });
	assert.equal(f.root.querySelectorAll(".cg-badge")[0].textContent, "空闲");
	f.graph.setConnected(false); assert.equal(f.root.querySelectorAll(".cg-badge")[0].textContent, "未获取"); f.graph.destroy();
});

test("actions contain whitelisted phases/tool names, never task or thought bodies", () => {
	const f = fixture();
	assert.equal(f.root.querySelectorAll(".cg-action")[1].textContent, "思考中");
	f.members[0].activities = [{ label: "任务已接收", detail: "secret task body" }]; f.graph.update(f.members);
	assert.equal(f.root.querySelectorAll(".cg-action")[1].textContent, "等待阶段事件");
	f.graph.update([{ ...f.members[0], status: "IDLE", communication: { active: true, status: "RUNNING", label: "执行工具", detail: "read" } }]);
	assert.equal(f.root.querySelectorAll(".cg-action")[1].textContent, "回答同伴 · 执行工具 · read");
	assert.equal(f.root.querySelectorAll(".cg-badge")[1].textContent, "运行中");
	f.graph.update([{ ...f.members[0], status: "IDLE" }]); assert.equal(f.root.querySelectorAll(".cg-action")[1].textContent, "当前无活动任务"); f.graph.destroy();
});

const pulsers = (f: ReturnType<typeof fixture>) => f.flows().filter((n: Element) => n.dataset.burst === "true");

test("delivery pulses are finite, deduplicated, bounded, and not triggered by queued/failed data", () => {
	const f = fixture(), m = f.message();
	f.graph.communication(m); f.graph.communication(m);
	assert.equal(pulsers(f).length, 1);
	assert.equal(f.frames.size, 0, "涌动只用 CSS，不占逐帧");
	// 同一关系重复投递不堆元素；跨关系并发仍有上限。
	for (let i = 0; i < 60; i++) f.graph.communication(f.message());
	assert.ok(pulsers(f).length <= 8, `pulsing edges stay bounded: ${pulsers(f).length}`);
	const keys = ["t\u0000a", "t\u0000b", "t\u0000c", "@leader"];
	for (const from of keys) for (const to of keys) if (from !== to) f.graph.communication(f.message({ from, to }));
	assert.ok(pulsers(f).length <= 8, `cross-relation bursts stay bounded: ${pulsers(f).length}`);
	f.advance(2200); assert.equal(pulsers(f).length, 0);
	f.graph.communication(f.message({ status: "QUEUED" })); f.graph.communication(f.message({ status: "FAILED" }));
	assert.equal(pulsers(f).length, 0); f.graph.destroy();
});

test("queued to delivered transitions animate once, history refresh never replays", () => {
	const f = fixture(), m = f.message({ status: "QUEUED" });
	f.graph.communication(m); assert.equal(pulsers(f).length, 0);
	f.graph.communication({ ...m, status: "DELIVERED" }); assert.equal(pulsers(f).length, 1);
	f.graph.restoreCommunications([{ ...m, status: "DELIVERED" }]); assert.equal(pulsers(f).length, 0);
	f.graph.communication({ ...m, status: "DELIVERED" }); assert.equal(pulsers(f).length, 0);
	f.graph.removeCommunications([m.id]); assert.equal(f.root.querySelectorAll(".cg-edge").length, 0); f.graph.destroy();
});

test("hidden, disconnected, and reduced-motion events do not replay on return", () => {
	for (const setter of ["setVisible", "setConnected", "setReducedMotion"]) {
		const f = fixture(); f.graph.communication(f.message());
		f.graph[setter](setter === "setReducedMotion"); assert.equal(pulsers(f).length, 0);
		const missed = f.message(); f.graph.communication(missed);
		f.graph[setter](setter !== "setReducedMotion"); f.graph.communication(missed);
		assert.equal(pulsers(f).length, 0); f.graph.destroy();
	}
});

test("running members carry a flowing base line; idle and reduced-motion stop it", () => {
	const f = fixture(), flowFor = (key: string) => f.flows().find((n: Element) => n.dataset.key === key)!;
	assert.equal(flowFor("t\u0000a").dataset.active, "true");
	assert.equal(f.shell.dataset.motion, "on");
	f.graph.update([{ ...f.members[0], status: "IDLE" }, f.members[1], f.members[2]]);
	assert.equal(flowFor("t\u0000a").dataset.active, undefined);
	f.graph.update([{ ...f.members[0], status: "IDLE", communication: { active: true, status: "RUNNING" } }, f.members[1], f.members[2]]);
	assert.equal(flowFor("t\u0000a").dataset.active, "true", "只读回答也算活动");
	f.graph.setReducedMotion(true); assert.equal(f.shell.dataset.motion, "off");
	f.graph.setConnected(false); assert.equal(f.shell.dataset.motion, "off");
	f.graph.destroy();
});

test("parallel active members ride separate lanes on one shared beat", () => {
	const f = fixture(), flowFor = (key: string) => f.flows().find((n: Element) => n.dataset.key === key)!;
	const active = ["t\u0000a", "t\u0000b", "t\u0000c"].map(flowFor);
	const paths = new Set(active.map((flow) => flow.getAttribute("d")));
	assert.equal(paths.size, 3, "并行的三条丝带各占一条车道，不重叠");
	const delay = active.map((flow) => flow.style.animationDelay);
	assert.ok(delay.every((value) => value === delay[0]), `同一节拍：${delay.join(",")}`);
	assert.match(delay[0]!, /^-\d+ms$/u);
	for (const flow of f.flows()) assert.equal(flow.getAttribute("pathLength"), undefined, "涌动按固定空间周期，不再按路径百分比");
	// 车道稳定：状态不变时反复更新不重算路径，成员卡不会抖动。
	const writes = active.map((flow) => flow.writes);
	for (let i = 0; i < 50; i++) f.graph.update(f.members);
	assert.deepEqual(active.map((flow) => flow.writes), writes);
	f.graph.destroy();
});

test("leader carries live counts and stays the only dark surface", () => {
	const f = fixture(), stats = f.root.querySelectorAll(".cg-stat");
	assert.equal(stats.length, 3);
	assert.equal(stats[0].children[0].textContent, "3", "成员数来自真实节点");
	assert.equal(stats[1].children[0].textContent, "3", "进行中数来自真实状态");
	f.graph.communication(f.message({ status: "QUEUED" }));
	assert.equal(f.root.querySelectorAll(".cg-stat")[2].children[0].textContent, "1", "排队数来自真实投递");
	f.graph.destroy();
});

test("every running member keeps its pulse even when an edge carries a queued message", () => {
	const f = fixture(), key = (id: string) => `t\u0000${id}`;
	f.graph.communication(f.message({ from: "@leader", to: key("a"), kind: "dispatch", status: "QUEUED" }), false);
	const active = [...f.root.querySelectorAll(".cg-flow")].filter((node: Element) => node.dataset.active === "true").map((node: Element) => node.dataset.key);
	assert.deepEqual(active.sort(), [key("a"), key("b"), key("c")].sort(), "并发成员都保持涌动，排队状态只让归属丝带让位");
	f.graph.destroy();
});

test("parallel members leave the leader card at separate junction points", () => {
	const f = fixture();
	const start = (id: string) => {
		const edge = [...f.root.querySelectorAll(".cg-ribbon")].find((node: Element) => String(node.getAttribute("d")).startsWith("M") && node.dataset.key?.endsWith(id));
		assert.ok(edge, `找不到 ${id} 的归属线`);
		return Number(String(edge.getAttribute("d")).split(/[ ,]/u)[1]);
	};
	const a = start("a"), b = start("b");
	assert.notEqual(a, b, "两名并行成员在主 Agent 卡上各有交点");
	assert.ok(Math.abs(a - b) > 10, "交点间距足够看出两条线分开");
	f.graph.destroy();
});

test("stopped seats stay hidden until the member is dispatched again", () => {
	const f = fixture(), nodeCount = () => f.root.querySelectorAll(".cg-node").length;
	const before = nodeCount();
	assert.equal(before, 4, "主 Agent + 3 名成员");
	f.graph.update([{ ...f.members[0], status: "STOPPED" }, f.members[1], f.members[2]]);
	assert.equal(nodeCount(), before - 1, "停止的席位不再画在图上");
	assert.equal(f.root.querySelectorAll(".cg-hidden")[0].textContent, "已隐藏 1 位已停止成员");
	assert.equal(f.root.querySelectorAll(".cg-stat")[0].children[0].textContent, "3", "成员计数仍按名册口径");
	f.graph.update(f.members);
	assert.equal(nodeCount(), before, "重新派发后自动回来");
	assert.equal(f.root.querySelectorAll(".cg-hidden")[0].textContent, "");
	f.graph.destroy();
});

test("peer traffic keeps both directions, separate arcs, and non-overlapping labels", () => {
	const f = fixture(), key = (id: string) => `t\u0000${id}`;
	f.graph.communication(f.message({ from: key("a"), to: key("b"), kind: "question", status: "DELIVERED" }), false);
	f.graph.communication(f.message({ from: key("b"), to: key("a"), kind: "answer", status: "DELIVERED" }), false);
	const edges = f.root.querySelectorAll(".cg-edge");
	assert.equal(edges.length, 2, "方向不同的两条关系不再合并成一条");
	assert.notEqual(edges[0].getAttribute("d"), edges[1].getAttribute("d"), "相反方向各占一条弧");
	const labels = f.root.querySelectorAll(".cg-edge-label");
	assert.equal(labels.length, 2);
	assert.notEqual(labels[0].style.top, labels[1].style.top, "同一区域的标签互相避让");
	const before = edges.map((edge: Element) => edge.getAttribute("d"));
	f.graph.communication(f.message({ from: key("c"), to: key("b"), kind: "message", status: "DELIVERED" }), false);
	assert.deepEqual(edges.slice(0, 2).map((edge: Element) => edge.getAttribute("d")), before, "新增关系不会让既有同伴车道换位");
	f.graph.destroy();
});

test("recent success fades; queued and failed relationships remain until removed", () => {
	const f = fixture(); f.graph.communication(f.message(), false); f.advance(31000);
	assert.equal(f.root.querySelectorAll(".cg-edge").length, 0);
	f.graph.communication(f.message({ status: "FAILED", reason: "answer" })); f.advance(60000);
	assert.equal(f.root.querySelectorAll(".cg-edge-label")[0].textContent, "提问 · 回答失败");
	f.graph.removeCommunications([]); // 空删除不破坏持久关系。
	f.graph.communication(f.message());
	assert.equal(f.root.querySelectorAll(".cg-edge-label")[0].textContent, "提问 · 回答失败", "新成功不能遮盖旧失败");
	f.graph.communication(f.message({ kind: "message", status: "QUEUED" }));
	assert.equal(f.root.querySelectorAll(".cg-edge-label")[0].textContent, "留言 · 排队 · 1失败");
	assert.equal(f.root.querySelectorAll(".cg-edge").length, 1); f.graph.destroy();
});

test("same names across teams cannot cross-wire and absent sources are ignored", () => {
	const f = fixture(); f.graph.update([...f.members, { key: "u\u0000a", team: "u", id: "a", status: "IDLE" }]);
	f.graph.communication(f.message({ to: "u\u0000a" }));
	f.graph.communication(f.message({ from: "missing" }));
	assert.equal(f.root.querySelectorAll(".cg-edge").length, 0);
	f.graph.communication(f.message()); assert.equal(f.root.querySelectorAll(".cg-edge").length, 1); f.graph.destroy();
});

test("destroy cleans timers, animation frames, media listeners, observer and root", () => {
	const f = fixture(); f.graph.communication(f.message());
	assert.equal(f.mediaListeners.size, 1); assert.equal(f.frames.size, 0); assert.ok(f.timers.size > 0);
	f.graph.destroy(); f.graph.destroy(); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
	assert.equal(f.mediaListeners.size, 0); assert.equal(f.disconnected, 1); assert.equal(f.root.children.length, 0);
});

/* 流式布局：画布宽跟着容器走，缩放只在画布被下限顶住时保底；适配层拿到缩放后的尺寸。 */
const scaleOf = (f: ReturnType<typeof fixture>) => Number(String(f.canvas().style.transform).replace(/[^0-9.]/gu, ""));
const canvasW = (f: ReturnType<typeof fixture>) => parseFloat(f.canvas().style.width);
const frameW = (f: ReturnType<typeof fixture>) => parseFloat(f.frame().style.width);
const scroll = (f: ReturnType<typeof fixture>) => f.root.querySelectorAll(".cg-scroll")[0];
const boxOf = (f: ReturnType<typeof fixture>, index: number) => { const node = f.root.querySelectorAll(".cg-node")[index]; return { left: parseFloat(node.style.left), width: parseFloat(node.style.width) }; };
const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 0.001, `${label}: ${actual} ≠ ${expected}`);

test("fitScale clamps container width against the unscaled canvas width", () => {
	const f = fixture(), fit = f.window.CollaborationGraph.fitScale;
	assert.deepEqual([700, 900, 1200].map((width) => fit(width, 980)), [0.75, 0.918, 1], "700→0.75，画布 980 时 900→0.918，1200→1");
	assert.equal(fit(700, 980), 0.75, "700/980 低于可读下限，停在下限");
	assert.equal(fit(900, 980), fit(900, 980), "纯函数反复调用结果一致，无副作用");
	assert.equal(fit(1200, 980), 1, "容器比画布宽时不再放大");
	assert.equal(fit(600, 820), 0.75, "紧凑画布同样受 0.75 下限约束");
	assert.equal(fit(0, 980), 1, "未挂载或宽度未知时不缩放");
	assert.ok(980 * fit(900, 980) <= 900, "画布宽×k 不越过容器，不会撑出亚像素滚动条");
	assert.equal(fit(820, 820), 1, "画布已经跟到容器宽时缩放保持 1");
	f.graph.destroy();
});

test("canvasWidth follows the container inside hard clamps instead of a fixed 980/820", () => {
	const f = fixture(), width = f.window.CollaborationGraph.canvasWidth;
	assert.deepEqual([698, 640, 980, 1200].map((px) => width(px, false)), [698, 640, 980, 980], "非紧凑 clamp(容器内容宽, 640, 980)");
	assert.deepEqual([400, 320, 480, 560, 820, 1600].map((px) => width(px, true)), [560, 560, 560, 560, 820, 820], "紧凑 clamp(容器内容宽, 560, 820)");
	assert.equal(width(698.9, false), 698, "向下取整，缩放后的宽不会亚像素越过容器");
	assert.equal(width(0, false), 980, "宽度未知（未挂载）时退回上限，保持原图");
	assert.equal(width(Number.NaN, true), 820, "NaN 一样退回上限");
	f.graph.destroy();
});

test("graphMetrics never lets the member column leave the canvas at any width", () => {
	const f = fixture(), metrics = f.window.CollaborationGraph.graphMetrics;
	// 画布宽的下限就是两个卡片硬下限排得开的宽：560（紧凑）/ 640（常规），所以每一档都不许缩卡片。
	for (const width of [560, 600, 639, 640, 660, 698, 780, 820, 900, 980]) {
		const compact = width < 640, m = metrics(width, compact);
		assert.ok(m.memberRight <= width - 12, `${width}/${compact ? "紧凑" : "常规"}：成员右缘 ${m.memberRight} 不越过画布 ${width}`);
		assert.ok(m.leaderRight < m.memberX, `${width}：主卡右缘 ${m.leaderRight} 在成员列 ${m.memberX} 左侧，不碰撞`);
		assert.ok(m.trunk > m.leaderRight && m.trunk < m.memberX, `${width}：主干 ${m.trunk} 落在两列之间`);
		assert.ok(m.leaderW >= 196, `${width}：主卡不低于硬下限 196（${m.leaderW}）`);
		assert.ok(m.memberW >= 168, `${width}：成员卡不低于硬下限 168（${m.memberW}）`);
		assert.equal(m.width, width, "分配器不改画布宽");
	}
	const at560 = metrics(560, true);
	assert.deepEqual([at560.leaderW, at560.memberW, at560.memberRight], [196, 171, 428], "最小紧凑画布上两张卡仍分别是 196 / 171");
	assert.deepEqual([metrics(980, false), metrics(820, true)].map((m) => [m.leaderX, m.leaderW, m.memberX, m.memberW, m.trunk]), [[28, 236, 420, 278, 340], [28, 196, 320, 250, 240]], "两个参考宽度还原改造前的坐标");
	f.graph.destroy();
});

test("the graph root scales to the fitted size; node boxes stay unscaled", () => {
	const f = fixture();
	f.resize(700);
	const canvas = f.canvas();
	assert.equal(canvas.style.transform, "scale(1)", "700 宽容器：画布跟着收到 700，不需要缩放");
	assert.equal(canvas.style.transformOrigin, "0 0");
	assert.equal(canvas.parentNode?.className, "cg-frame", "缩放层外面要套一层适配容器");
	assert.ok(canvas.children.some((child) => child.className === "cg-lines"), "线条层与节点在同一个被缩放的元素里");
	assert.equal(canvas.querySelectorAll(".cg-node").length, 4, "节点也在同一个被缩放的元素里");
	const m = f.window.CollaborationGraph.graphMetrics(700, false), node = boxOf(f, 1);
	assert.equal(node.left, m.memberX, "成员列左缘按画布宽等比分配（700 → 300）");
	assert.equal(node.width, m.memberW, "成员卡宽按画布宽等比分配（700 → 199）");
	assert.equal(node.left, 300); assert.equal(node.width, 199);
	assert.equal(f.root.querySelectorAll(".cg-node")[1].style.transform ?? "", "", "节点自身不缩放");
	f.graph.destroy();
});

test("adapter frame takes the scaled size so the scroll area matches the fitted graph", () => {
	const f = fixture();
	const height = parseFloat(f.canvas().style.height), width = parseFloat(f.canvas().style.width);
	assert.equal(width, 980);
	assert.ok(height > 0);
	f.resize(698);
	assert.equal(canvasW(f), 698, "画布宽跟着容器走");
	assert.equal(frameW(f), 698, "适配层宽度 = 画布宽 × 缩放比");
	assert.ok(frameW(f) <= scroll(f).clientWidth, "适配层不越过滚动区内容宽");
	assert.equal(parseFloat(f.frame().style.height), height, "缩放比 1 时高度不缩");
	f.resize(240);
	close(scaleOf(f), 0.75, "240 宽：画布被 560 下限顶住，缩到可读下限");
	assert.equal(canvasW(f), 560, "紧凑画布下限 560");
	close(frameW(f), 420, "560×0.75 = 420，比容器宽，于是允许横滚");
	close(parseFloat(f.frame().style.height), height * 0.75, "适配层高度 = 图高 × 缩放比");
	assert.match(SOURCE, /\.cg-frame \{[^}]*overflow:hidden/u, "适配层裁掉未缩放的布局溢出，滚动区不会按原尺寸留白");
	f.graph.destroy();
});

test("half-screen container (698px) fits with scale 1 and no horizontal overflow", () => {
	const f = fixture();
	f.resize(698);
	const node = boxOf(f, 1), card = boxOf(f, 0);
	assert.equal(canvasW(f), 698, "画布宽 = 容器内容宽，不再是死值 980");
	assert.equal(scaleOf(f), 1, "不需要缩小");
	assert.equal(f.shell.dataset.scale, "1");
	assert.ok(frameW(f) <= scroll(f).clientWidth, `内容宽 ${frameW(f)} ≤ clientWidth ${scroll(f).clientWidth}，没有横向滚动条`);
	assert.ok(canvasW(f) * scaleOf(f) <= scroll(f).clientWidth, "画布×缩放不越过滚动区");
	const m = f.window.CollaborationGraph.graphMetrics(698, false);
	assert.equal(node.left, m.memberX); assert.equal(node.width, m.memberW);
	assert.ok(node.left + node.width <= 698, "成员卡完整落在画布内");
	assert.ok(card.left + card.width < node.left, "主卡与成员卡不重叠");
	assert.equal(m.memberW, 198, "698 下成员卡宽 198，仍可读");
	f.graph.destroy();
});

test("wide container keeps the pre-change 980 layout; mid and compact widths reflow", () => {
	const f = fixture();
	assert.equal(canvasW(f), 980, "1200 宽容器：画布仍是 980");
	assert.equal(scaleOf(f), 1);
	assert.deepEqual([boxOf(f, 0).left, boxOf(f, 0).width, boxOf(f, 1).left, boxOf(f, 1).width], [28, 236, 420, 278], "与改造前坐标一致");
	f.resize(900);
	assert.equal(canvasW(f), 900, "900 ≥ 640：画布跟着容器收窄到 900");
	assert.equal(scaleOf(f), 1, "仍不需要缩放");
	assert.equal(boxOf(f, 1).left + boxOf(f, 1).width, 641, "成员列按比例前移");
	f.resize(480);
	assert.equal(canvasW(f), 560, "480 < 640：紧凑画布被 560 下限顶住");
	close(scaleOf(f), 0.857, "480/560 = 0.857，靠缩放铺满");
	assert.ok(frameW(f) <= 480, "缩放后不越过容器");
	assert.ok(boxOf(f, 1).left + boxOf(f, 1).width <= 560 - 12, "紧凑布局不溢出画布");
	assert.ok(boxOf(f, 0).left + boxOf(f, 0).width < boxOf(f, 1).left, "紧凑布局主卡与成员卡不碰撞");
	assert.equal(boxOf(f, 0).width, 196, "主卡硬下限 196");
	assert.ok(boxOf(f, 1).width >= 168, "成员卡硬下限 168");
	f.resize(300);
	assert.equal(canvasW(f), 560, "300 也停在紧凑画布下限 560");
	close(scaleOf(f), 0.75, "300/560 低于可读下限，停在 0.75");
	assert.equal(f.shell.dataset.scale, "0.75");
	assert.ok(frameW(f) > 300, "0.75 仍放不下才允许横滚");
	f.resize(200);
	close(scaleOf(f), 0.75, "再窄也停在下限而不是继续缩");
	close(frameW(f), 420, "缩放后的内容宽固定为 420，超出的部分横滚");
	f.graph.destroy();
});

test("multiple teams at half width keep headings and cards inside the canvas", () => {
	const f = fixture();
	f.graph.update([...f.members, { key: "t\u0000d", team: "t", id: "d", role: "角色", status: "IDLE" }, { key: "u\u0000e", team: "u", id: "e", role: "角色", status: "RUNNING" }]);
	f.resize(698);
	const headings = f.root.querySelectorAll(".cg-team");
	assert.equal(headings.length, 2, "两个团队各有标题");
	for (const heading of headings) assert.ok(parseFloat(heading.style.left) + parseFloat(heading.style.width) <= 698, "团队标题不越过画布右缘");
	for (const node of f.root.querySelectorAll(".cg-node")) assert.ok(parseFloat(node.style.left) + parseFloat(node.style.width) <= 698, "所有卡片都在画布内");
	assert.equal(f.frame().style.width, "698px", "适配层等于画布宽，滚动区不留白");
	assert.equal(scaleOf(f), 1);
	f.graph.destroy();
});

test("container resize re-allocates the columns; same width keeps hitting the layout cache", () => {
	const f = fixture(), node = f.root.querySelectorAll(".cg-node")[1];
	assert.equal(boxOf(f, 1).left, 420, "1200 宽起点");
	f.resize(700);
	assert.equal(f.root.querySelectorAll(".cg-node")[1], node, "成员没变就不重建节点");
	assert.equal(boxOf(f, 1).left, 300, "列宽按新画布重新分配");
	const ribbon = f.root.querySelectorAll(".cg-ribbon")[0], writes = ribbon.writes, path = ribbon.getAttribute("d");
	for (let i = 0; i < 10; i++) f.graph.update(f.members);
	assert.equal(ribbon.writes, writes, "同一容器宽下继续命中 layoutKey，不重画线条");
	assert.equal(ribbon.getAttribute("d"), path);
	f.resize(1200);
	assert.equal(canvasW(f), 980, "回到 1200 宽：恢复 980 画布");
	assert.equal(boxOf(f, 1).left, 420, "列宽复位");
	assert.equal(f.root.querySelectorAll(".cg-node")[1], node, "往返缩放都不重建成员卡");
	f.graph.destroy();
});

test("edge labels stay inside the compact canvas instead of being clipped", () => {
	const f = fixture(), key = (id: string) => `t\u0000${id}`;
	f.graph.communication(f.message({ from: key("a"), to: key("b"), kind: "question", status: "DELIVERED" }), false);
	f.graph.communication(f.message({ from: "@leader", to: key("a"), kind: "dispatch", status: "QUEUED" }), false);
	f.resize(480);
	const width = parseFloat(f.canvas().style.width);
	assert.equal(width, 560, "紧凑画布被 560 下限顶住");
	const labels = f.root.querySelectorAll(".cg-edge-label");
	assert.equal(labels.length, 2);
	for (const label of labels) {
		const left = parseFloat(label.style.left), top = parseFloat(label.style.top);
		assert.ok(left >= 4, `标签左缘留在画布内：${left}`);
		assert.ok(left + 96 <= width - 4, `标签右缘不越过画布：${left + 96} ≤ ${width - 4}`);
		assert.ok(top >= 4 && top <= 440);
	}
	assert.ok(labels.some((label: Element) => parseFloat(label.style.left) === width - 96 - 4), "同伴标签本来会越过右缘，被夹到画布内边距上");
	f.graph.destroy();
});

/* 紧凑下限：画布 560 上两张卡是硬约束（196/168），低于 560 只能靠缩放，0.75 还放不下才横滚；
 * 同时紧凑主卡的标签不许逐字拆行、文本行不许被压扁。 */
test("compact floor holds 196/168 hard, scales below 560, and the leader text never collapses", () => {
	const f = fixture(), LEADER_H = 146;
	// 假 DOM 没有排版引擎，量的是「防塌陷」规则本身：行不缩、计数整组换行、数字+标签不拆字。
	assert.match(SOURCE, /\.cg-heading,\.cg-role,\.cg-stats,\.cg-action \{ flex-shrink:0; \}/u, "文本行禁止被 flex 压成几像素");
	assert.match(SOURCE, /\.cg-stats \{[^}]*flex-wrap:wrap/u, "计数在「数字+标签」之间换行");
	assert.match(SOURCE, /\.cg-stat \{[^}]*white-space:nowrap/u, "单个计数不逐字拆行");
	assert.match(SOURCE, /\.cg-node\[data-leader="true"\] \.cg-heading \{ flex-wrap:wrap; \}/u, "主卡名字先占满一行，徽标让到下一行");
	for (const container of [320, 360, 400, 440]) {
		f.resize(container);
		const canvas = canvasW(f), leader = f.root.querySelectorAll(".cg-node")[0], member = f.root.querySelectorAll(".cg-node")[1];
		assert.equal(canvas, 560, `${container}：紧凑画布被 560 下限顶住`);
		assert.equal(parseFloat(leader.style.width), 196, `${container}：主卡硬下限 196`);
		assert.ok(parseFloat(member.style.width) >= 168, `${container}：成员卡硬下限 168（${member.style.width}）`);
		assert.ok(parseFloat(member.style.left) + parseFloat(member.style.width) <= canvas - 12, `${container}：成员列不越过画布`);
		assert.ok(parseFloat(leader.style.left) + parseFloat(leader.style.width) < parseFloat(member.style.left), `${container}：主卡与成员卡不碰撞`);
		const expected = Math.min(1, Math.max(0.75, Math.floor((container / 560) * 1000) / 1000));
		close(scaleOf(f), expected, `${container}：scale = clamp(容器/560, 0.75, 1)`);
		close(frameW(f), 560 * expected, `${container}：适配层 = 560×scale`);
		if (560 * expected > container) assert.ok(frameW(f) > container, `${container}：0.75 仍放不下，于是放行横滚`);
		else assert.ok(frameW(f) <= container, `${container}：缩放后铺得下，不横滚`);
		assert.equal(parseFloat(leader.style.height), LEADER_H, `${container}：196 宽下主卡内容仍是一行排得下的 146`);
	}
	const leaderAfter = f.root.querySelectorAll(".cg-node")[0];
	leaderAfter.scrollHeight = 182;
	f.graph.update(f.members);
	assert.equal(parseFloat(f.root.querySelectorAll(".cg-node")[0].style.height), 184, "内容真的超过 146 时按内容加高，而不是压扁文字");
	leaderAfter.scrollHeight = 0;
	f.resize(696);
	assert.equal(canvasW(f), 696, "真实页里 698 容器去掉 1px 边框后就是 696");
	assert.equal(scaleOf(f), 1);
	assert.deepEqual([boxOf(f, 0).width, parseFloat(f.root.querySelectorAll(".cg-node")[0].style.height), boxOf(f, 1).width], [196, 146, 197], "696：主卡 196×146、成员 197");
	f.resize(1200);
	assert.deepEqual([canvasW(f), boxOf(f, 0).width, parseFloat(f.root.querySelectorAll(".cg-node")[0].style.height), boxOf(f, 1).width], [980, 236, 146, 278], "1200：980 / 236×146 / 278，与改造前一致");
	assert.equal(scaleOf(f), 1, "1200 不缩放");
	f.graph.destroy();
});
