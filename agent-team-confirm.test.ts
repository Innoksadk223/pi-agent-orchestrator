import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	AgentTeamConfirmComponent,
	confirmAgentTeam,
	sanitizeConfirmationText,
} from "./agent-team-confirm.ts";

const DEFAULT_KEYS: Record<string, string[]> = {
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"],
	"tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
};

function keybindings(bindings: Record<string, string[]> = DEFAULT_KEYS): KeybindingsManager {
	return {
		matches: (data: string, binding: string) => (bindings[binding] ?? []).includes(data),
		getKeys: (binding: string) => bindings[binding] ?? [],
	} as unknown as KeybindingsManager;
}

/** Distinct SGR code per theme token so structural coloring is observable in assertions. */
const THEME_CODES: Record<string, string> = {
	accent: "35",
	text: "39",
	dim: "90",
	muted: "37",
	border: "94",
	success: "32",
	selectedBg: "44",
};

function theme(codes: Record<string, string> = THEME_CODES): Theme {
	return {
		fg: (color: string, text: string) => `\x1b[${codes[color] ?? "39"}m${text}\x1b[0m`,
		bg: (color: string, text: string) => `\x1b[${codes[color] ?? "44"}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as unknown as Theme;
}

type TestTui = TUI & { renders: number; setRows(rows: number): void };

function tui(rows: number): TestTui {
	let currentRows = rows;
	return {
		terminal: {
			get rows() { return currentRows; },
			get columns() { return 120; },
		},
		renders: 0,
		setRows(value: number) {
			currentRows = value;
		},
		requestRender() {
			this.renders++;
		},
	} as unknown as TestTui;
}

function component(options: {
	rows?: number;
	title?: string;
	message?: string;
	theme?: Theme;
	keys?: KeybindingsManager;
	signal?: AbortSignal;
	timeout?: number;
	onDone?: (confirmed: boolean) => void;
} = {}): { dialog: AgentTeamConfirmComponent; ui: TestTui } {
	const ui = tui(options.rows ?? 12);
	return {
		dialog: new AgentTeamConfirmComponent({
			title: options.title ?? "Authorize persistent Agent",
			message: options.message ?? "审阅此成员授权。 ".repeat(80) + "unbroken_".repeat(80),
			tui: ui,
			theme: options.theme ?? theme(),
			keybindings: options.keys ?? keybindings(),
			onDone: options.onDone ?? (() => undefined),
			signal: options.signal,
			timeout: options.timeout,
		}),
		ui,
	};
}

function plain(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

test("confirmation text removes terminal controls and bidi overrides while preserving Unicode and newlines", () => {
	const clean = sanitizeConfirmationText("正常中文\nline\x1b[31m red\x1b[0m\u0000\u0007\u202Ehidden\u2066");
	assert.equal(clean, "正常中文\nline redhidden");
});

test("long confirmation keeps Approve and Reject visible within 20/40/120 columns and low/normal heights", () => {
	const hostile = "长文本审批内容 ".repeat(120) + "X".repeat(300) + "\x1b[2J\u202Eunsafe";
	for (const width of [20, 40, 120]) {
		for (const rows of [2, 3, 5, 12]) {
			const { dialog } = component({ rows, message: hostile });
			const lines = dialog.render(width);
			const output = plain(lines).join("\n");
			assert.ok(lines.length <= rows, `${width}x${rows} exceeded its height budget`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows} exceeded its width`);
			assert.match(output, /Approve/u);
			assert.match(output, /Reject/u);
			assert.doesNotMatch(output, /\u202E|\x1b|\u0007/u);
			dialog.dispose();
		}
	}
});

test("arrow keys switch buttons, Enter commits the selection, Tab toggles, Esc always rejects", () => {
	const decisions: boolean[] = [];

	const defaults = component({ onDone: (value) => decisions.push(value) });
	let rendered = plain(defaults.dialog.render(40)).join("\n");
	assert.match(rendered, /> Approve/u, "Approve is selected by default");
	assert.match(rendered, / {2}Reject/u, "Reject starts unselected");
	defaults.dialog.handleInput("enter");
	assert.deepEqual(decisions, [true], "Enter on the default selection approves");

	const reject = component({ onDone: (value) => decisions.push(value) });
	reject.dialog.render(40);
	reject.dialog.handleInput("\x1b[C"); // right
	rendered = plain(reject.dialog.render(40)).join("\n");
	assert.match(rendered, / {2}Approve/u);
	assert.match(rendered, /> Reject/u);
	reject.dialog.handleInput("enter");
	assert.deepEqual(decisions, [true, false], "Enter after moving right rejects");

	const back = component({ onDone: (value) => decisions.push(value) });
	back.dialog.handleInput("\x1b[C"); // right
	back.dialog.handleInput("\x1b[D"); // left
	rendered = plain(back.dialog.render(40)).join("\n");
	assert.match(rendered, /> Approve/u);
	back.dialog.handleInput("enter");
	assert.deepEqual(decisions, [true, false, true], "left moves back to Approve");

	const toggle = component({ onDone: (value) => decisions.push(value) });
	toggle.dialog.handleInput("\t");
	assert.match(plain(toggle.dialog.render(40)).join("\n"), /> Reject/u);
	toggle.dialog.handleInput("\t");
	assert.match(plain(toggle.dialog.render(40)).join("\n"), /> Approve/u);

	const escaped = component({ onDone: (value) => decisions.push(value) });
	escaped.dialog.handleInput("\x1b[C"); // right
	escaped.dialog.handleInput("escape");
	assert.deepEqual(decisions, [true, false, true, false], "Esc rejects regardless of selection");

	const ctrlC = component({ onDone: (value) => decisions.push(value) });
	ctrlC.dialog.handleInput("ctrl+c");
	assert.deepEqual(decisions, [true, false, true, false, false]);
});

test("injected bindings scroll the body while actions stay fixed, confirm, and cancel", () => {
	const custom = keybindings({
		"tui.select.up": ["k"],
		"tui.select.down": ["j"],
		"tui.select.pageUp": ["u"],
		"tui.select.pageDown": ["d"],
		"tui.select.confirm": ["ok"],
		"tui.select.cancel": ["quit", "break"],
	});
	const message = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
	const decisions: boolean[] = [];
	const { dialog, ui } = component({ rows: 8, message, keys: custom, onDone: (value) => decisions.push(value) });

	let output = plain(dialog.render(40)).join("\n");
	assert.match(output, /^line-0[│█]?$/mu);
	assert.match(output, /Approve.*Reject/u, "action row stays visible while scrolling");

	dialog.handleInput("j");
	output = plain(dialog.render(40)).join("\n");
	assert.doesNotMatch(output, /^line-0[│█]?$/mu);
	assert.match(output, /^line-3[│█]?$/mu);
	assert.match(output, /Approve.*Reject/u);

	dialog.handleInput("k");
	output = plain(dialog.render(40)).join("\n");
	assert.match(output, /^line-0[│█]?$/mu);

	dialog.handleInput("d");
	output = plain(dialog.render(40)).join("\n");
	assert.match(output, /^line-4[│█]?$/mu, "page down jumps by the body page size");

	dialog.handleInput("u");
	output = plain(dialog.render(40)).join("\n");
	assert.match(output, /^line-1[│█]?$/mu, "page up returns by the body page size");
	assert.ok(ui.renders >= 4);

	dialog.handleInput("ok");
	assert.deepEqual(decisions, [true]);

	const cancelled = component({ keys: custom, onDone: (value) => decisions.push(value) });
	cancelled.dialog.handleInput("quit");
	assert.deepEqual(decisions, [true, false]);
});

test("PageUp/PageDown and Up/Down scroll wrapped content and resize reclamps while actions stay fixed", () => {
	const message = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
	const { dialog, ui } = component({ rows: 8, message });
	const first = plain(dialog.render(40)).join("\n");
	assert.match(first, /^line-0[│█]?$/mu);

	dialog.handleInput("down");
	const second = plain(dialog.render(40)).join("\n");
	assert.notEqual(second, first);
	assert.doesNotMatch(second, /^line-0[│█]?$/mu);
	assert.match(second, /^line-1[│█]?$/mu);
	assert.match(second, /Approve.*Reject/u);

	dialog.handleInput("up");
	assert.match(plain(dialog.render(40)).join("\n"), /^line-0[│█]?$/mu);

	dialog.handleInput("pageDown");
	assert.match(plain(dialog.render(40)).join("\n"), /^line-3[│█]?$/mu);
	dialog.handleInput("pageUp");
	assert.match(plain(dialog.render(40)).join("\n"), /^line-0[│█]?$/mu);
	assert.ok(ui.renders >= 4);

	ui.setRows(3);
	const resized = dialog.render(20);
	assert.ok(resized.length <= 3);
	assert.ok(resized.every((line) => visibleWidth(line) <= 20));
	const resizedText = plain(resized).join("\n");
	assert.match(resizedText, /Approve/u);
	assert.match(resizedText, /Reject/u);

	for (let i = 0; i < 200; i++) dialog.handleInput("pageDown");
	const clamped = plain(dialog.render(20)).join("\n");
	assert.match(clamped, /^line-79[│█]?$/mu, "scroll offset reclamps to the new viewport");
	dialog.dispose();
});

test("scrollbar appears only on overflow and its thumb follows the scroll offset", () => {
	const message = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
	const { dialog } = component({ rows: 12, message });

	// rows=12 -> title + separator + 7 body rows + separator + actions + help.
	const lines = dialog.render(60);
	const stripped = plain(lines);
	const body = stripped.slice(2, 9);
	assert.equal(body.length, 7);
	assert.equal(body[0]?.endsWith("█"), true, "thumb starts at the top of the track");
	assert.ok(body.slice(1).every((line) => line.endsWith("│")), "track fills the remaining rows");

	dialog.handleInput("pageDown");
	const shifted = plain(dialog.render(60)).slice(2, 9);
	assert.equal(shifted[1]?.endsWith("█"), true, "thumb moves down after one page");

	for (let i = 0; i < 6; i++) dialog.handleInput("pageDown");
	const bottom = plain(dialog.render(60)).slice(2, 9);
	assert.equal(bottom[6]?.endsWith("█"), true, "thumb reaches the bottom of the track");
	assert.equal(bottom[0]?.endsWith("│"), true);
	dialog.dispose();

	const short = component({ rows: 12, message: "everything fits on one line" });
	const fits = plain(short.dialog.render(60)).join("\n");
	assert.doesNotMatch(fits, /[│█]/u, "no scrollbar when content fits");
	assert.match(fits, /everything fits on one line/u);
	short.dialog.dispose();
});

test("body renders structured colors: section headings, key/value rows, and list bullets", () => {
	const message = [
		"Team: ops",
		"Roster (2; persistent model sessions may incur cost):",
		"- alpha: lead / coder / tools=all",
		"- beta: reviewer",
		"Plain closing prose without a colon.",
	].join("\n");
	const { dialog } = component({ rows: 12, message, title: "Plan gate" });
	const lines = dialog.render(120);

	const keyValue = lines.find((line) => stripTerminalSequences(line).startsWith("Team:"));
	assert.match(keyValue ?? "", /\x1b\[35mTeam\x1b\[0m\x1b\[90m: /u, "key/value keys use the accent color");

	const heading = lines.find((line) => stripTerminalSequences(line).startsWith("Roster"));
	assert.match(heading ?? "", /\x1b\[35m\x1b\[1mRoster \(2; persistent model sessions may incur cost\):\x1b\[22m/u, "section headings use accent + bold");

	const bullet = lines.find((line) => stripTerminalSequences(line).startsWith("- alpha"));
	assert.match(bullet ?? "", /\x1b\[35m- \x1b\[0m\x1b\[39malpha/u, "list bullets are highlighted and body text stays neutral");

	const prose = lines.find((line) => stripTerminalSequences(line) === "Plain closing prose without a colon.");
	assert.match(prose ?? "", /^\x1b\[39mPlain closing prose without a colon\.\x1b\[0m$/u, "prose stays in the text color");
	dialog.dispose();
});

test("markdown plan confirmations render as themed styles without literal MD markers", () => {
	const message = [
		"## Team: ops",
		"**Revision:** 3 · **Reviewer:** reviewer2",
		"",
		"## Roster (2)",
		"- **coder-a** — coder · test/model · tools=read,edit",
		"- **reviewer** — reviewer · test/model",
		"",
		"## Execution DAG (1 tasks)",
		"- **task-a** → coder-a",
		"  Implement the thing.",
		"  depends: none · owns: src/a",
	].join("\n");
	const { dialog } = component({ rows: 20, message, title: "Plan gate" });
	const lines = dialog.render(120);
	const plain = lines.map(stripTerminalSequences);

	const heading = lines.find((line) => stripTerminalSequences(line).startsWith("Team: ops"));
	assert.match(heading ?? "", /\x1b\[35m\x1b\[1mTeam: ops\x1b\[22m/u, "## headings become accent + bold titles");
	assert.doesNotMatch(heading ?? "", /#/u, "heading hashes are never rendered literally");

	const revision = lines.find((line) => stripTerminalSequences(line).startsWith("Revision: 3"));
	assert.match(revision ?? "", /\x1b\[1mRevision:\x1b\[22m/u, "**bold** spans become theme weight");
	assert.doesNotMatch(revision ?? "", /\*/u, "asterisks are never rendered literally");

	const bullet = lines.find((line) => stripTerminalSequences(line).startsWith("- coder-a"));
	assert.match(bullet ?? "", /\x1b\[35m- \x1b\[0m/u, "list bullets stay accent-highlighted");
	assert.match(bullet ?? "", /\x1b\[1mcoder-a\x1b\[22m/u, "bold item names keep theme weight");
	assert.doesNotMatch(bullet ?? "", /\*/u);

	const subLine = plain.find((line) => line === "  depends: none · owns: src/a");
	assert.ok(subLine, "indented task detail lines survive rendering");
	dialog.dispose();
});

test("timeout and AbortSignal cancel once, while dispose removes pending callbacks", async () => {
	const countdown = component({ timeout: 5_000 });
	assert.match(plain(countdown.dialog.render(40)).join("\n"), /\([45]s\)/u);
	countdown.dialog.dispose();

	const timed: boolean[] = [];
	component({ timeout: 5, onDone: (value) => timed.push(value) });
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.deepEqual(timed, [false]);

	const controller = new AbortController();
	const aborted: boolean[] = [];
	component({ signal: controller.signal, onDone: (value) => aborted.push(value) });
	controller.abort();
	assert.deepEqual(aborted, [false]);

	for (const key of ["escape", "ctrl+c"]) {
		const cancelled: boolean[] = [];
		component({ onDone: (value) => cancelled.push(value) }).dialog.handleInput(key);
		assert.deepEqual(cancelled, [false]);
	}

	const disposed: boolean[] = [];
	const pending = component({ timeout: 5, onDone: (value) => disposed.push(value) });
	pending.dialog.dispose();
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.deepEqual(disposed, []);
});

test("invalidate drops cached styles and rerenders with the current theme", () => {
	const codes: Record<string, string> = { ...THEME_CODES };
	const { dialog } = component({ theme: theme(codes), message: "Section:\n- item one" });
	const before = dialog.render(40).join("\n");
	assert.match(before, /\x1b\[35m/u);

	codes.accent = "36";
	dialog.invalidate();
	const rerendered = dialog.render(40).join("\n");
	assert.match(rerendered, /\x1b\[36m/u);
	assert.doesNotMatch(rerendered, /\x1b\[35m/u);
	dialog.dispose();
});

test("confirmAgentTeam uses custom TUI only in tui mode and preserves native RPC confirm", async () => {
	let nativeCalls = 0;
	let customCalls = 0;
	const ui = {
		confirm: async () => {
			nativeCalls++;
			return true;
		},
		custom: <T>(factory: any) => {
			customCalls++;
			return new Promise<T>((resolve) => {
				const dialog = factory(tui(8), theme(), keybindings(), resolve) as AgentTeamConfirmComponent;
				dialog.handleInput("enter");
			});
		},
	} as unknown as ExtensionUIContext;

	assert.equal(await confirmAgentTeam("rpc", ui, "RPC", "native"), true);
	assert.equal(nativeCalls, 1);
	assert.equal(customCalls, 0);
	assert.equal(await confirmAgentTeam("json", ui, "JSON", "native"), true);
	assert.equal(await confirmAgentTeam("print", ui, "PRINT", "native"), true);
	assert.equal(nativeCalls, 3);
	assert.equal(customCalls, 0);
	assert.equal(await confirmAgentTeam("tui", ui, "TUI", "bounded"), true);
	assert.equal(nativeCalls, 3);
	assert.equal(customCalls, 1);

	const aborted = new AbortController();
	aborted.abort();
	assert.equal(await confirmAgentTeam("tui", ui, "TUI", "aborted", { signal: aborted.signal }), false);
	assert.equal(customCalls, 1, "an already-aborted signal does not mount a component");
});
