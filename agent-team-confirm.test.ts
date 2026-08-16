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

function theme(style = "31"): Theme {
	return {
		fg: (_color: string, text: string) => `\x1b[${style}m${text}\x1b[0m`,
		bg: (_color: string, text: string) => `\x1b[4${style.slice(-1)}m${text}\x1b[0m`,
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

test("long confirmation keeps Yes and No visible within 20/40/120 columns and low/normal heights", () => {
	const hostile = "长文本审批内容 ".repeat(120) + "X".repeat(300) + "\x1b[2J\u202Eunsafe";
	for (const width of [20, 40, 120]) {
		for (const rows of [2, 3, 5, 12]) {
			const { dialog } = component({ rows, message: hostile });
			const lines = dialog.render(width);
			const output = plain(lines).join("\n");
			assert.ok(lines.length <= rows, `${width}x${rows} exceeded its height budget`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows} exceeded its width`);
			assert.match(output, /Yes/u);
			assert.match(output, /No/u);
			assert.doesNotMatch(output, /\u202E|\x1b|\u0007/u);
			dialog.dispose();
		}
	}
});

test("PageUp/PageDown scroll wrapped content and resize reclamps while actions stay fixed", () => {
	const message = Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n");
	const { dialog, ui } = component({ rows: 8, message });
	const first = plain(dialog.render(40)).join("\n");
	dialog.handleInput("pageDown");
	const second = plain(dialog.render(40)).join("\n");
	assert.notEqual(second, first);
	assert.doesNotMatch(second, /line-0(?:\n|$)/u);
	ui.setRows(3);
	const resized = dialog.render(20);
	assert.ok(resized.length <= 3);
	assert.ok(resized.every((line) => visibleWidth(line) <= 20));
	assert.match(plain(resized).join("\n"), /Yes.*No/u);
	dialog.handleInput("pageUp");
	assert.ok(ui.renders >= 2);
	dialog.dispose();
});

test("injected keybindings choose Yes/No, confirm, cancel, and scroll", () => {
	const custom = keybindings({
		"tui.select.up": ["k"],
		"tui.select.down": ["j"],
		"tui.select.pageUp": ["u"],
		"tui.select.pageDown": ["d"],
		"tui.select.confirm": ["ok"],
		"tui.select.cancel": ["quit", "break"],
	});
	const decisions: boolean[] = [];
	const no = component({ keys: custom, onDone: (value) => decisions.push(value) });
	no.dialog.render(40);
	no.dialog.handleInput("d");
	no.dialog.handleInput("j");
	no.dialog.handleInput("ok");
	assert.deepEqual(decisions, [false]);

	const yes = component({ keys: custom, onDone: (value) => decisions.push(value) });
	yes.dialog.handleInput("j");
	yes.dialog.handleInput("k");
	yes.dialog.handleInput("ok");
	assert.deepEqual(decisions, [false, true]);

	const cancelled = component({ keys: custom, onDone: (value) => decisions.push(value) });
	cancelled.dialog.handleInput("quit");
	assert.deepEqual(decisions, [false, true, false]);
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

test("invalidate renders with the current theme and never reuses old styled output", () => {
	let style = "31";
	const dynamic = {
		fg: (_color: string, text: string) => `\x1b[${style}m${text}\x1b[0m`,
		bg: (_color: string, text: string) => `\x1b[4${style.slice(-1)}m${text}\x1b[0m`,
		bold: (text: string) => text,
	} as unknown as Theme;
	const { dialog } = component({ theme: dynamic });
	assert.match(dialog.render(40).join("\n"), /\x1b\[31m/u);
	style = "36";
	dialog.invalidate();
	const rerendered = dialog.render(40).join("\n");
	assert.match(rerendered, /\x1b\[36m/u);
	assert.doesNotMatch(rerendered, /\x1b\[31m/u);
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
	assert.equal(await confirmAgentTeam("tui", ui, "TUI", "bounded"), true);
	assert.equal(nativeCalls, 1);
	assert.equal(customCalls, 1);

	const aborted = new AbortController();
	aborted.abort();
	assert.equal(await confirmAgentTeam("tui", ui, "TUI", "aborted", { signal: aborted.signal }), false);
	assert.equal(customCalls, 1, "an already-aborted signal does not mount a component");
});
