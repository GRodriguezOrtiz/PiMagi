/**
 * Theme Cycler — Keyboard shortcuts to cycle through available themes
 *
 * Shortcuts:
 *   Alt+E         — Cycle theme forward
 *   Alt+Q          — Cycle theme backward
 *
 * Commands:
 *   /theme          — Open select picker to choose a theme
 *   /theme <name>   — Switch directly by name
 *
 * Features:
 *   - Status line shows current theme name with accent color
 *   - Color swatch widget flashes briefly after each switch
 *   - Auto-dismisses swatch after 3 seconds
 *
 * Usage: pi -e extensions/theme-cycler.ts -e extensions/minimal.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename, join } from "node:path";
import { homedir } from "node:os";

// ── Default theme assignments ─────────────────────────────────────────────
// Key   = extension filename without extension (matches extensions/<key>.ts)
// Value = theme name from .pi/themes/<value>.json
const THEME_MAP: Record<string, string> = {
	"agent-chain":         "midnight-ocean",   // deep sequential pipeline
	"agent-team":          "dracula",          // rich orchestration palette
	"cross-agent":         "ocean-breeze",     // cross-boundary, connecting
	"damage-control":      "gruvbox",          // grounded, earthy safety
	"minimal":             "synthwave",        // synthwave by default now!
	"pi-pi":               "rose-pine",        // warm creative meta-agent
	"pure-focus":          "everforest",       // calm, distraction-free
	"purpose-gate":        "tokyo-night",      // intentional, sharp focus
	"session-replay":      "catppuccin-mocha", // soft, reflective history
	"subagent-widget":     "cyberpunk",        // multi-agent futuristic
	"system-select":       "catppuccin-mocha", // soft selection UI
	"theme-cycler":        "synthwave",        // neon, it's a theme tool
	"tilldone":            "everforest",       // task-focused calm
	"tool-counter":        "synthwave",        // techy metrics
	"tool-counter-widget": "synthwave",        // same family
};

const DEFAULT_THEME = "synthwave";

/**
 * Read process.argv to find the first -e / --extension flag value.
 * Returns null if no -e flag is present (e.g. plain `pi` with no extensions).
 */
function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

/**
 * Apply the mapped theme + terminal title for the primary stacked extension.
 * This is the single place in the codebase that owns boot-time presentation.
 */
function applyBootDefaults(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const primary = primaryExtensionName();
	if (!primary) return;

	const themeName = THEME_MAP[primary] ?? DEFAULT_THEME;
	const result = ctx.ui.setTheme(themeName);
	if (!result.success && themeName !== DEFAULT_THEME) {
		ctx.ui.setTheme(DEFAULT_THEME);
	}

	// Deferred 150 ms to fire after pi's own startup title-set.
	setTimeout(() => ctx.ui.setTitle(`π - ${primary}`), 150);
}

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let swatchTimer: ReturnType<typeof setTimeout> | null = null;

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const name = ctx.ui.theme.name;
		ctx.ui.setStatus("theme", `🎨 ${name}`);
	}

	function showSwatch(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}

		ctx.ui.setWidget(
			"theme-swatch",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const block = "\u2588\u2588\u2588";
					const swatch =
						theme.fg("success", block) +
						" " +
						theme.fg("accent", block) +
						" " +
						theme.fg("warning", block) +
						" " +
						theme.fg("dim", block) +
						" " +
						theme.fg("muted", block);
					const label = theme.fg("accent", " 🎨 ") + theme.fg("muted", ctx.ui.theme?.name ?? "") + "  " + swatch;
					const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
					return [border, truncateToWidth("  " + label, width), border];
				},
			}),
			{ placement: "belowEditor" },
		);

		swatchTimer = setTimeout(() => {
			ctx.ui.setWidget("theme-swatch", undefined);
			swatchTimer = null;
		}, 3000);
	}

	function getThemeList(ctx: ExtensionContext) {
		return ctx.ui.getAllThemes();
	}

	function findCurrentIndex(ctx: ExtensionContext): number {
		const themes = getThemeList(ctx);
		const current = ctx.ui.theme.name;
		return themes.findIndex((t) => t.name === current);
	}

	function cycleTheme(ctx: ExtensionContext, direction: 1 | -1) {
		if (!ctx.hasUI) return;

		const themes = getThemeList(ctx);
		if (themes.length === 0) {
			ctx.ui.notify("No themes available", "warning");
			return;
		}

		let index = findCurrentIndex(ctx);
		if (index === -1) index = 0;

		index = (index + direction + themes.length) % themes.length;
		const theme = themes[index];
		const result = ctx.ui.setTheme(theme.name);

		if (result.success) {
			updateStatus(ctx);
			showSwatch(ctx);
			ctx.ui.notify(`${theme.name} (${index + 1}/${themes.length})`, "info");
		} else {
			ctx.ui.notify(`Failed to set theme: ${result.error}`, "error");
		}
	}

	// --- Shortcuts ---

	pi.registerShortcut("alt+e", {
		description: "Cycle theme forward",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleTheme(ctx, 1);
		},
	});

	pi.registerShortcut("alt+q", {
		description: "Cycle theme backward",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleTheme(ctx, -1);
		},
	});

	// --- Command: /theme ---

	pi.registerCommand("theme", {
		description: "Select a theme: /theme or /theme <name>",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			if (!ctx.hasUI) return;

			const themes = getThemeList(ctx);
			const arg = args.trim();

			if (arg) {
				const result = ctx.ui.setTheme(arg);
				if (result.success) {
					updateStatus(ctx);
					showSwatch(ctx);
					ctx.ui.notify(`Theme: ${arg}`, "info");
				} else {
					ctx.ui.notify(`Theme not found: ${arg}. Use /theme to see available themes.`, "error");
				}
				return;
			}

			const items = themes.map((t) => {
				const desc = t.path ? t.path : "built-in";
				const active = t.name === ctx.ui.theme.name ? " (active)" : "";
				return `${t.name}${active} — ${desc}`;
			});

			const selected = await ctx.ui.select("Select Theme", items);
			if (!selected) return;

			const selectedName = selected.split(/\s/)[0];
			const result = ctx.ui.setTheme(selectedName);
			if (result.success) {
				updateStatus(ctx);
				showSwatch(ctx);
				ctx.ui.notify(`Theme: ${selectedName}`, "info");
			}
		},
	});

	// --- Theme discovery ---

	pi.on("resources_discover", () => ({
		themePaths: [join(homedir(), ".pi", "themes")],
	}));

	// --- Session init ---

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		applyBootDefaults(ctx);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}
	});
}
