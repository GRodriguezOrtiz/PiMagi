/**
 * Agent Team — Orchestrator dispatcher with grid dashboard
 *
 * Orchestrator has NO codebase tools. It coordinates Melchior, Balthasar, and Casper
 * via the `dispatch_agent` tool. Each specialist runs as an in-process AgentSession.
 *
 * Default agent definitions live in src/definitions, each one named after the agent (e.g. melchior.md).
 * Any of the three can be overridden by dropping a matching .md file into one of:
 *   <cwd>/agents/
 *   <cwd>/.claude/agents/
 *   <cwd>/.pi/agents/
 * The file must be named after the agent (e.g. melchior.md overrides Melchior-1).
 *
 * Orchestrator system prompt is loaded from src/definitions/orchestrator.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	keyHint,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	extensionPaths: string[];
	systemPrompt: string;
	model?: string;          // e.g. "anthropic/claude-haiku-4-5", undefined = inherit
	thinkingLevel?: string;  // e.g. "low", "high", undefined = inherit
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	cost: number;
	lifetimeCost: number;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
    inputTokens: number;
    outputTokens: number;
    filesRead: Set<string>;
    filesWritten: Set<string>;
    model: string | undefined;
    thinkingLevel: string | undefined;
}

// ── Display helpers ──────────────────────────────────────────────────────────
function sanitizeStatusText(text: string) {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function formatCount(n: number): string {
    if (n < 1000) return String(n);

    const value = n / 1000;
    return `${value.toFixed(value < 10 ? 1 : 0)}K`;
}

// ── Agent file parser ────────────────────────────────────────────────────────

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseAgentFile(filePath: string): AgentDef  {
    const raw = readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error(`Invalid agent file format: ${filePath}`);

    const fm: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }

    if (!fm.name) throw new Error(`Agent file missing "name" in frontmatter: ${filePath}`);

    const baseDir = resolve(filePath, "../");
    const extensionPaths = (fm.extensions || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(p => resolve(baseDir, p));

    const rawThinking = fm.thinking?.toLowerCase();
    const thinkingLevel = rawThinking && VALID_THINKING_LEVELS.has(rawThinking)
        ? rawThinking
        : rawThinking
            ? (console.warn(`[agent-team] Unknown thinking level "${fm.thinking}" in ${filePath}, ignoring`), undefined)
            : undefined;

    const model = fm.model?.trim() || undefined;

    return {
        name: fm.name,
        description: fm.description || "",
        tools: fm.tools || "read,grep,find,ls",
        extensionPaths,
        systemPrompt: match[2].trim(),
        model,
        thinkingLevel,
    };
}

// ── Tool spec mapper ────────────────────────────────────────────────────────

// `createAgentSession({ tools })` is a NAME ALLOWLIST over pi's built-in
// tool registry — pass strings, NOT constructed Tool objects. Passing objects
// silently disables every tool: the active-tool list won't match the registry
// by name, the system prompt renders `Available tools: (none)`, and zero tool
// schemas are shipped to the model.
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function toolsFromSpec(spec: string): string[] {
	return spec.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
		.filter(name => BUILTIN_TOOLS.has(name));
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	const agentOverrides: Map<string, { model?: string; thinkingLevel?: string }> = new Map();
	let orchestratorDef!: AgentDef;
	const teamName = "MAGI";
	const gridCols = 3;
	let widgetCtx: any;
    let storedOrchestratorThinkingLevel: string | undefined = undefined;

	// ── Load agents ────────────────────────────────────────────────────────

	function loadAgents(cwd: string): Record<string, AgentDef> {
		const defaultPaths = [
			join(__dirname, "..", "definitions", "melchior.md"),
			join(__dirname, "..", "definitions", "balthasar.md"),
			join(__dirname, "..", "definitions", "casper.md"),
		];

		const defs: Record<string, AgentDef> = {};
		for (const path of defaultPaths) {
			const def = parseAgentFile(path);
			defs[def.name.toLowerCase()] = def;
		}

		const overrideDirs = [
			join(cwd, "agents"),
			join(cwd, ".claude", "agents"),
			join(cwd, ".pi",    "agents"),
		];

		for (const dir of overrideDirs) {
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const stem = file.slice(0, -3).toLowerCase();
				const key  = Object.keys(defs).find(k => k === stem || k.startsWith(stem + "-"));
				if (!key) continue;
				try { defs[key] = parseAgentFile(join(dir, file)); } catch {}
			}
		}

		return defs;
	}

	// ── Activate team ──────────────────────────────────────────────────────

	function activateTeam(defs: Record<string, AgentDef>) {
		agentStates.clear();
		for (const [name, def] of Object.entries(defs)) {
			agentStates.set(name, {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				cost: 0,
				lifetimeCost: 0,
				runCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                filesRead: new Set(),
                filesWritten: new Set(),
                model: undefined,
                thinkingLevel: undefined,
			});
		}
	}

	// ── Grid rendering ─────────────────────────────────────────────────────

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);

		const costStr = state.cost > 0 ? `$${state.cost.toFixed(4)}` : "$0.00";
        const tokStr = `tok ↑${formatCount(state.inputTokens)}/↓${formatCount(state.outputTokens)}`;
        const costTokLine = theme.fg("dim",`cost ${costStr} · ${tokStr}`);

        const toolStr = state.toolCount ? `tools ${state.toolCount}` : "tools 0";
        const filesRead = state.filesRead.size;
        const filesWritten = state.filesWritten.size;
        const fileStr = `files ${filesRead}R/${filesWritten}W`;
        const toolFileLine = theme.fg("dim", `${toolStr} · ${fileStr}`);

        const modelStr = state.model ? `${state.model} · ${state.thinkingLevel}` : "";
        const modelLine = theme.fg("dim", modelStr);

		const ctxStr = `Last ctx ${Math.ceil(state.contextPct)}%`;
		const ctxLine = theme.fg("dim", ctxStr);

		const workRaw = state.task ? (state.lastWork || state.task) : state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
        const border = (content: string) => {
            const visLen = visibleWidth(content);
            return theme.fg("dim", "│") +
                content +
                " ".repeat(Math.max(0, w - visLen)) +
                theme.fg("dim", "│");
        };

		return [
			theme.fg("dim", top),
			border(" " + nameStr),
			border(" " + statusLine),
			border(" " + costTokLine),
			border(" " + toolFileLine),
			border(" " + ctxLine),
			...(modelStr ? [border(" " + modelLine)] : []),
			border(" " + workLine),
			theme.fg("dim", bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);
			return {
				render(width: number): string[] {

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						while (cards.length < cols) cards.push(Array(9).fill(" ".repeat(colWidth)));

						const cardHeight = Math.max(...cards.map(c => c.length));
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					text.setText(rows.map(cols => cols.join(" ".repeat(gap))).join("\n"));
					return text.render(width);
				},
				invalidate() { text.invalidate(); },
			};
		});
	}

	// ── Dispatch agent (in-process subagent) ────────────────────────────────

	async function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
		signal: AbortSignal | undefined,
		onUpdate: ((u: any) => void) | undefined,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);

		if (!state) {
			const available = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
			return { output: `Agent "${agentName}" not found. Available: ${available}`, exitCode: 1, elapsed: 0 };
		}

		if (state.status === "running") {
			return {
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			};
		}

		state.status = "running";
        state.cost = 0;
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = task;
		state.runCount++;
        state.inputTokens = 0;
        state.outputTokens = 0;
        state.contextPct = 0;
        state.filesRead.clear();
        state.filesWritten.clear();
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		try {
			const loader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				// IMPORTANT: do NOT use `systemPromptOverride` here. Its `base` arg
				// is the user's optional system-prompt file (usually undefined),
				// not pi's default preamble. Returning anything makes
				// buildSystemPrompt take the customPrompt short-circuit and drop
				// the entire `Available tools:` block, leaving the sub-agent blind.
				//
				// `appendSystemPromptOverride` injects text AFTER the default
				// preamble (which contains the tools list + calling conventions),
				// so the persona rides on top of a fully wired tool environment.
				appendSystemPromptOverride: () => [state.def.systemPrompt],
				additionalExtensionPaths: state.def.extensionPaths,
				extensionFactories: [],
			});
			await loader.reload();

			const override = agentOverrides.get(key);

			// model: runtime override → frontmatter → orchestrator (via ?? ctx.model below)
			let effectiveModel: any = undefined;
			const modelStr = override?.model ?? state.def.model;
			if (modelStr) {
				const parts = modelStr.split("/");
				const provider = parts.length > 1 ? parts[0] : undefined;
				const id = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
				effectiveModel = ctx.modelRegistry?.find?.(provider, id) ?? undefined;
				if (!effectiveModel) {
					console.warn(`[agent-team] Model "${modelStr}" not found in registry for agent "${state.def.name}", falling back to orchestrator model`);
				}
			}

			// thinkingLevel: runtime override → frontmatter → orchestrator (via ?? storedOrchestratorThinkingLevel below)
			const effectiveThinking: any = override?.thinkingLevel ?? state.def.thinkingLevel ?? undefined;

			const { session } = await createAgentSession({
				sessionManager: SessionManager.inMemory(),
				tools: toolsFromSpec(state.def.tools),
				resourceLoader: loader,
                model: effectiveModel ?? ctx.model,
                thinkingLevel: effectiveThinking ?? storedOrchestratorThinkingLevel,
			});

            const m = session.model;
            state.model = m ? m.id : undefined;
            state.thinkingLevel = session.thinkingLevel ?? undefined;
            updateWidget();

			let output = "";

			session.subscribe((event) => {
				if (event.type === "message_update"
					&& event.assistantMessageEvent.type === "text_delta") {
					output += event.assistantMessageEvent.delta;
					onUpdate?.({
						content: [{ type: "text", text: output }],
						details: { agent: agentName, task, status: "running" },
					});
				}
				if (event.type === "tool_execution_start") {
					state.toolCount++;

                    if (["read", "grep", "find", "ls"].includes(event.toolName) && event.args?.path) {
                        state.filesRead.add(event.args.path);
                    }

                    if (["write", "edit"].includes(event.toolName) && event.args?.path) {
                        state.filesWritten.add(event.args.path);
                    }

                    updateWidget();
				}
				if (event.type === "agent_end") {
					for (const msg of event.messages) {
						if (msg.role === "assistant") {
							const messageCost = (msg as AssistantMessage).usage?.cost?.total ?? 0;
							state.cost += messageCost;
							state.lifetimeCost += messageCost;
                            state.inputTokens += (msg as AssistantMessage).usage?.input ?? 0;
                            state.outputTokens += (msg as AssistantMessage).usage?.output ?? 0;
						}
					}
					// `percent` is null right after a compaction (token count unknown
					// until the next LLM response — see pi CHANGELOG PR #1382), so
					// keep the previous value in that case instead of zeroing the bar.
					const pct = session.getContextUsage()?.percent;
					if (pct != null) state.contextPct = pct;
					updateWidget();
				}
			});

			signal?.addEventListener("abort", () => { session.abort(); });

			await session.prompt(task);
			session.dispose();

			clearInterval(state.timer);
			state.elapsed = Date.now() - startTime;
			state.status = "done";
			state.lastWork = output.split("\n").filter(l => l.trim()).pop() || task;
			updateWidget();

			ctx.ui.notify(
				`${displayName(state.def.name)} done in ${Math.round(state.elapsed / 1000)}s`,
				"success",
			);

			return { output, exitCode: 0, elapsed: state.elapsed };

		} catch (err: any) {
			clearInterval(state.timer);
			state.elapsed = Date.now() - startTime;
			state.status = "error";
			state.lastWork = err?.message || "error";
			updateWidget();

			ctx.ui.notify(
				`${displayName(state.def.name)} error in ${Math.round(state.elapsed / 1000)}s`,
				"error",
			);

			return { output: err?.message || String(err), exitCode: 1, elapsed: state.elapsed };
		}
	}

	// ── dispatch_agent tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent executes the task and returns the result. Use the system prompt to see available agents.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task:  Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };
			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching" },
					});
				}

				const result = await dispatchAgent(agent, task, ctx, _signal, onUpdate);

				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;

				const status = result.exitCode === 0 ? "done" : "error";

				return {
					content: [{ type: "text", text: `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}` }],
					details: { agent, task, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const textContent = result.content.find((c: any) => c.type === "text") as { type: "text"; text: string } | undefined;
			const fullOutput = typeof details.fullOutput === "string" ? details.fullOutput : (textContent?.text ?? "");

			if (options.isPartial || details.status === "dispatching" || details.status === "running") {
				const header = theme.fg("accent", `● ${details.agent || "?"}`) + theme.fg("dim", " working...");
				if (options.expanded && fullOutput) {
					return new Text(header + "\n" + theme.fg("muted", fullOutput), 0, 0);
				}
				return new Text(header, 0, 0);
			}

			const icon    = details.status === "done" ? "✓" : "✗";
			const color   = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header  = theme.fg(color, `${icon} ${details.agent}`) + theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded) {
				const output = fullOutput || "(no output)";
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			const hint = fullOutput ? theme.fg("dim", ` ${keyHint("app.tools.expand", "to expand")}`) : "";
			return new Text(header + hint, 0, 0);
		},
	});

	// ── /agent slash command ─────────────────────────────────────────────────

	pi.registerCommand("agent", {
		description: "View or override per-agent model and thinking level",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0];

			// /agent list
			if (!sub || sub === "list") {
				const lines = Array.from(agentStates.entries()).map(([key, state]) => {
					const ov = agentOverrides.get(key);
					const model = ov?.model ?? state.def.model ?? "(inherit)";
					const thinking = ov?.thinkingLevel ?? state.def.thinkingLevel ?? "(inherit)";
					const tag = ov ? " [override]" : state.def.model ? " [frontmatter]" : "";
					return `${displayName(state.def.name)}: ${model} · ${thinking}${tag}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// /agent show <name>
			if (sub === "show") {
				const name = argv[1]?.toLowerCase();
				if (!name) { ctx.ui.notify("Usage: /agent show <name>", "warning"); return; }
				const state = agentStates.get(name);
				if (!state) { ctx.ui.notify(`Unknown agent: ${argv[1]}`, "error"); return; }
				const ov = agentOverrides.get(name);
				const lines = [
					`Agent:     ${displayName(state.def.name)}`,
					`Status:    ${state.status}`,
					`Model:     ${ov?.model ?? state.def.model ?? "(inherit from orchestrator)"}${ov?.model ? " [override]" : state.def.model ? " [frontmatter]" : ""}`,
					`Thinking:  ${ov?.thinkingLevel ?? state.def.thinkingLevel ?? "(inherit from orchestrator)"}${ov?.thinkingLevel ? " [override]" : state.def.thinkingLevel ? " [frontmatter]" : ""}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// /agent model <name> <provider/id>
			if (sub === "model") {
				const name = argv[1]?.toLowerCase();
				const model = argv[2];
				if (!name || !model) { ctx.ui.notify("Usage: /agent model <name> <provider/id>", "warning"); return; }
				const state = agentStates.get(name);
				if (!state) { ctx.ui.notify(`Unknown agent: ${argv[1]}`, "error"); return; }
				if (state.status === "running") { ctx.ui.notify(`Cannot override "${displayName(state.def.name)}" while it is running`, "error"); return; }
				agentOverrides.set(name, { ...agentOverrides.get(name), model });
				ctx.ui.notify(`${displayName(state.def.name)} model → ${model}`, "info");
				updateWidget();
				return;
			}

			// /agent thinking <name> <level>
			if (sub === "thinking") {
				const name = argv[1]?.toLowerCase();
				const level = argv[2]?.toLowerCase();
				if (!name || !level) { ctx.ui.notify("Usage: /agent thinking <name> <level>", "warning"); return; }
				const state = agentStates.get(name);
				if (!state) { ctx.ui.notify(`Unknown agent: ${argv[1]}`, "error"); return; }
				if (state.status === "running") { ctx.ui.notify(`Cannot override "${displayName(state.def.name)}" while it is running`, "error"); return; }
				if (!VALID_THINKING_LEVELS.has(level)) {
					ctx.ui.notify(`Invalid thinking level "${level}". Valid: ${[...VALID_THINKING_LEVELS].join(", ")}`, "error");
					return;
				}
				agentOverrides.set(name, { ...agentOverrides.get(name), thinkingLevel: level });
				ctx.ui.notify(`${displayName(state.def.name)} thinking → ${level}`, "info");
				updateWidget();
				return;
			}

			// /agent reset <name | all>
			if (sub === "reset") {
				const target = argv[1]?.toLowerCase();
				if (!target) { ctx.ui.notify("Usage: /agent reset <name | all>", "warning"); return; }
				if (target === "all") {
					agentOverrides.clear();
					ctx.ui.notify("All agent overrides cleared", "info");
					updateWidget();
					return;
				}
				const state = agentStates.get(target);
				if (!state) { ctx.ui.notify(`Unknown agent: ${argv[1]}`, "error"); return; }
				if (state.status === "running") { ctx.ui.notify(`Cannot reset "${displayName(state.def.name)}" while it is running`, "error"); return; }
				agentOverrides.delete(target);
				ctx.ui.notify(`${displayName(state.def.name)} overrides cleared`, "info");
				updateWidget();
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${sub}\nUsage: /agent list | show <name> | model <name> <id> | thinking <name> <level> | reset <name|all>`, "warning");
		},

		getArgumentCompletions: (prefix) => {
			// pi replaces the *whole* argument prefix with item.value, so values
			// below include the already-entered command chain, not only the token.
			const trimmed = prefix.trim();
			const argv = trimmed ? trimmed.split(/\s+/) : [];
			if (/\s$/.test(prefix)) argv.push("");

			const startsWith = (value: string, query: string | undefined) =>
				value.toLowerCase().startsWith((query ?? "").toLowerCase());

			// first token — subcommand
			if (argv.length <= 1) {
				const subcommands = ["list", "show", "model", "thinking", "reset"];
				return subcommands
					.filter(s => startsWith(s, argv[0]))
					.map(s => ({
						value: ["show", "model", "thinking", "reset"].includes(s) ? `${s} ` : s,
						label: s,
					}));
			}

			const sub = argv[0]?.toLowerCase();
			const agentNames = Array.from(agentStates.keys());

			// second token — agent name (for show, model, thinking, reset)
			if (argv.length === 2 && ["show", "model", "thinking", "reset"].includes(sub)) {
				const candidates = sub === "reset"
					? [...agentNames, "all"]
					: agentNames;
				const suffix = ["model", "thinking"].includes(sub) ? " " : "";
				return candidates
					.filter(n => startsWith(n, argv[1]))
					.map(n => ({
						value: `${sub} ${n}${suffix}`,
						label: n === "all" ? "all" : displayName(agentStates.get(n)?.def.name ?? n),
					}));
			}

			// third token — thinking level
			if (argv.length === 3 && sub === "thinking" && argv[1]) {
				return [...VALID_THINKING_LEVELS]
					.filter(l => startsWith(l, argv[2]))
					.map(l => ({ value: `${sub} ${argv[1]} ${l}`, label: l }));
			}

			return null;
		},
	});

	// ── Orchestrator system prompt ─────────────────────────────────────────

	pi.on("thinking_level_select", async (event, _ctx) => {
		storedOrchestratorThinkingLevel = event.level;
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
    	return {systemPrompt: orchestratorDef.systemPrompt};
	});

	// ── Session start ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (widgetCtx) widgetCtx.ui.setWidget("agent-team", undefined);
		widgetCtx     = ctx;
		// Apply theme and title
		if (ctx.hasUI) {
			ctx.ui.setTheme("dracula");
			ctx.ui.setTitle("π - MAGI");
		}

        orchestratorDef = parseAgentFile(join(__dirname, "..", "definitions", "orchestrator.md"));
		activateTeam(loadAgents(ctx.cwd));
		if ((ctx as any).thinkingLevel) {
			storedOrchestratorThinkingLevel = (ctx as any).thinkingLevel;
		}

		pi.setActiveTools(["dispatch_agent"]);

		ctx.ui.setStatus("agent-team", `👥 MAGI TEAM ONLINE`);
		ctx.ui.notify(
			`MAGI system online` +
			`Members: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}\n\n`
		);
		updateWidget();

		// Footer: model · team | context bar / orch + agent costs
		setTimeout(() => {
			ctx.ui.setFooter((_tui, theme, footerData) => {
				const unsub = footerData.onBranchChange(() => _tui.requestRender());
				return {
					dispose: unsub,
					invalidate() {},
					render(width: number): string[] {
						const model = ctx.model?.id || "no-model";
						const usage = ctx.getContextUsage();
						const pct   = usage?.percent ?? 0;
						const filled = Math.round(pct / 10);
						const bar = "#".repeat(filled) + "-".repeat(10 - filled);

						const l1Left  = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + theme.fg("accent", teamName);
						const l1Right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
						const pad1    = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
						const line1   = truncateToWidth(l1Left + pad1 + l1Right, width);

						let orchCost = 0;
						for (const entry of ctx.sessionManager.getBranch()) {
							if (entry.type === "message" && entry.message.role === "assistant") {
								orchCost += (entry.message as AssistantMessage).usage?.cost?.total ?? 0;
							}
						}

						const agentCost  = Array.from(agentStates.values()).reduce((s, a) => s + a.lifetimeCost, 0);
						const totalCost  = orchCost + agentCost;
						const fmt        = (n: number) => `$${n.toFixed(4)}`;

						const l2Left  = theme.fg("dim", " orch ") + theme.fg("success", fmt(orchCost)) + theme.fg("dim", "  agents ") + theme.fg("accent", fmt(agentCost));
						const l2Right = theme.fg("dim", "total ") + theme.fg("warning", `${fmt(totalCost)} `);
						const pad2    = " ".repeat(Math.max(1, width - visibleWidth(l2Left) - visibleWidth(l2Right)));
						const line2   = truncateToWidth(l2Left + pad2 + l2Right, width);
                        let lines: string[] = [line1, line2]
                        const extensionStatuses = footerData.getExtensionStatuses();
                        if (extensionStatuses.size > 0) {
                            const sortedStatuses = Array.from(extensionStatuses.entries())
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([, text]) => sanitizeStatusText(text));
                            const statusLine =  " " + sortedStatuses.join(" · ");
                            // Truncate to terminal width with dim ellipsis for consistency with footer style
                            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
                        }

						return lines;
					},
				};
			});
		}, 0);
	});
}
