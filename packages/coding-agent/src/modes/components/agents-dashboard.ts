/**
 * AgentsDashboard - fullscreen live runtime dashboard for subagent activity
 * and IRC visibility.
 *
 * Layout:
 * - Header: dynamic border, title + status summary + pane tabs
 * - Body: two columns (roster | detail) sized to the live terminal
 * - Footer: keymap hint line
 *
 * Navigation:
 * - j/k or ↑/↓: roster selection
 * - ←/→ or Tab/Shift+Tab: switch between Overview and IRC panes
 * - Enter: open the fullscreen transcript viewer for the selected agent
 * - m: compose a direct IRC message to the selected agent
 * - b: compose a broadcast IRC message to live peers
 * - r: refresh row snapshots
 * - Esc / Ctrl+C / dashboard keys: close
 *
 * Unlike the Agent Hub (an inline editor-slot roster), this is a deliberate
 * command-opened control surface mounted as a fullscreen overlay. It composes
 * the same process-global data sources (AgentRegistry, SessionObserverRegistry,
 * IrcBus, AgentLifecycleManager) without modifying the Agent Hub.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Editor,
	Ellipsis,
	matchesKey,
	type OverlayHandle,
	padding,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import { ADVISOR_TRANSCRIPT_FILENAME } from "../../advisor";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus, type IrcDeliveryReceipt } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";
import { clampSelection, handleTabSwitchKey, padLinesToHeight } from "./selector-helpers";

type PaneId = "overview" | "irc";
type ComposeTarget = "direct" | "broadcast" | undefined;

const AGE_TICK_MS = 5_000;
const MAX_MAILBOX_PREVIEW = 5;
const MAX_RECEIPT_LINES = 5;
const ROSTER_MIN_WIDTH = 28;
const DETAIL_MIN_WIDTH = 40;

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/** Persisted across close/reopen within a process so the operator keeps context. */
let lastSelectedAgentId: string | undefined;
let lastActivePane: PaneId = "overview";

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		case "aborted":
			return theme.fg("error", `${theme.status.aborted} aborted`);
	}
}

function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(text).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? TRUNCATE_LENGTHS.LONG);
}

function clampLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 1), Ellipsis.Omit);
}

function registerPersistedSubagents(registry: AgentRegistry, sessionFile: string | null | undefined): void {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const root = sessionFile.slice(0, -6);
	registerPersistedSubagentsFromDir(registry, root, undefined);
}

function registerPersistedSubagentsFromDir(registry: AgentRegistry, dir: string, parentId: string | undefined): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		if (entry.name === ADVISOR_TRANSCRIPT_FILENAME) {
			const owner = parentId ?? MAIN_AGENT_ID;
			const advisorId = `${owner}/advisor`;
			const existing = registry.get(advisorId);
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				if (existing) registry.unregister(advisorId);
				registry.register({
					id: advisorId,
					displayName: "advisor",
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (!registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		registerPersistedSubagentsFromDir(registry, path.join(dir, id), id);
	}
}

export interface AgentsDashboardDeps {
	registry?: AgentRegistry;
	observers: SessionObserverRegistry;
	irc?: IrcBus;
	lifecycle?: AgentLifecycleManager;
	remote?: AgentHubRemote;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	dashboardKeys: KeyId[];
	sessionFile?: string | null;
	onClose: () => void;
	requestRender: () => void;
}

interface SentReceipt {
	target: string;
	receipt: IrcDeliveryReceipt;
	body: string;
	ts: number;
}

export class AgentsDashboard implements Component {
	readonly #deps: AgentsDashboardDeps;
	readonly #registry: AgentRegistry;
	readonly #observers: SessionObserverRegistry;
	readonly #irc: IrcBus;
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;

	#rows: AgentRef[] = [];
	#selectedRow = 0;
	/** Frozen row order once populated; new agents append at the end. */
	#rowOrder: Map<string, number> | undefined;
	#activePane: PaneId = lastActivePane;
	#scrollOffset = 0;
	#notice: string | undefined;

	#composeTarget: ComposeTarget;
	#composeEditor: Editor | undefined;
	#receipts: SentReceipt[] = [];

	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentsDashboardDeps) {
		this.#deps = deps;
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();

		if (lastSelectedAgentId) {
			this.#selectedRow = 0;
		}
		this.#activePane = lastActivePane;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#onDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#onDataChange()));
		this.#ageTimer = setInterval(() => this.#deps.requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		if (!this.#deps.remote) {
			registerPersistedSubagents(this.#registry, deps.sessionFile);
		}
		this.#refreshRows();
	}

	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	// ========================================================================
	// Data
	// ========================================================================

	#onDataChange(): void {
		this.#refreshRows();
		this.#deps.requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);

		if (!this.#rowOrder) {
			this.#rows = refs.sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(this.#rows.map((ref, i) => [ref.id, i]));
		} else {
			this.#rows = refs.sort((a, b) => {
				const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
				if (statusDiff !== 0) return statusDiff;
				const aOrder = this.#rowOrder!.get(a.id) ?? Number.MAX_SAFE_INTEGER;
				const bOrder = this.#rowOrder!.get(b.id) ?? Number.MAX_SAFE_INTEGER;
				return aOrder - bOrder;
			});
			for (const ref of this.#rows) {
				if (!this.#rowOrder.has(ref.id)) {
					this.#rowOrder.set(ref.id, this.#rowOrder.size);
				}
			}
		}

		const desiredId = lastSelectedAgentId ?? selectedId;
		const desiredIndex = desiredId ? this.#rows.findIndex(ref => ref.id === desiredId) : -1;
		if (desiredIndex >= 0) {
			this.#selectedRow = desiredIndex;
		} else {
			const kept = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
			this.#selectedRow = kept >= 0 ? kept : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
		}
		const clamped = clampSelection(this.#selectedRow, this.#scrollOffset, this.#rows.length, this.#maxVisible());
		this.#selectedRow = clamped.selectedIndex;
		this.#scrollOffset = clamped.scrollOffset;
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(s => s.id === id);
	}

	#selectedRef(): AgentRef | undefined {
		return this.#rows[this.#selectedRow];
	}

	// ========================================================================
	// Geometry
	// ========================================================================

	#terminalRows(): number {
		return process.stdout.rows || 24;
	}

	#maxVisible(): number {
		// Body height minus roster chrome (header line + blank + scroll hint).
		return Math.max(3, this.#bodyHeight() - 3);
	}

	#bodyHeight(): number {
		// Header: 2 borders + title + tab bar (4); footer: spacer + footer + border (3).
		const chrome = 4 + 3;
		return Math.max(5, this.#terminalRows() - chrome);
	}

	// ========================================================================
	// Rendering
	// ========================================================================

	render(width: number): readonly string[] {
		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		lines.push(this.#renderHeader(width));
		lines.push(...new DynamicBorder().render(width));

		const leftWidth = Math.max(ROSTER_MIN_WIDTH, Math.floor(width * 0.4));
		const rightWidth = Math.max(DETAIL_MIN_WIDTH, width - leftWidth - 3);
		const leftLines = this.#renderRoster(leftWidth);
		const rightLines = this.#renderDetail(rightWidth);
		const bodyHeight = this.#bodyHeight();
		const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
		for (let i = 0; i < bodyHeight; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			lines.push(leftPadded + separator + right);
		}

		lines.push("");
		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		lines.push(` ${theme.fg("dim", this.#footerHint())}`);
		lines.push(...new DynamicBorder().render(width));
		return padLinesToHeight(lines, this.#terminalRows());
	}

	#renderHeader(width: number): string {
		const counts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of this.#rows) counts[ref.status]++;
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			if (counts[status] > 0) parts.push(`${counts[status]} ${status}`);
		}
		const summary = parts.length > 0 ? parts.join(theme.sep.dot) : "no subagents";
		const title = theme.bold(theme.fg("accent", "Agents Dashboard"));
		const summaryText = theme.fg("dim", `${theme.sep.dot}${summary}`);
		const titleLine = ` ${title}${summaryText}`;
		// Render tabs on the next conceptual line by returning title here; tabs go on a separate line.
		void width;
		return titleLine;
	}

	#renderRoster(width: number): string[] {
		const lines: string[] = [];
		const tabLine = this.#renderTabs();
		lines.push(tabLine);
		lines.push("");

		if (this.#rows.length === 0) {
			lines.push(theme.fg("dim", "  no subagents yet — task spawns appear here"));
			return lines;
		}

		const maxVisible = this.#maxVisible();
		const start = Math.min(this.#scrollOffset, Math.max(0, this.#rows.length - maxVisible));
		const end = Math.min(start + maxVisible, this.#rows.length);
		for (let i = start; i < end; i++) {
			lines.push(this.#renderRow(this.#rows[i], i === this.#selectedRow, width));
		}
		if (end < this.#rows.length) {
			lines.push(theme.fg("dim", `  … ${this.#rows.length - end} more`));
		}
		return lines;
	}

	#renderTabs(): string {
		const tabs: Array<{ id: PaneId; label: string }> = [
			{ id: "overview", label: "Overview" },
			{ id: "irc", label: "IRC" },
		];
		const parts: string[] = [" "];
		for (const tab of tabs) {
			const active = tab.id === this.#activePane;
			const label = active
				? theme.bg("selectedBg", ` ${theme.bold(tab.label)} `)
				: theme.fg("muted", ` ${tab.label} `);
			parts.push(label);
		}
		return parts.join("");
	}

	#renderRow(ref: AgentRef, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const parts: string[] = [statusBadge(ref.status), theme.bold(replaceTabs(ref.id))];
		parts.push(theme.fg("dim", replaceTabs(ref.displayName)));
		parts.push(theme.fg("dim", ref.parentId ? `${ref.kind} · of ${ref.parentId}` : ref.kind));
		const observed = this.#observableFor(ref.id);
		const task = ref.activity ?? observed?.description ?? observed?.progress?.task;
		if (task) {
			parts.push(theme.fg("muted", sanitizeLine(task, TRUNCATE_LENGTHS.TITLE)));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			parts.push(theme.fg("warning", `⧉ ${unread}`));
		}
		parts.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		const rawLine = `${cursor} ${parts.join(theme.sep.dot)}`;
		return clampLine(rawLine, width);
	}

	#renderDetail(width: number): string[] {
		if (this.#composeEditor) {
			const editorLines = this.#composeEditor.render(width);
			const header =
				this.#composeTarget === "broadcast"
					? theme.fg("accent", `Broadcast to live peers`)
					: theme.fg("accent", `Message → ${this.#selectedRef()?.id ?? ""}`);
			const lines = [header, theme.fg("dim", "Enter:send  Esc:cancel"), ""];
			lines.push(...editorLines);
			return lines;
		}

		const ref = this.#selectedRef();
		if (!ref) {
			return [theme.fg("dim", "No agent selected.")];
		}
		if (this.#activePane === "irc") {
			return this.#renderIrcPane(ref, width);
		}
		return this.#renderOverviewPane(ref, width);
	}

	#renderOverviewPane(ref: AgentRef, width: number): string[] {
		const lines: string[] = [];
		lines.push(`${theme.bold(replaceTabs(ref.id))} ${statusBadge(ref.status)}`);
		lines.push(theme.fg("dim", `display: ${replaceTabs(ref.displayName)}`));
		const kindLine = ref.parentId ? `${ref.kind} · of ${ref.parentId}` : ref.kind;
		lines.push(theme.fg("dim", kindLine));
		lines.push(
			theme.fg("dim", `created ${formatAge(Math.max(1, Math.round((Date.now() - ref.createdAt) / 1000)))} ago`),
		);
		lines.push(
			theme.fg("dim", `active ${formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))} ago`),
		);
		if (ref.sessionFile) {
			lines.push(theme.fg("dim", `session: ${shortenPath(ref.sessionFile)}`));
		}
		const observed = this.#observableFor(ref.id);
		const activity = ref.activity ?? observed?.description ?? observed?.progress?.task;
		if (activity) {
			lines.push("");
			lines.push(theme.fg("muted", "Activity"));
			lines.push(` ${sanitizeLine(activity, width - 2)}`);
		}
		const progress = observed?.progress;
		if (!progress) {
			lines.push("");
			lines.push(theme.fg("dim", "No live progress snapshot for this agent."));
			return lines;
		}
		lines.push("");
		lines.push(theme.fg("muted", "Progress"));
		const stats: string[] = [];
		if (progress.toolCount > 0) {
			stats.push(`${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}`);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		if (stats.length > 0) lines.push(` ${theme.fg("dim", stats.join(theme.sep.dot))}`);
		if (progress.contextTokens && progress.contextTokens > 0) {
			const ctx =
				progress.contextWindow && progress.contextWindow > 0
					? `${formatNumber(progress.contextTokens)}/${formatNumber(progress.contextWindow)}`
					: formatNumber(progress.contextTokens);
			lines.push(` ${theme.fg("dim", `context ${ctx} tokens`)}`);
		}
		if (progress.cost > 0) {
			lines.push(` ${theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`)}`);
		}
		if (progress.currentTool) {
			lines.push(` ${theme.fg("dim", `tool ${sanitizeLine(progress.currentTool, TRUNCATE_LENGTHS.CONTENT)}`)}`);
		}
		if (progress.lastIntent) {
			lines.push(` ${theme.fg("dim", `intent ${sanitizeLine(progress.lastIntent, TRUNCATE_LENGTHS.CONTENT)}`)}`);
		}
		if (progress.retryState) {
			lines.push(
				` ${theme.fg("warning", `retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`)}`,
			);
		}
		return lines;
	}

	#renderIrcPane(ref: AgentRef, width: number): string[] {
		const lines: string[] = [];
		const unread = this.#irc.unreadCount(ref.id);
		lines.push(theme.fg("accent", `IRC · ${ref.id}`));
		lines.push(theme.fg("dim", `Unread: ${unread}`));

		if (ref.kind === "advisor") {
			lines.push("");
			lines.push(theme.fg("dim", "Advisor transcripts are read-only; IRC send is disabled."));
		} else if (this.#deps.remote) {
			lines.push("");
			lines.push(
				theme.fg("dim", "IRC send is unavailable in collab guest dashboard; open transcript for host-backed chat."),
			);
		}

		const mailbox = this.#irc.inbox(ref.id, { peek: true });
		if (mailbox.length > 0) {
			lines.push("");
			lines.push(theme.fg("muted", "Pending mail"));
			for (const msg of mailbox.slice(0, MAX_MAILBOX_PREVIEW)) {
				const age = formatAge(Math.max(1, Math.round((Date.now() - msg.ts) / 1000)));
				const reply = msg.replyTo ? theme.fg("dim", ` replyTo ${msg.replyTo}`) : "";
				const body = sanitizeLine(msg.body, TRUNCATE_LENGTHS.CONTENT);
				lines.push(` ${theme.fg("dim", `from ${msg.from} ${age} ago`)}${reply}`);
				lines.push(`   ${body}`);
			}
			if (mailbox.length > MAX_MAILBOX_PREVIEW) {
				lines.push(theme.fg("dim", `  … ${mailbox.length - MAX_MAILBOX_PREVIEW} more`));
			}
		}

		if (this.#receipts.length > 0) {
			lines.push("");
			lines.push(theme.fg("muted", "Recent sends"));
			for (const receipt of this.#receipts.slice(-MAX_RECEIPT_LINES)) {
				const age = formatAge(Math.max(1, Math.round((Date.now() - receipt.ts) / 1000)));
				const outcome =
					receipt.receipt.outcome === "failed"
						? theme.fg("error", `failed — ${receipt.receipt.error ?? "unknown error"}`)
						: receipt.receipt.outcome;
				lines.push(
					` ${theme.fg("dim", receipt.target)} ${theme.sep.dot} ${outcome} ${theme.fg("dim", `${age} ago`)}`,
				);
			}
		}
		void width;
		return lines;
	}

	#footerHint(): string {
		const composeHint = this.#deps.remote ? "" : "  m:message  b:broadcast";
		return `↑/↓/j/k:select  ←/→:pane  Enter:transcript${composeHint}  r:reload  Esc:close`;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(keyData: string): void {
		// Compose editor owns input until submitted or cancelled.
		if (this.#composeEditor) {
			if (matchesKey(keyData, "escape")) {
				this.#cancelCompose();
				this.#deps.requestRender();
				return;
			}
			this.#composeEditor.handleInput(keyData);
			this.#deps.requestRender();
			return;
		}

		// Transcript viewer owns input while mounted.
		if (this.#transcriptViewer) {
			this.#transcriptViewer.handleInput(keyData);
			return;
		}

		for (const key of this.#deps.dashboardKeys) {
			if (matchesKey(keyData, key)) {
				this.#close();
				return;
			}
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c")) {
			this.#close();
			return;
		}
		if (handleTabSwitchKey(keyData, direction => this.#switchPane(direction === 1 ? "right" : "left"))) {
			this.#deps.requestRender();
			return;
		}
		if (keyData === "left") {
			this.#switchPane("left");
			this.#deps.requestRender();
			return;
		}
		if (keyData === "right") {
			this.#switchPane("right");
			this.#deps.requestRender();
			return;
		}
		if (keyData === "j" || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
				lastSelectedAgentId = this.#selectedRef()?.id;
			}
			this.#deps.requestRender();
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
				lastSelectedAgentId = this.#selectedRef()?.id;
			}
			this.#deps.requestRender();
			return;
		}
		if (keyData === "r") {
			this.#refreshRows();
			this.#deps.requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			this.#openTranscript();
			return;
		}
		if (keyData === "m") {
			this.#startCompose("direct");
			return;
		}
		if (keyData === "b") {
			this.#startCompose("broadcast");
			return;
		}
	}

	#switchPane(direction: "left" | "right"): void {
		if (direction === "right" && this.#activePane !== "irc") {
			this.#activePane = "irc";
		} else if (direction === "left" && this.#activePane !== "overview") {
			this.#activePane = "overview";
		}
		lastActivePane = this.#activePane;
	}

	#startCompose(target: Exclude<ComposeTarget, undefined>): void {
		const ref = this.#selectedRef();
		if (!ref) {
			this.#notice = "No agent selected.";
			this.#deps.requestRender();
			return;
		}
		if (target === "direct") {
			if (ref.kind === "advisor") {
				this.#notice = "Advisor transcripts are read-only; IRC send is disabled.";
				this.#deps.requestRender();
				return;
			}
			if (this.#deps.remote) {
				this.#notice = "IRC send is unavailable in collab guest dashboard.";
				this.#deps.requestRender();
				return;
			}
		}
		this.#notice = undefined;
		this.#composeTarget = target;
		const editor = new Editor(getEditorTheme());
		editor.setMaxHeight(4);
		editor.onSubmit = text => this.#submitCompose(text);
		this.#composeEditor = editor;
		this.#deps.requestRender();
	}

	#cancelCompose(): void {
		this.#composeEditor = undefined;
		this.#composeTarget = undefined;
	}

	#submitCompose(text: string): void {
		const trimmed = text.trim();
		this.#composeEditor = undefined;
		const target = this.#composeTarget;
		this.#composeTarget = undefined;
		if (!trimmed || !target) {
			this.#deps.requestRender();
			return;
		}
		void this.#sendComposed(target, trimmed);
	}

	async #sendComposed(target: Exclude<ComposeTarget, undefined>, body: string): Promise<void> {
		try {
			if (target === "broadcast") {
				const targets = this.#registry.listVisibleTo(MAIN_AGENT_ID).map(ref => ref.id);
				if (targets.length === 0) {
					this.#notice = "No live peers to broadcast to.";
					this.#deps.requestRender();
					return;
				}
				const receipts = await Promise.all(
					targets.map(to => this.#irc.send({ from: MAIN_AGENT_ID, to, body }).then(receipt => ({ to, receipt }))),
				);
				for (const { to, receipt } of receipts) {
					this.#pushReceipt(to, receipt, body);
				}
			} else {
				const ref = this.#selectedRef();
				if (!ref) {
					this.#notice = "No agent selected.";
					this.#deps.requestRender();
					return;
				}
				const receipt = await this.#irc.send({ from: MAIN_AGENT_ID, to: ref.id, body });
				this.#pushReceipt(ref.id, receipt, body);
			}
			this.#activePane = "irc";
			lastActivePane = "irc";
			this.#notice = undefined;
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		this.#deps.requestRender();
	}

	#pushReceipt(target: string, receipt: IrcDeliveryReceipt, body: string): void {
		this.#receipts.push({ target, receipt, body, ts: Date.now() });
		if (this.#receipts.length > MAX_RECEIPT_LINES * 2) {
			this.#receipts.splice(0, this.#receipts.length - MAX_RECEIPT_LINES * 2);
		}
	}

	#openTranscript(): void {
		const ref = this.#selectedRef();
		if (!ref) {
			this.#notice = "No agent selected.";
			this.#deps.requestRender();
			return;
		}
		if (typeof this.#deps.ui.showOverlay !== "function") {
			this.#notice = "Transcript viewer unavailable without a TUI.";
			this.#deps.requestRender();
			return;
		}
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		try {
			const viewer = new AgentTranscriptViewer({
				agentId: ref.id,
				registry: this.#registry,
				remote: this.#deps.remote,
				observers: this.#observers,
				lifecycle: this.#deps.remote ? undefined : () => this.#deps.lifecycle ?? AgentLifecycleManager.global(),
				ui: this.#deps.ui,
				getTool: this.#deps.getTool,
				getMessageRenderer: this.#deps.getMessageRenderer,
				cwd: this.#deps.cwd,
				hideThinkingBlock: this.#deps.hideThinkingBlock,
				proseOnlyThinking: this.#deps.proseOnlyThinking,
				expandKeys: this.#deps.expandKeys,
				hubKeys: this.#deps.dashboardKeys,
				requestRender: () => this.#deps.requestRender(),
				onClose: () => this.#closeTranscriptOverlay(),
				onHubClose: () => {
					this.#closeTranscriptOverlay();
					this.#close();
				},
			});
			this.#transcriptViewer = viewer;
			this.#transcriptOverlay = this.#deps.ui.showOverlay(viewer, {
				width: "100%",
				margin: 0,
				fullscreen: true,
			});
			if (typeof this.#deps.ui.setFocus === "function") {
				this.#deps.ui.setFocus(viewer);
			}
			this.#deps.requestRender();
		} catch (error) {
			logger.warn("AgentsDashboard: transcript open failed", { id: ref.id, error: String(error) });
			this.#notice = error instanceof Error ? error.message : String(error);
			this.#closeTranscriptOverlay();
			this.#deps.requestRender();
		}
	}

	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#deps.ui.setFocus === "function") {
			this.#deps.ui.setFocus(this as unknown as Component);
		}
		this.#deps.requestRender();
	}

	#close(): void {
		lastSelectedAgentId = this.#selectedRef()?.id;
		lastActivePane = this.#activePane;
		this.#closeTranscriptOverlay();
		this.#deps.onClose();
	}
}
