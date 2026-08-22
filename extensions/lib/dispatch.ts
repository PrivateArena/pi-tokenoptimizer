// Dispatcher: routes a bash command to the right compactor.

import type { OptimizerConfig, Options } from "./types.ts";
import {
	compactGitStatus,
	compactGitDiff,
	compactGitLog,
	compactGitAdd,
	compactGitCommit,
	compactGitPush,
	compactGitPull,
} from "./git.ts";
import { compactLs, compactTree, compactCat } from "./fsview.ts";
import { compactGrep } from "./grep.ts";
import { compactTestOutput } from "./tests.ts";
import { compactRuff, compactJq } from "./linters.ts";
import { optimizeChainedCommand, safeGlobalOptimize, deduplicateWithThreshold } from "./chained.ts";

export function optimizeOutput(command: string, output: string, options: Options, cfg: OptimizerConfig): string {
	const trimmed = command.trim();

	const isChained = trimmed.includes("&&") || trimmed.includes("||") || trimmed.includes(";");
	const hasPipe = trimmed.includes("|");
	if (isChained || hasPipe) return optimizeChainedCommand(output, cfg);

	const parts = trimmed.split(/\s+/);
	const firstWord = parts[0] ?? "";
	const subcommand = parts[1] ?? "";

	if (firstWord === "git") {
		switch (subcommand) {
			case "status":
				return compactGitStatus(output);
			case "diff":
				return compactGitDiff(output);
			case "log":
				return compactGitLog(output, options);
			case "add":
				return compactGitAdd(output);
			case "commit":
				return compactGitCommit(output);
			case "push":
				return compactGitPush(output);
			case "pull":
				return compactGitPull(output);
		}
	}

	if (firstWord === "ls" || firstWord === "ll" || firstWord === "la") {
		return compactLs(output, options);
	}

	if (firstWord === "tree") return compactTree(output, options);
	if (firstWord === "cat") return compactCat(output, options);
	if (firstWord === "rg" || firstWord === "grep" || firstWord === "ag") {
		return compactGrep(output, options);
	}

	if (testCommand(firstWord, subcommand)) {
		return compactTestOutput(output, command, options);
	}
	if (firstWord === "go" && (subcommand === "test" || subcommand.startsWith("test-"))) {
		return compactTestOutput(output, command, options);
	}

	if (
		firstWord === "go" ||
		firstWord === "npm" ||
		firstWord === "yarn" ||
		firstWord === "pnpm" ||
		firstWord === "bun" ||
		firstWord === "cargo" ||
		firstWord === "python"
	) {
		return output;
	}

	if (firstWord === "ruff") return compactRuff(output);
	if (firstWord === "jq") return compactJq(output);

	const globallyOptimized = safeGlobalOptimize(output);
	let fallbackThreshold = cfg.deduplicateThreshold > 0 ? cfg.deduplicateThreshold : 3;
	fallbackThreshold += 2;
	const deduplicated = deduplicateWithThreshold(globallyOptimized, fallbackThreshold);
	if (deduplicated !== globallyOptimized) return deduplicated;
	if (Buffer.byteLength(globallyOptimized) < Buffer.byteLength(output)) return globallyOptimized;
	return output;
}

export function testCommand(firstWord: string, subcommand: string): boolean {
	switch (firstWord) {
		case "npm":
		case "yarn":
		case "pnpm":
			if (subcommand === "test" || subcommand.startsWith("test:")) return true;
			return subcommand.startsWith("run ") && (subcommand.includes("test") || subcommand.endsWith(":test"));
		case "bun":
			if (subcommand === "test") return true;
			return subcommand.startsWith("run ") && subcommand.includes("test");
		case "cargo":
			return subcommand === "test" || subcommand === "bench";
		case "pytest":
		case "jest":
		case "vitest":
			return true;
	}
	return false;
}
