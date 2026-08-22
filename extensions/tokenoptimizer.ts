// tokenoptimizer.ts — pi agent extension (entry point).
//
// Port of zen-mcp internal/shell/tokenoptimizer (tokenoptimizer.go): per-command
// shell-output compaction (git*, ls, grep, cat, test runners, ruff, jq),
// chained-command safe optimization, the shell output blacklist, and
// token-profiles (replace / file). Profiles may be embedded directly in
// tokenoptimizer.json (`profiles: [...]`) or loaded from a separate file via
// `profilesPath` (embedded takes precedence).
// Integration: hooks the `tool_result` event for the built-in `bash` tool
// and rewrites the text content the LLM sees. Execution, streaming,
// truncation and UI rendering of the built-in tool are untouched.
//
// Config: ~/.pi/agent/tokenoptimizer.json, overridden by .pi/tokenoptimizer.json
// in the project:
// {
//   "enabled": true,
//   "ultraCompact": false,
//   "maxChainedLength": 51200,
//   "deduplicateThreshold": 3,
//   "profilesPath": "token-profiles.json",
//   "blacklist": [{ "match": "terraform plan", "isRegex": false, "maxLines": 30, "dropOutput": false, "label": "" }]
// }
//
// Slash command: /tokopt [on|off|ultra|stats] — toggle / mode / savings.
//
// Modules under ./lib contain the pure compaction/dispatch/blacklist/profile
// logic; this file owns the extension lifecycle and event wiring only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { optimizeOutput } from "./lib/dispatch.ts";
import { applyBlacklist } from "./lib/blacklist.ts";
import { applyTokenProfiles } from "./lib/profiles.ts";
import { DEFAULT_CONFIG, type OptimizerConfig, type Options } from "./lib/types.ts";

export { optimizeOutput, testCommand } from "./lib/dispatch.ts";
export { applyBlacklist } from "./lib/blacklist.ts";
export { applyTokenProfiles } from "./lib/profiles.ts";
export { DEFAULT_CONFIG } from "./lib/types.ts";

interface Stats {
	calls: number;
	originalBytes: number;
	optimizedBytes: number;
}

export default function tokenOptimizerExtension(pi: ExtensionAPI) {
	let cfg: OptimizerConfig = { ...DEFAULT_CONFIG };
	let stats: Stats = { calls: 0, originalBytes: 0, optimizedBytes: 0 };

	async function loadConfig(cwd: string): Promise<void> {
		cfg = { ...DEFAULT_CONFIG };
		const home = process.env.HOME || process.env.USERPROFILE || "";
		await mergeConfigFile(home ? join(home, ".pi", "agent", "tokenoptimizer.json") : "");
		await mergeConfigFile(join(cwd, ".pi", "tokenoptimizer.json"));
	}

	async function mergeConfigFile(path: string): Promise<void> {
		if (!path) return;
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw);
			cfg = { ...cfg, ...parsed };
		} catch {
			// missing or invalid — ignore
		}
	}

	async function persistEnabled(enabled: boolean): Promise<void> {
		cfg.enabled = enabled;
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const path = home ? join(home, ".pi", "agent", "tokenoptimizer.json") : "";
		if (!path) return;
		try {
			let current: Record<string, unknown> = {};
			try {
				current = JSON.parse(await readFile(path, "utf8"));
			} catch {
				// start fresh
			}
			current.enabled = enabled;
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(current, null, 2) + "\n");
		} catch {
			// best effort
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await loadConfig(ctx.cwd);
		stats = { calls: 0, originalBytes: 0, optimizedBytes: 0 };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || !cfg.enabled) return undefined;
		try {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!command) return undefined;

			const textBlocks = event.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
			if (textBlocks.length === 0) return undefined;
			const otherBlocks = event.content.filter((b) => b.type !== "text");
			const originalText = textBlocks.map((b) => b.text).join("\n");
			if (!originalText.trim()) return undefined;

			const options: Options = {
				ultraCompact: cfg.ultraCompact,
				exitOk: !event.isError,
				skipOptimization: false,
			};

			// 1. token profiles
			const profileResult = await applyTokenProfiles(command, originalText, "", options, cfg, ctx.cwd);
			let optimized = profileResult.applied ? profileResult.stdout : originalText;
			const profileApplied = profileResult.applied;

			// 2. generic optimization (skipped when a profile rewrote the output)
			if (!profileApplied) {
				optimized = optimizeOutput(command, optimized, options, cfg);
			}

			// 3. blacklist
			const bl = applyBlacklist(command, optimized, cfg.blacklist);
			if (bl !== null) optimized = bl;

			stats.calls++;
			stats.originalBytes += Buffer.byteLength(originalText);
			stats.optimizedBytes += Buffer.byteLength(optimized);

			if (optimized === originalText) return undefined;

			return { content: [{ type: "text", text: optimized }, ...otherBlocks] };
		} catch {
			return undefined; // fail open — never break the bash tool
		}
	});

	pi.registerCommand("tokopt", {
		description: "Token optimizer: /tokopt [on|off|ultra|stats]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				await persistEnabled(arg === "on");
				ctx.ui.notify(`Token optimizer ${arg === "on" ? "enabled" : "disabled"} (persisted)`, "success");
			} else if (arg === "ultra") {
				cfg.ultraCompact = !cfg.ultraCompact;
				ctx.ui.notify(`Ultra-compact mode ${cfg.ultraCompact ? "ON" : "OFF"} (session only)`, "info");
			} else {
				const origK = (stats.originalBytes / 1024).toFixed(1);
				const optK = (stats.optimizedBytes / 1024).toFixed(1);
				const pct =
					stats.originalBytes > 0
						? Math.round(((stats.originalBytes - stats.optimizedBytes) / stats.originalBytes) * 100)
						: 0;
				ctx.ui.notify(
					`tokopt: ${cfg.enabled ? "enabled" : "DISABLED"} | ultra=${cfg.ultraCompact} | calls=${stats.calls} | ${origK}KB→${optK}KB (-${pct}%)`,
					"info"
				);
			}
		},
	});
}
