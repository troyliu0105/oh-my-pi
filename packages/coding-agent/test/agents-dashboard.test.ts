/**
 * Contracts for the live AgentsDashboard component:
 * - roster renders runtime refs, displayName, status, and activity gist
 * - IRC pane peeks pending mail without draining the mailbox
 * - direct compose sends through IrcBus and records the receipt
 * - IRC pane renders live traffic history observed via onSend (in or out)
 * - advisor rows are read-only for IRC sends
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentsDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/agents-dashboard";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeSessionCapture {
	delivered: Array<{ from: string; to: string; body: string }>;
}

function makeFakeSession(capture: FakeSessionCapture, behavior: "inject" | "fail"): AgentSession {
	const base = {
		subscribe: () => () => {},
	};
	const deliver =
		behavior === "fail"
			? async () => {
					throw new Error("hold for inbox");
				}
			: async (msg: { from: string; to: string; body: string }) => {
					capture.delivered.push(msg);
					return "injected";
				};
	return { ...base, deliverIrcMessage: deliver } as unknown as AgentSession;
}

function makeDashboard(opts: { registry: AgentRegistry; irc: IrcBus; remote?: unknown }): AgentsDashboard {
	return new AgentsDashboard({
		observers: new SessionObserverRegistry(),
		irc: opts.irc,
		registry: opts.registry,
		dashboardKeys: [],
		expandKeys: ["ctrl+o"],
		onClose: () => {},
		requestRender: () => {},
		ui: { requestRender: () => {} } as never,
		cwd: "/tmp",
		...(opts.remote ? { remote: opts.remote as never } : {}),
	});
}

function stripped(dashboard: AgentsDashboard, width = 120): string {
	return Bun.stripANSI(dashboard.render(width).join("\n"));
}

describe("AgentsDashboard", () => {
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("renders roster rows with id, displayName, status, and activity gist", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		registry.register({
			id: "Worker",
			displayName: "Reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
		registry.setActivity("Worker", "checking regressions");
		const irc = new IrcBus(registry);
		const dashboard = makeDashboard({ registry, irc });

		const out = stripped(dashboard);
		expect(out).toContain("Agents Dashboard");
		expect(out).toContain("Worker");
		expect(out).toContain("Reviewer");
		expect(out).toContain("running");
		expect(out).toContain("checking regressions");
		dashboard.dispose();
	});

	it("IRC pane peeks pending mail without consuming it", async () => {
		const registry = new AgentRegistry();
		const capture: FakeSessionCapture = { delivered: [] };
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(capture, "fail"),
			sessionFile: null,
			status: "running",
		});
		const irc = new IrcBus(registry);
		// Send a message that fails live hand-off so it is buffered in the inbox.
		const receipt = await irc.send({ from: MAIN_AGENT_ID, to: "Worker", body: "please inspect this" });
		expect(receipt.outcome).toBe("failed");
		expect(irc.unreadCount("Worker")).toBe(1);

		const dashboard = makeDashboard({ registry, irc });
		dashboard.handleInput("right"); // switch to IRC pane

		const out = stripped(dashboard);
		expect(out).toContain("Unread: 1");
		expect(out).toContain("from Main");
		expect(out).toContain("please inspect this");
		// Critical contract: peeking must not drain the mailbox.
		expect(irc.unreadCount("Worker")).toBe(1);
		dashboard.dispose();
	});

	it("direct compose sends through IrcBus to the selected agent", async () => {
		const registry = new AgentRegistry();
		const capture: FakeSessionCapture = { delivered: [] };
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(capture, "inject"),
			sessionFile: null,
			status: "running",
		});
		const irc = new IrcBus(registry);
		const dashboard = makeDashboard({ registry, irc });

		dashboard.handleInput("m"); // start direct compose
		dashboard.handleInput("hello worker");
		dashboard.handleInput("\r"); // submit

		// The compose send is fire-and-forget async; flush microtasks until it settles.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(capture.delivered).toHaveLength(1);
		expect(capture.delivered[0]).toMatchObject({ from: MAIN_AGENT_ID, to: "Worker", body: "hello worker" });
		const out = stripped(dashboard);
		expect(out).toContain("Worker");
		expect(out).toContain("injected");
		dashboard.dispose();
	});

	it("IRC pane renders live traffic for an agent that is either endpoint", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		const workerCapture: FakeSessionCapture = { delivered: [] };
		const peerCapture: FakeSessionCapture = { delivered: [] };
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(workerCapture, "inject"),
			sessionFile: null,
			status: "running",
		});
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(peerCapture, "inject"),
			sessionFile: null,
			status: "running",
		});
		const irc = new IrcBus(registry);
		const dashboard = makeDashboard({ registry, irc });

		// main → Worker: Worker is the recipient endpoint.
		await irc.send({ from: MAIN_AGENT_ID, to: "Worker", body: "please review the diff" });
		// Worker → Peer: neither endpoint is Main, exercises the cross-agent path.
		await irc.send({ from: "Worker", to: "Peer", body: "handoff note" });

		dashboard.handleInput("right"); // IRC pane (Worker is the default selection at index 0)

		const out = stripped(dashboard);
		// Both legs touching Worker appear under "Recent traffic".
		expect(out).toContain("Recent traffic");
		expect(out).toContain("Main → Worker");
		expect(out).toContain("please review the diff");
		expect(out).toContain("Worker → Peer");
		expect(out).toContain("handoff note");
		// The inbound leg surfaces the delivery outcome.
		expect(out).toContain("injected");
		dashboard.dispose();
	});

	it("IRC traffic survives dashboard close/reopen and is captured while closed", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		const workerCapture: FakeSessionCapture = { delivered: [] };
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(workerCapture, "inject"),
			sessionFile: null,
			status: "running",
		});
		const irc = new IrcBus(registry);

		// First open: send a message, observe it, then close the dashboard.
		const first = makeDashboard({ registry, irc });
		await irc.send({ from: MAIN_AGENT_ID, to: "Worker", body: "before close" });
		first.handleInput("right");
		expect(stripped(first)).toContain("before close");
		first.dispose();

		// Traffic while the dashboard is closed must still be captured.
		await irc.send({ from: MAIN_AGENT_ID, to: "Worker", body: "while closed" });

		// Reopen on the same bus: both the pre-close and while-closed messages
		// must be visible without any re-send.
		const reopened = makeDashboard({ registry, irc });
		reopened.handleInput("right");
		const out = stripped(reopened);
		expect(out).toContain("before close");
		expect(out).toContain("while closed");
		reopened.dispose();
	});

	it("advisor rows are read-only for IRC sends", () => {
		const registry = new AgentRegistry();
		const capture: FakeSessionCapture = { delivered: [] };
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			sessionFile: null,
		});
		registry.register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: makeFakeSession(capture, "inject"),
			sessionFile: null,
			status: "parked",
		});
		const irc = new IrcBus(registry);
		const dashboard = makeDashboard({ registry, irc });

		// Select the advisor row (index 0 after Main is filtered).
		dashboard.handleInput("m");

		expect(capture.delivered).toEqual([]);
		const out = stripped(dashboard);
		expect(out).toContain("Advisor transcripts are read-only; IRC send is disabled.");
		dashboard.dispose();
	});
});
