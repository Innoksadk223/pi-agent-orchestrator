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
	const doc: any = { createElement: (tag: string) => new Element(tag, doc), createElementNS: (_: string, tag: string) => new Element(tag, doc) };
	const window: any = { document: doc, requestAnimationFrame: (run: () => void) => { frames.set(++seq, run); return seq; }, cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout: (run: () => void, ms: number) => { timers.set(++seq, { at: time + ms, run }); return seq; }, clearTimeout: (id: number) => timers.delete(id), matchMedia: () => ({ matches: false, addEventListener: (_: string, run: (event: any) => void) => mediaListeners.add(run), removeEventListener: (_: string, run: (event: any) => void) => mediaListeners.delete(run) }), ResizeObserver: class { observe() {} disconnect() { disconnected++; } } };
	runInNewContext(SOURCE, { window });
	const root = new Element("main", doc), selections: string[] = [];
	const graph = window.CollaborationGraph.create(root, { now: () => time, onSelect: (key: string) => selections.push(key), nonce: "safe-nonce" });
	const members = ["a", "b", "c"].map((id) => ({ key: `t\u0000${id}`, team: "t", id, role: "角色", status: "RUNNING", activities: [{ label: "思考中", detail: "不可显示的正文" }] }));
	graph.update(members);
	const flows = () => root.querySelectorAll(".cg-flow");
	return { root, graph, members, selections, timers, frames, mediaListeners, flows, get disconnected() { return disconnected; }, get shell() { return root.children[0]; }, advance(ms: number) { time += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((run) => run()); for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.run(); } }, message(overrides: any = {}) { return { id: `m${++seq}`, from: "t\u0000a", to: "t\u0000b", kind: "question", status: "DELIVERED", at: time, ...overrides }; } };
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
