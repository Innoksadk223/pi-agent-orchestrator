import type {
	ExtensionUIDialogOptions,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
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
			this.expirationTimer = setTimeout(() => this.finish(false), timeout);
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
			this.selected = 0;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = 1;
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.bodyPageSize);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset += this.bodyPageSize;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const heightBudget = Math.max(1, Math.floor(this.tui.terminal.rows || 1));
		if (heightBudget === 1) return [this.fit(this.optionsLine(), safeWidth)];

		const showTitle = heightBudget >= 3;
		const showHelp = heightBudget >= 5;
		this.bodyPageSize = Math.max(1, heightBudget - 1 - Number(showTitle) - Number(showHelp));
		const wrappedBody = wrapTextWithAnsi(this.message || " ", safeWidth);
		const maxOffset = Math.max(0, wrappedBody.length - this.bodyPageSize);
		this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
		const body = wrappedBody.slice(this.scrollOffset, this.scrollOffset + this.bodyPageSize);
		const lines: string[] = [];

		if (showTitle) lines.push(this.fit(this.theme.fg("accent", this.theme.bold(this.titleLine())), safeWidth));
		for (const line of body) lines.push(this.fit(this.theme.fg("text", line), safeWidth));
		if (showHelp) lines.push(this.fit(this.theme.fg("dim", this.helpLine(wrappedBody.length)), safeWidth));
		lines.push(this.fit(this.optionsLine(), safeWidth));
		return lines.slice(0, heightBudget);
	}

	invalidate(): void {
		// Rendering is intentionally stateless so a theme change cannot retain old ANSI styles.
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
			`${this.keys("tui.select.up")}/${this.keys("tui.select.down")} choose`,
			`${this.keys("tui.select.pageUp")}/${this.keys("tui.select.pageDown")} scroll`,
			`${this.keys("tui.select.confirm")} confirm`,
			`${this.keys("tui.select.cancel")} cancel`,
		].join("  ");
	}

	private optionsLine(): string {
		const option = (label: string, selected: boolean) => {
			const text = ` ${label} `;
			return selected
				? this.theme.fg("accent", ">") + this.theme.bg("selectedBg", this.theme.fg("text", text))
				: ` ${this.theme.fg("text", text)}`;
		};
		return `${option("Yes", this.selected === 0)}  ${option("No", this.selected === 1)}`;
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
