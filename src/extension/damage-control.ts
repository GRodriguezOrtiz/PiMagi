import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

interface RuleObject {
	pattern: string;
	reason?: string;
	ask?: boolean;
}

type PathRule = string | RuleObject;

interface RawRules {
	bashToolPatterns?: RuleObject[];
	zeroAccessPaths?: PathRule[];
	readOnlyPaths?: PathRule[];
	noDeletePaths?: PathRule[];
}

interface CompiledBashRule {
	regex: RegExp;
	source: string;
	reason: string;
	ask: boolean;
}

interface CompiledPathRule {
	pattern: string; // expanded (no ~), original separator preserved
	reason?: string;
	ask: boolean;
}

interface CompiledRules {
	bashToolPatterns: CompiledBashRule[];
	zeroAccessPaths: CompiledPathRule[];
	readOnlyPaths: CompiledPathRule[];
	noDeletePaths: CompiledPathRule[];
}

const EMPTY_RULES: CompiledRules = {
	bashToolPatterns: [],
	zeroAccessPaths: [],
	readOnlyPaths: [],
	noDeletePaths: [],
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolvePath(p: string, cwd: string): string {
	return path.resolve(cwd, expandTilde(p));
}

/** Resolve symlinks if possible; fall back to logical path. */
function realResolve(p: string, cwd: string): string {
	const abs = resolvePath(p, cwd);
	try {
		return fs.realpathSync.native(abs);
	} catch {
		// Path may not exist (e.g. write target) — walk up to a real ancestor.
		let cur = abs;
		const tail: string[] = [];
		while (cur !== path.dirname(cur)) {
			try {
				const real = fs.realpathSync.native(cur);
				return tail.length ? path.join(real, ...tail.reverse()) : real;
			} catch {
				tail.push(path.basename(cur));
				cur = path.dirname(cur);
			}
		}
		return abs;
	}
}

/** True when `target` is `dir` or lives inside it. */
function isWithin(target: string, dir: string): boolean {
	const rel = path.relative(dir, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Glob-style matcher with `*`, `**`, `?`. No substring fallback. */
function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
	const expanded = expandTilde(pattern);
	const isDirPattern = expanded.endsWith("/") || expanded.endsWith(path.sep);
	const cleaned = isDirPattern ? expanded.replace(/[\\/]+$/, "") : expanded;

	// Glob → regex
	if (/[*?[]/.test(cleaned)) {
		const body = cleaned
			.replace(/[.+^${}()|\\]/g, "\\$&")
			.replace(/\*\*/g, "\u0000")
			.replace(/\*/g, "[^/]*")
			.replace(/\u0000/g, ".*")
			.replace(/\?/g, ".");
		let regex: RegExp;
		try {
			regex = new RegExp(`^${body}$`);
		} catch {
			return false;
		}
		const rel = path.relative(cwd, targetPath);
		return regex.test(targetPath) || regex.test(rel);
	}

	const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
	if (isDirPattern) return isWithin(targetPath, absolute);
	if (targetPath === absolute) return true;
	// Allow bare-name patterns to match by relative form too
	return path.relative(cwd, targetPath) === cleaned;
}

// ---------------------------------------------------------------------------
// Bash parsing helpers
// ---------------------------------------------------------------------------

const MUTATING_BINS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"dd",
	"tee",
	"install",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"shred",
	"ln",
	"touch",
]);

const DELETING_BINS = new Set(["rm", "rmdir", "shred", "mv"]);

/** Quote-aware tokenizer. Strips quotes; expands ~ at the start of tokens. */
function tokenizeBash(cmd: string): string[] {
	const tokens: string[] = [];
	const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null) {
		tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
	}
	return tokens;
}

function commandMutates(cmd: string): boolean {
	// Redirects to a file: > or >> (but not 2>&1 style fd duplication)
	if (/(?:^|[\s;|&(])(?:\d*)>>?(?!&)\s*\S/.test(cmd)) return true;
	// In-place edits
	if (/(?:^|[\s;|&(])(?:sed|perl|gawk)\s+(?:[^|;&]*\s)?-[A-Za-z]*i\b/.test(cmd)) return true;

	for (const tok of tokenizeBash(cmd)) {
		const bin = path.basename(tok);
		if (MUTATING_BINS.has(bin)) return true;
	}
	return false;
}

function commandDeletes(cmd: string): boolean {
	for (const tok of tokenizeBash(cmd)) {
		const bin = path.basename(tok);
		if (DELETING_BINS.has(bin)) return true;
	}
	return false;
}

/** Tokens that look like file path arguments (skip flags). */
function pathLikeTokens(cmd: string): string[] {
	const out: string[] = [];
	for (const tok of tokenizeBash(cmd)) {
		if (!tok || tok.startsWith("-")) continue;
		// Skip obvious non-path tokens (env var assignments, operators)
		if (/^[A-Z_][A-Z0-9_]*=/.test(tok)) continue;
		if (["&&", "||", "|", ";", ">", ">>", "<", "<<"].includes(tok)) continue;
		out.push(tok);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Rule compilation
// ---------------------------------------------------------------------------

function normalizePathRule(r: PathRule): CompiledPathRule {
	if (typeof r === "string") return { pattern: r, ask: false };
	return { pattern: r.pattern, reason: r.reason, ask: !!r.ask };
}

function compileRules(raw: RawRules, warn: (m: string) => void): CompiledRules {
	const bash: CompiledBashRule[] = [];
	for (const r of raw.bashToolPatterns ?? []) {
		try {
			bash.push({
				regex: new RegExp(r.pattern),
				source: r.pattern,
				reason: r.reason ?? `Bash pattern matched: ${r.pattern}`,
				ask: !!r.ask,
			});
		} catch (err) {
			warn(`Invalid bash regex /${r.pattern}/: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return {
		bashToolPatterns: bash,
		zeroAccessPaths: (raw.zeroAccessPaths ?? []).map(normalizePathRule),
		readOnlyPaths: (raw.readOnlyPaths ?? []).map(normalizePathRule),
		noDeletePaths: (raw.noDeletePaths ?? []).map(normalizePathRule),
	};
}

function totalRules(r: CompiledRules): number {
	return r.bashToolPatterns.length + r.zeroAccessPaths.length + r.readOnlyPaths.length + r.noDeletePaths.length;
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

interface Violation {
	reason: string;
	ask: boolean;
}

export default function (pi: ExtensionAPI) {
	let rules: CompiledRules = EMPTY_RULES;

	function matchPathRules(targetPath: string, list: CompiledPathRule[], cwd: string): CompiledPathRule | null {
		const real = realResolve(targetPath, cwd);
		for (const rule of list) {
			if (isPathMatch(real, rule.pattern, cwd) || isPathMatch(resolvePath(targetPath, cwd), rule.pattern, cwd)) {
				return rule;
			}
		}
		return null;
	}

	pi.on("session_start", async (_event, ctx) => {
		const projectRulesPath = path.join(ctx.cwd, ".pi", "damage-control", "damage-control-rules.yaml");
		const globalRulesPath = path.join(os.homedir(), ".pi", "damage-control", "damage-control-rules.yaml");
		const rulesPath = fs.existsSync(projectRulesPath)
			? projectRulesPath
			: fs.existsSync(globalRulesPath)
				? globalRulesPath
				: null;

		try {
			if (rulesPath) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = (yamlParse(content) ?? {}) as RawRules;
				rules = compileRules(loaded, (m) => ctx.ui.notify(`🛡️ Damage-Control: ${m}`, "warning"));
				const source = rulesPath === projectRulesPath ? "project" : "global";
				ctx.ui.notify(`🛡️ Damage-Control: Loaded ${totalRules(rules)} rules (${source}).`);
			} else {
				ctx.ui.notify("🛡️ Damage-Control: No rules found at .pi/damage-control-rules.yaml (project or global)");
			}
		} catch (err) {
			ctx.ui.notify(
				`🛡️ Damage-Control: Failed to load rules: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		ctx.ui.setStatus("damage-control", `🛡️ Damage-Control Active: ${totalRules(rules)} Rules`);
	});

	pi.on("tool_call", async (event, ctx) => {
		const violation = evaluate(event, ctx.cwd);
		if (!violation) return undefined;

		const action = violation.ask ? await askUser(event, violation, ctx) : "blocked";

		if (action === "allow") {
			pi.appendEntry("damage-control-log", {
				tool: event.toolName,
				input: event.input,
				rule: violation.reason,
				action: "confirmed_by_user",
			});
			return undefined;
		}

		if (!violation.ask) {
			ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} — ${violation.reason}`, "warning");
		}
		ctx.ui.setStatus("damage-control", `⚠️ Last Violation: ${violation.reason.slice(0, 30)}...`);
		pi.appendEntry("damage-control-log", {
			tool: event.toolName,
			input: event.input,
			rule: violation.reason,
			action: violation.ask ? "blocked_by_user" : "blocked",
		});

		const suffix = violation.ask ? " (User denied)" : "";
		return {
			block: true,
			reason:
				`🛑 BLOCKED by Damage-Control: ${violation.reason}${suffix}\n\n` +
				`DO NOT attempt to work around this restriction. DO NOT retry with alternative ` +
				`commands, paths, or approaches that achieve the same result. Report this block ` +
				`to the user exactly as stated and ask how they would like to proceed.`,
		};
	});

	// -------------------------------------------------------------------------
	// Evaluation
	// -------------------------------------------------------------------------

	function evaluate(event: ToolCallEvent, cwd: string): Violation | null {
		// 1. Collect declared input paths
		const inputPaths: string[] = [];
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			if (typeof event.input.path === "string") inputPaths.push(event.input.path);
		} else if (
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			const p = event.input.path;
			inputPaths.push(typeof p === "string" && p ? p : ".");
		}

		// 2. Zero-access path check (any tool that takes a path)
		for (const p of inputPaths) {
			const hit = matchPathRules(p, rules.zeroAccessPaths, cwd);
			if (hit) return { reason: hit.reason ?? `Access to zero-access path restricted: ${hit.pattern}`, ask: hit.ask };
		}

		// 2b. Grep glob field
		if (isToolCallEventType("grep", event) && typeof event.input.glob === "string" && event.input.glob) {
			const g = event.input.glob;
			for (const rule of rules.zeroAccessPaths) {
				if (isPathMatch(g, rule.pattern, cwd)) {
					return { reason: rule.reason ?? `Glob matches zero-access path: ${rule.pattern}`, ask: rule.ask };
				}
			}
		}

		// 3. Bash-specific
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";

			for (const rule of rules.bashToolPatterns) {
				if (rule.regex.test(command)) return { reason: rule.reason, ask: rule.ask };
			}

			const tokens = pathLikeTokens(command);
			const mutates = commandMutates(command);
			const deletes = commandDeletes(command);

			for (const tok of tokens) {
				// Zero-access: any reference at all
				const zap = matchPathRules(tok, rules.zeroAccessPaths, cwd);
				if (zap) {
					return {
						reason: zap.reason ?? `Bash command references zero-access path: ${zap.pattern}`,
						ask: zap.ask,
					};
				}
				if (mutates) {
					const rop = matchPathRules(tok, rules.readOnlyPaths, cwd);
					if (rop) {
						return {
							reason: rop.reason ?? `Bash command may modify read-only path: ${rop.pattern}`,
							ask: rop.ask,
						};
					}
				}
				if (deletes) {
					const ndp = matchPathRules(tok, rules.noDeletePaths, cwd);
					if (ndp) {
						return {
							reason: ndp.reason ?? `Bash command attempts to delete/move protected path: ${ndp.pattern}`,
							ask: ndp.ask,
						};
					}
				}
			}
			return null;
		}

		// 4. Write/edit → read-only path check
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			for (const p of inputPaths) {
				const rop = matchPathRules(p, rules.readOnlyPaths, cwd);
				if (rop) {
					return {
						reason: rop.reason ?? `Modification of read-only path restricted: ${rop.pattern}`,
						ask: rop.ask,
					};
				}
			}
		}

		return null;
	}

	async function askUser(
		event: ToolCallEvent,
		violation: Violation,
		ctx: ExtensionContext,
	): Promise<"allow" | "block"> {
		const detail = isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input);
		const confirmed = await ctx.ui.confirm(
			"🛡️ Damage-Control Confirmation",
			`Dangerous command detected: ${violation.reason}\n\nCommand: ${detail}\n\nDo you want to proceed?`,
			{ timeout: 30000 },
		);
		return confirmed ? "allow" : "block";
	}
}
