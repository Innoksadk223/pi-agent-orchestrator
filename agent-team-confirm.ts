import type {
	ExtensionUIDialogOptions,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function sanitizeConfirmationText(value: string): string {
	return stripTerminalSequences(value).replace(/\r\n?/gu, "\n").replace(CONTROL_CHARACTERS, "");
}

interface AgentTeamConfirmComponentOptions {
	title: string;
	message: string;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	onDone: (confirmed: boolean) => void;
	signal?: AbortSignal;
	timeout?: number;
}

export class AgentTeamConfirmComponent implements Component {
	private readonly title: string;
	private readonly message: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly onDone: (confirmed: boolean) => void;
	private readonly signal?: AbortSignal;
	private selected = 0;
	private scrollOffset = 0;
	private bodyPageSize = 1;
	private completed = false;
	private deadline?: number;
	private expirationTimer?: ReturnType<typeof setTimeout>;
	private countdownTimer?: ReturnType<typeof setInterval>;
	private deferredAbortTimer?: ReturnType<typeof setTimeout>;
	private abortListener?: () => void;
	private styledWrapCache: Array<{ width: number; lines: string[] }> = [];

	constructor(options: AgentTeamConfirmComponentOptions) {
		this.title = sanitizeConfirmationText(options.title).replace(/\n+/gu, " ").trim();
		this.message = sanitizeConfirmationText(options.message);
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onDone = options.onDone;
		this.signal = options.signal;

		if (options.timeout !== undefined && Number.isFinite(options.timeout)) {
			const timeout = Math.max(0, options.timeout);
			this.deadline = Date.now() + timeout;
			// Expiry without user input counts as consent; Esc/reject/abort stay rejections.
			this.expirationTimer = setTimeout(() => this.finish(true), timeout);
			this.countdownTimer = setInterval(() => this.requestRender(), 250);
			this.unref(this.expirationTimer);
			this.unref(this.countdownTimer);
		}

		this.abortListener = () => this.finish(false);
		if (this.signal?.aborted) {
			// Let ctx.ui.custom install the component before closing it.
			this.deferredAbortTimer = setTimeout(this.abortListener, 0);
			this.unref(this.deferredAbortTimer);
		} else {
			this.signal?.addEventListener("abort", this.abortListener, { once: true });
		}
	}

	handleInput(data: string): void {
		if (this.completed) return;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.finish(this.selected === 0);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollBy(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollBy(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollBy(-this.bodyPageSize);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollBy(this.bodyPageSize);
			return;
		}
		// The keybindings system has no left/right actions, so match the arrow keys directly.
		if (matchesKey(data, Key.left)) {
			this.selected = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.selected = 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.selected = this.selected === 0 ? 1 : 0;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const heightBudget = Math.max(1, Math.floor(this.tui.terminal.rows || 1));
		if (heightBudget === 1) return [this.fit(this.optionsLine(), safeWidth)];

		const showTitle = heightBudget >= 3;
		const showHelp = heightBudget >= 5;
		const showSeparators = heightBudget >= 6;
		const chrome = 1 + Number(showTitle) + Number(showHelp) + (showSeparators ? 2 : 0);
		this.bodyPageSize = Math.max(1, heightBudget - chrome);

		const fullBody = this.styledBody(safeWidth);
		const overflows = fullBody.length > this.bodyPageSize;
		let bodyLines: string[];
		if (overflows) {
			const bodyWidth = Math.max(1, safeWidth - 1);
			const wrapped = this.styledBody(bodyWidth);
			const maxOffset = Math.max(0, wrapped.length - this.bodyPageSize);
			this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
			const thumbAt = this.scrollbarThumbRow(wrapped.length, this.bodyPageSize);
			const track = this.theme.fg("dim", "│");
			const thumb = this.theme.fg("accent", "█");
			bodyLines = wrapped
				.slice(this.scrollOffset, this.scrollOffset + this.bodyPageSize)
				.map((line, row) => this.fit(`${line}${row === thumbAt ? thumb : track}`, safeWidth));
		} else {
			this.scrollOffset = 0;
			bodyLines = fullBody.map((line) => this.fit(line, safeWidth));
		}

		const lines: string[] = [];
		if (showTitle) lines.push(this.fit(this.theme.fg("accent", this.theme.bold(this.titleLine())), safeWidth));
		if (showSeparators) lines.push(this.fit(this.theme.fg("border", "─".repeat(safeWidth)), safeWidth));
		lines.push(...bodyLines);
		if (showSeparators) lines.push(this.fit(this.theme.fg("border", "─".repeat(safeWidth)), safeWidth));
		lines.push(this.fit(this.optionsLine(), safeWidth));
		if (showHelp) {
			const total = overflows ? this.styledBody(Math.max(1, safeWidth - 1)).length : fullBody.length;
			lines.push(this.fit(this.theme.fg("dim", this.helpLine(total)), safeWidth));
		}
		return lines.slice(0, heightBudget);
	}

	invalidate(): void {
		// Drop cached styled output so a theme change can never reuse old ANSI styles.
		this.styledWrapCache = [];
	}

	dispose(): void {
		if (this.completed) return;
		this.completed = true;
		this.cleanup();
	}

	private titleLine(): string {
		if (this.deadline === undefined) return this.title;
		const seconds = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
		return `${this.title} (${seconds}s)`;
	}

	private helpLine(totalBodyLines: number): string {
		const start = totalBodyLines === 0 ? 0 : this.scrollOffset + 1;
		const end = Math.min(totalBodyLines, this.scrollOffset + this.bodyPageSize);
		return [
			`${start}-${end}/${totalBodyLines}`,
			`${this.keys("tui.select.up")}/${this.keys("tui.select.down")} scroll`,
			`${this.keys("tui.select.pageUp")}/${this.keys("tui.select.pageDown")} page`,
			"←→/Tab select",
			`${this.keys("tui.select.confirm")} confirm`,
			`${this.keys("tui.select.cancel")} reject`,
			"timeout approves",
		].join("  ");
	}

	private optionsLine(): string {
		const option = (label: string, selected: boolean) => {
			const text = ` ${label} `;
			return selected
				? this.theme.fg("accent", ">") + this.theme.bg("selectedBg", this.theme.fg("text", text))
				: ` ${this.theme.fg("muted", text)}`;
		};
		return `${option("Approve", this.selected === 0)}  ${option("Reject", this.selected === 1)}`;
	}

	/**
	 * Classifies one raw message line and applies structural theme colors.
	 * Understands the canonical Markdown produced by planConfirmation (## headings,
	 * "- " bullets, **bold** spans) while staying backward compatible with plain
	 * conventions (trailing ":" headings, "Key: value" rows). Markdown emphasis is
	 * rendered as theme styles, never as literal asterisks.
	 */
	private styleBodyLine(line: string): string {
		const trimmed = line.trim();
		if (!trimmed) return this.theme.fg("text", line);
		if (/^#{1,6}\s/u.test(trimmed)) {
			return this.theme.fg("accent", this.theme.bold(line.replace(/^#+\s+/u, "")));
		}
		if (trimmed.endsWith(":") && !trimmed.startsWith("- ")) {
			return this.theme.fg("accent", this.theme.bold(this.stripBold(line)));
		}
		if (trimmed.startsWith("- ")) {
			const bulletStart = line.indexOf("-");
			return this.theme.fg("accent", line.slice(bulletStart, bulletStart + 2))
				+ this.renderSegments(line.slice(bulletStart + 2));
		}
		const keyValue = /^([A-Za-z][A-Za-z0-9 _.-]{0,38}): (.*)$/su.exec(line);
		if (keyValue) {
			return this.theme.fg("accent", keyValue[1])
				+ this.theme.fg("dim", ": ")
				+ this.renderSegments(keyValue[2]);
		}
		return this.renderSegments(line);
	}

	/** Renders text with **bold** spans expressed as theme weight, never literal asterisks. */
	private renderSegments(text: string): string {
		return text
			.split(/\*\*(.+?)\*\*/gu)
			.map((part, index) => (part === "" ? "" : index % 2 === 1 ? this.theme.fg("text", this.theme.bold(part)) : this.theme.fg("text", part)))
			.join("");
	}

	private stripBold(text: string): string {
		return text.replace(/\*\*/gu, "");
	}

	private styledBody(width: number): string[] {
		const cached = this.styledWrapCache.find((entry) => entry.width === width);
		if (cached) return cached.lines;
		const source = this.message.length > 0 ? this.message : " ";
		const lines = source
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(this.styleBodyLine(line), width));
		// Two slots: overflow renders alternate between full width and rail width.
		this.styledWrapCache.unshift({ width, lines });
		if (this.styledWrapCache.length > 2) this.styledWrapCache.length = 2;
		return lines;
	}

	private scrollbarThumbRow(totalLines: number, pageSize: number): number {
		const maxOffset = Math.max(1, totalLines - pageSize);
		const thumbSize = Math.min(pageSize, Math.max(1, Math.round((pageSize * pageSize) / totalLines)));
		const ratio = Math.min(1, Math.max(0, this.scrollOffset / maxOffset));
		return Math.round(ratio * (pageSize - thumbSize));
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.requestRender();
	}

	private keys(binding: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		const keys = this.keybindings.getKeys(binding);
		return keys.length > 0 ? keys.join("/") : binding;
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}

	private requestRender(): void {
		if (!this.completed) this.tui.requestRender();
	}

	private finish(confirmed: boolean): void {
		if (this.completed) return;
		this.completed = true;
		this.cleanup();
		this.onDone(confirmed);
	}

	private cleanup(): void {
		clearTimeout(this.expirationTimer);
		clearInterval(this.countdownTimer);
		clearTimeout(this.deferredAbortTimer);
		if (this.abortListener) this.signal?.removeEventListener("abort", this.abortListener);
	}

	private unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
		(timer as { unref?: () => void }).unref?.();
	}
}

export function confirmAgentTeam(
	mode: "tui" | "rpc" | "json" | "print",
	ui: ExtensionUIContext,
	title: string,
	message: string,
	options?: ExtensionUIDialogOptions,
): Promise<boolean> {
	if (mode !== "tui") return ui.confirm(title, message, options);
	if (options?.signal?.aborted) return Promise.resolve(false);
	return ui.custom<boolean>((tui, theme, keybindings, done) =>
		new AgentTeamConfirmComponent({
			title,
			message,
			tui,
			theme,
			keybindings,
			onDone: done,
			signal: options?.signal,
			timeout: options?.timeout,
		}),
	);
}
