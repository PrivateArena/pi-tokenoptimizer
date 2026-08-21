// tokenoptimizer.ts — pi agent extension.
//
// Port of zen-mcp internal/shell/tokenoptimizer (tokenoptimizer.go +
// virtualize.go): per-command shell-output compaction (git*, ls, grep, cat,
// test runners, ruff, jq), chained-command safe optimization, the shell
// output blacklist, token-profiles.json actions (replace/file; delegate is
// not applicable here), and large-output virtualization to a temp file.
//
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types & config
// ---------------------------------------------------------------------------

interface BlacklistEntry {
	match: string;
	isRegex?: boolean;
	maxLines?: number;
	dropOutput?: boolean;
	label?: string;
}

interface TokenProfile {
	name: string;
	match: { command: string; type?: string }; // contains | exact | regex
	action: {
		type: string; // replace | delegate | file
		find?: string;
		replace?: string;
		is_regex?: boolean;
		flags?: string;
		path?: string;
		message?: string;
	};
}

interface OptimizerConfig {
	enabled: boolean;
	ultraCompact: boolean;
	maxChainedLength: number;
	deduplicateThreshold: number;
	profilesPath: string;
	blacklist: BlacklistEntry[];
}

const DEFAULT_CONFIG: OptimizerConfig = {
	enabled: true,
	ultraCompact: false,
	maxChainedLength: 50 * 1024,
	deduplicateThreshold: 3,
	profilesPath: "token-profiles.json",
	blacklist: [],
};

interface Options {
	ultraCompact: boolean;
	exitOk: boolean; // false when the tool result is an error — suppresses "all passed" shortcuts
	skipOptimization: boolean;
}

const VIRTUALIZE_LIMIT = 24 * 1024;

// ---------------------------------------------------------------------------
// Token counting / savings
// ---------------------------------------------------------------------------

function countTokens(text: string): number {
	return Math.floor((Buffer.byteLength(text) + 3) / 4);
}

// ---------------------------------------------------------------------------
// git compaction
// ---------------------------------------------------------------------------

function compactGitStatus(output: string): string {
	const lines = output.trim().split("\n");
	const modified: string[] = [];
	const deleted: string[] = [];
	const untracked: string[] = [];
	const staged: string[] = [];
	for (const line of lines) {
		if (line.startsWith("M ") || line.startsWith(" M")) {
			modified.push(line.slice(2).trim());
		} else if (line.startsWith("D ")) {
			deleted.push(line.slice(2).trim());
		} else if (line.startsWith("??")) {
			untracked.push(line.slice(2).trim());
		} else if (line.startsWith("A ") || line.startsWith("M\t")) {
			staged.push(line.slice(2).trim());
		}
	}
	const sections: string[] = [];
	if (staged.length > 0) sections.push(sectionLine("Staged", staged));
	if (modified.length > 0) sections.push(sectionLine("Modified", modified));
	if (deleted.length > 0) sections.push(sectionLine("Deleted", deleted));
	if (untracked.length > 0) sections.push(sectionLine("Untracked", untracked));
	if (sections.length === 0) return "✓ Clean";
	return sections.join("\n");
}

function sectionLine(name: string, items: string[]): string {
	const first = items.slice(0, 10);
	let s = `${name} (${items.length}): ${first.join(", ")}`;
	if (items.length > 10) s += "...";
	return s;
}

const statRe = /^(\S+)\s*\|\s*(\d+)\s*([+-]+)/;

function compactGitDiff(output: string): string {
	const lines = output.trim().split("\n");
	if (lines.length === 0) return "";
	if (lines.length < 40) return output.trim();

	let fileCount = 0;
	let insertions = 0;
	let deletions = 0;
	const fileChanges: string[] = [];
	for (const line of lines) {
		const m = statRe.exec(line);
		if (m) {
			fileCount++;
			const count = parseInt(m[2], 10);
			const signs = m[3];
			if (signs.includes("+")) insertions += count;
			if (signs.includes("-")) deletions += count;
			fileChanges.push(`${m[1]}: ${signs}${count}`);
		}
	}

	if (fileCount === 0) {
		return (
			lines.slice(0, 30).join("\n") +
			`\n... [diff truncated, ${lines.length} lines total]`
		);
	}

	let result = `${fileCount} files: +${insertions}/-${deletions}\n`;
	if (fileChanges.length > 15) {
		result += fileChanges.slice(0, 15).join("\n");
		result += `\n... +${fileChanges.length - 15} more files`;
	} else {
		result += fileChanges.join("\n");
	}
	return result;
}

function compactGitLog(output: string, options: Options): string {
	let lines = output
		.trim()
		.split("\n")
		.filter((l) => l.trim() !== "");
	if (options.ultraCompact) {
		return lines
			.slice(0, 10)
			.map((l) => Array.from(l).slice(0, 60).join(""))
			.join("\n");
	}
	if (lines.length > 15) lines = lines.slice(0, 15);
	return lines.join("\n");
}

function compactGitAdd(output: string): string {
	if (output.includes("No files")) return "✓ No files to stage";
	return "✓ Staged";
}

function compactGitCommit(output: string): string {
	const m = /^(\S{7,})/.exec(output);
	if (m) return "✓ " + m[1].slice(0, 8);
	return "✓ Committed";
}

function compactGitPush(output: string): string {
	if (output.includes("Everything up-to-date")) return "✓ Up to date";
	const m = /(\S+)\s*->\s*(\S+)/.exec(output);
	if (m) return "✓ " + m[2];
	return "✓ Pushed";
}

function compactGitPull(output: string): string {
	if (output.includes("Already up to date")) return "✓ Up to date";
	const lines = output.trim().split("\n");
	return lines.slice(0, 5).join("\n");
}

// ---------------------------------------------------------------------------
// ls / tree / cat / grep
// ---------------------------------------------------------------------------

function compactLs(output: string, options: Options): string {
	const lines = output.trim().split("\n");
	if (options.ultraCompact) {
		return lines
			.map((l) => {
				const parts = l.trim().split(/\s+/);
				return parts.length === 0 || parts[0] === "" ? l.trim() : parts[parts.length - 1];
			})
			.join("\n");
	}

	let isDetailed = false;
	if (lines.length > 0) {
		if (lines[0].includes("total")) isDetailed = true;
		else if (/^[d-]\S+\s+\d+/.test(lines[0])) isDetailed = true;
	}

	if (isDetailed) {
		const items: string[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed === "total" || /^\d+$/.test(trimmed)) continue;
			const parts = trimmed.split(/\s+/);
			const name = parts[parts.length - 1];
			const isDir = line.trim().startsWith("d") || parts[0].includes("drwx");
			items.push(isDir ? name + "/" : name);
		}
		return items.join("\n");
	}
	return lines.join("\n");
}

function compactTree(output: string, options: Options): string {
	const lines = output.trim().split("\n");
	if (options.ultraCompact) {
		const items: string[] = [];
		for (const l of lines) {
			if (l.includes("├──") || l.includes("└──") || l.includes("│")) items.push(l);
		}
		const dirs: string[] = [];
		const files: string[] = [];
		for (const item of items.slice(0, 25)) {
			const name = item.replace(/^[│\s]+[└├┄]+/, "").replace(/[└├┄]\s*/g, "").trim();
			if (name === "") continue;
			if (name.endsWith("/") || (item.includes("/") && !/\.[a-z]+$/.test(item))) dirs.push(name);
			else files.push(name);
		}
		let root = "tree";
		if (lines.length > 0) root = lines[0].split("/").pop() ?? root;
		let result = root;
		if (dirs.length > 0) result += "\n" + dirs.join("\n");
		if (files.length > 0) result += "\n" + files.slice(0, 15).join("\n");
		if (files.length > 15) result += `\n+${files.length - 15} files`;
		return result;
	}
	if (lines.length > 50) return lines.slice(0, 40).join("\n") + "\n...";
	return output;
}

function compactCat(output: string, options: Options): string {
	const lines = output.trim().split("\n");
	const totalLines = lines.length;
	if (options.ultraCompact) {
		const keepLines = totalLines > 100 ? 50 : totalLines;
		const result = lines.slice(0, keepLines).join("\n");
		if (totalLines > keepLines) return result + `\n... +${totalLines - keepLines} lines`;
		return result;
	}
	if (totalLines > 500) {
		return (
			lines.slice(0, 400).join("\n") +
			`\n\n... +${totalLines - 400} more lines (use head/tail/range to see specific parts)`
		);
	}
	return output;
}

const fileColonRe = /^([^:]+):/;
const grepLineRe = /^([^:]+):(\d+):?(.*)$/;

function compactGrep(output: string, options: Options): string {
	const lines = output.trim().split("\n");
	if (lines.length === 0) return "";

	// list mode: plain file paths (rg -l)
	const first = lines[0];
	const isListMode = /^[a-zA-Z]:\\/.test(first) || first.includes("/") || !first.includes(":");

	if (isListMode || options.ultraCompact) {
		const files = new Set<string>();
		for (const line of lines) {
			const m = fileColonRe.exec(line);
			if (m) files.add(m[1]);
			else if (line.includes("/")) files.add(line.split("/").pop() ?? line);
			else files.add(line);
		}
		const maxFiles = options.ultraCompact ? 10 : 30;
		const fileList = [...files].sort().slice(0, maxFiles);
		let result = fileList.join("\n");
		if (files.size > maxFiles) result += `\n... +${files.size - maxFiles} more`;
		return result;
	}

	const fileCounts = new Map<string, number>();
	const fileMatches = new Map<string, string[]>();
	for (const line of lines) {
		const m = grepLineRe.exec(line);
		if (m) {
			const file = m[1];
			let content = m[3];
			if (content.length > 80) content = content.slice(0, 80);
			content = content.trim();
			fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
			const limit = options.ultraCompact ? 2 : 5;
			const arr = fileMatches.get(file) ?? [];
			if (arr.length < limit) {
				arr.push(`${m[2]}: ${content}`);
				fileMatches.set(file, arr);
			}
		} else if (line.includes(":")) {
			const file = line.split(":")[0];
			fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
		}
	}

	if (fileCounts.size === 0) {
		return lines.slice(0, 30).join("\n");
	}

	const maxFilesToShow = options.ultraCompact ? 5 : 15;
	const keys = [...fileCounts.keys()].sort();

	const result: string[] = [];
	let shown = 0;
	for (const file of keys) {
		if (shown >= maxFilesToShow) break;
		const shortFile = file.split("/").pop() || file;
		let entry = `${shortFile}: ${fileCounts.get(file)}`;
		const ms = fileMatches.get(file);
		if (ms && ms.length > 0) entry += "\n  " + ms.join("\n  ");
		result.push(entry);
		shown++;
	}
	let out = result.join("\n");
	if (fileCounts.size > maxFilesToShow) {
		out += `\n... +${fileCounts.size - maxFilesToShow} more files`;
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test output / go bench
// ---------------------------------------------------------------------------

const benchRe = /^(\S+)-?\d+\s+(\d+)\s+(\d+)\s+ns\/op(?:\s+(\d+)\s+B\/op)?(?:\s+(\d+)\s+allocs\/op)?/;

interface BenchResult {
	name: string;
	ns: number;
	allocs: number;
}

function compactGoBench(output: string): string {
	const lines = output.trim().split("\n");
	const benchmarks: BenchResult[] = [];
	let hasFailures = false;
	for (const line of lines) {
		const m = benchRe.exec(line);
		if (m) {
			benchmarks.push({
				name: m[1],
				ns: parseInt(m[3], 10),
				allocs: m[5] ? parseInt(m[5], 10) : 0,
			});
		}
		const lower = line.toLowerCase();
		if (lower.includes("fail") || lower.includes("error")) hasFailures = true;
	}

	if (hasFailures) {
		const failureLines = lines.filter((l) => {
			const lower = l.toLowerCase();
			return (
				lower.includes("fail") ||
				lower.includes("error") ||
				lower.includes("panic") ||
				lower.includes("fatal") ||
				l.startsWith("---")
			);
		});
		let result = failureLines.slice(0, 30).join("\n");
		if (failureLines.length > 30) result += `\n... +${failureLines.length - 30} more failures`;
		return result;
	}

	if (benchmarks.length === 0) {
		const summary: string[] = [];
		for (const l of lines) {
			if (
				l.startsWith("ok") ||
				l.startsWith("PASS") ||
				l.startsWith("FAIL") ||
				l.includes("ns/op")
			) {
				summary.push(l);
			}
			if (summary.length >= 5) break;
		}
		if (summary.length > 0) return summary.join("\n");
		return output.trim();
	}

	benchmarks.sort((a, b) => a.ns - b.ns);
	const out: string[] = [`Benchmark results (${benchmarks.length} benchmarks):`];
	for (const b of benchmarks.slice(0, 10)) {
		let ns = `${b.ns}ns`;
		if (b.ns >= 1000) ns = formatMicros(b.ns / 1000);
		let line = `  ${b.name}: ${ns}/op`;
		if (b.allocs > 0) line += ` ${b.allocs} allocs`;
		out.push(line);
	}
	if (benchmarks.length > 10) out.push(`  ... +${benchmarks.length - 10} more`);
	return out.join("\n").trim();
}

function formatMicros(v: number): string {
	return (Math.round(v * 10) / 10).toString().replace(/\.0$/, "") + "µs";
}

const goRunRe = /^\s*===[=]+\s+(run|pass|fail)/;
const goTestLineRe = /^\s*---[ -]+\s+(pass|fail|skip)/i;
const goFailRe = /^\s*---[ -]+\s*FAIL/i;

function compactTestOutput(output: string, command: string, options: Options): string {
	const lines = output.trim().split("\n");
	const lowerOutput = output.toLowerCase();

	const isRust = command.includes("cargo test");
	const isJest =
		command.includes("jest") || command.includes("npm test") || command.includes("yarn test");
	const isPytest = command.includes("pytest") || command.includes("python -m pytest");
	const isGo = command.includes("go test");
	const isGoBench = isGo && (command.includes("bench") || command.includes("-bench"));
	const isVitest = command.includes("vitest");

	if (isGoBench) return compactGoBench(output);

	if (
		options.exitOk &&
		!isGo &&
		(lowerOutput.includes("test result: ok") ||
			(lowerOutput.includes("ok") &&
				!lowerOutput.includes("fail") &&
				!lowerOutput.includes("error")))
	) {
		return "✓ All tests passed";
	}

	const failures: string[] = [];
	const passed: string[] = [];
	let failedCount = 0;
	let passedCount = 0;

	let testLines = lines;
	if (isGo) {
		testLines = lines.filter((line) => {
			const lower = line.trim().toLowerCase();
			return (
				lower.startsWith("pass") ||
				lower.startsWith("fail") ||
				lower.startsWith("ok") ||
				lower.startsWith("---") ||
				lower.startsWith("===") ||
				lower.includes("coverage:") ||
				lower.includes("--- fail") ||
				lower.includes("--- pass") ||
				lower.includes("error") ||
				lower.includes("panic") ||
				lower.includes("fatal") ||
				goRunRe.test(lower) ||
				goTestLineRe.test(lower)
			);
		});
	}

	if (isGo) {
		const failureLines = testLines.filter(
			(l) =>
				l.startsWith("FAIL") ||
				goFailRe.test(l) ||
				l.startsWith("panic:") ||
				l.startsWith("fatal error:")
		);
		if (failureLines.length > 0) {
			const failingTests = failureLines.filter((l) => goFailRe.test(l));
			const count = failingTests.length > 0 ? failingTests.length : failureLines.length;
			let result = `FAILED: ${count} test(s)\n`;
			for (const f of failureLines.slice(0, 10)) result += "  " + f.trim() + "\n";
			return result.trim();
		}
		const passLines = testLines.filter(
			(l) => l.includes(": pass") || l.startsWith("--- PASS") || l.startsWith("ok")
		);
		if (passLines.length > 0 && options.exitOk) return "✓ All tests passed";
	}

	for (const line of testLines) {
		const lower = line.toLowerCase();
		if (isPytest) {
			if (lower.includes("passed") && lower.includes("failed")) {
				const passMatch = /(\d+)\s+passed/.exec(line);
				const failMatch = /(\d+)\s+failed/.exec(line);
				if (passMatch) passedCount = parseInt(passMatch[1], 10);
				if (failMatch) failedCount = parseInt(failMatch[1], 10);
			}
			if (lower.includes("failed")) {
				const m = /^(.*?)(?:\s+FAILED|\s+ERROR)/.exec(line);
				if (m) failures.push(m[1].trim());
			}
		} else if (isGo) {
			if (command.includes("bench")) {
				if (lower.startsWith("ok")) return "✓ Benchmarks passed";
				if (lower.startsWith("fail")) {
					failedCount++;
					failures.push(line.trim());
				}
			} else {
				if (lower.startsWith("fail")) {
					failedCount++;
					failures.push(line.replace("FAIL", "").trim());
				} else if (lower.includes("pass") && !lower.includes("fail")) {
					passedCount++;
				}
			}
		} else if (isJest || isVitest) {
			if (line.includes("✓") || line.includes("PASS")) {
				passed.push(replaceCheckmarks(line).trim());
			} else if (line.includes("✗") || line.includes("FAIL") || line.includes("✕")) {
				failures.push(replaceCheckmarks(line).trim());
			}
		} else if (isRust) {
			if (lower.includes("test result:")) {
				if (lower.includes("ok")) return "✓ All tests passed";
				const m = /(\d+)\s+failed/.exec(line);
				if (m) failedCount = parseInt(m[1], 10);
			}
			if (lower.includes("test ") && lower.includes("... f")) {
				failures.push(line.trim());
			}
		}
	}

	let result: string;
	if (failedCount > 0) {
		result = `FAILED: ${failedCount}/${failedCount + passedCount} tests\n`;
		for (const f of failures.slice(0, 10)) result += `  • ${f}\n`;
		if (failures.length > 10) result += `  ... +${failures.length - 10} more\n`;
	} else if (failures.length > 0) {
		result = `FAILED: ${failures.length} tests\n`;
		for (const f of failures.slice(0, 10)) result += `  • ${f}\n`;
	} else {
		result = "✓ All tests passed";
	}
	return result.trim();
}

function replaceCheckmarks(s: string): string {
	return s.replaceAll("✓", "").replaceAll("✗", "").replaceAll("✕", "");
}

// ---------------------------------------------------------------------------
// ruff / jq
// ---------------------------------------------------------------------------

const ruffLineRe = /^([^:]+):(\d+):(\d+):\s*(.+)/;

function compactRuff(output: string): string {
	const lines = output.trim().split("\n");
	if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
		return "✓ No issues found";
	}

	try {
		const arr = JSON.parse(output);
		if (Array.isArray(arr) && arr.length > 0) {
			const byFile = new Map<string, number>();
			const byRule = new Map<string, number>();
			for (const issue of arr) {
				const file = anyString(issue, ["filename", "file", "location"], "unknown");
				const rule = anyString(issue, ["code", "rule"], "unknown");
				byFile.set(file, (byFile.get(file) ?? 0) + 1);
				byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
			}
			let result = `Found ${arr.length} issues:\n`;
			for (const rule of [...byRule.keys()].sort()) {
				result += `  ${rule}: ${byRule.get(rule)}\n`;
			}
			return result.trim();
		}
	} catch {
		// not JSON — fall through to line parsing
	}

	const byFile = new Map<string, number>();
	const issues: string[] = [];
	for (const line of lines) {
		const m = ruffLineRe.exec(line);
		if (m) {
			const file = m[1].split("/").pop() || m[1];
			byFile.set(file, (byFile.get(file) ?? 0) + 1);
			if (issues.length < 10) issues.push(`${file}:${m[2]}: ${m[4]}`);
		}
	}
	if (byFile.size === 0) return lines.slice(0, 10).join("\n");
	let result = `Found ${lines.length} issues:\n`;
	for (const file of [...byFile.keys()].sort()) {
		result += `  ${file}: ${byFile.get(file)}\n`;
	}
	if (issues.length > 0) {
		result += "\nSample:\n";
		for (const issue of issues.slice(0, 5)) result += `  • ${issue}\n`;
	}
	return result.trim();
}

function anyString(obj: unknown, keys: string[], fallback: string): string {
	if (typeof obj !== "object" || obj === null) return fallback;
	const rec = obj as Record<string, unknown>;
	for (const key of keys) {
		if (typeof rec[key] === "string" && (rec[key] as string) !== "") return rec[key] as string;
		const loc = rec["location"];
		if (typeof loc === "object" && loc !== null) {
			const v = (loc as Record<string, unknown>)[key];
			if (typeof v === "string" && v !== "") return v;
		}
	}
	return fallback;
}

function compactJq(output: string): string {
	const lines = output.trim().split("\n");
	if (lines.length <= 2) {
		try {
			const v = JSON.parse(output.trim());
			return compactJSONStructure(v, 0);
		} catch {
			return output.trim();
		}
	}
	if (lines.length > 50) {
		return lines.slice(0, 10).join("\n") + `\n... +${lines.length - 10} more lines`;
	}
	return output;
}

function compactJSONStructure(v: unknown, depth: number): string {
	if (depth > 3) return "...";
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		const limit = depth === 0 ? 10 : 3;
		const inner = v.slice(0, limit).map((item) => compactJSONStructure(item, depth + 1));
		let result = "[\n  " + inner.join(", ");
		if (v.length > limit) result += `\n  ... +${v.length - limit} more\n]`;
		else result += "\n]";
		return result;
	}
	if (typeof v === "object" && v !== null) {
		const rec = v as Record<string, unknown>;
		const keys = Object.keys(rec).sort();
		if (keys.length === 0) return "{}";
		const limit = depth === 0 ? 15 : 5;
		const preview = keys.slice(0, limit).map((k) => `${k}: ${compactJSONStructure(rec[k], depth + 1)}`);
		let result = "{ " + preview.join(", ");
		if (keys.length > limit) result += ", ...";
		return result + " }";
	}
	return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Chained-command optimization & global fallback
// ---------------------------------------------------------------------------

function optimizeChainedCommand(output: string, cfg: OptimizerConfig): string {
	const trimmed = output.trim();
	const threshold = cfg.deduplicateThreshold > 0 ? cfg.deduplicateThreshold : 3;
	let result = deduplicateWithThreshold(trimmed, threshold);
	result = collapseNewlines(result);
	const maxLen = cfg.maxChainedLength > 0 ? cfg.maxChainedLength : 50 * 1024;
	if (result.length > maxLen) {
		result =
			result.slice(0, maxLen) +
			`\n\n... [output truncated: ${Math.ceil(result.length / 1024)}KB → ${Math.ceil(maxLen / 1024)}KB]`;
	}
	return result;
}

function collapseNewlines(s: string): string {
	return s.replace(/\n{3,}/g, "\n\n");
}

function deduplicateWithThreshold(text: string, minCount: number): string {
	const lines = text.split("\n");
	const counts = new Map<string, number>();
	const unique: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			unique.push(line);
			continue;
		}
		const n = counts.get(trimmed);
		if (n !== undefined) counts.set(trimmed, n + 1);
		else {
			counts.set(trimmed, 1);
			unique.push(line);
		}
	}
	if (counts.size === 0) return text;
	let result = unique.join("\n");
	let hasDuplicates = false;
	for (const [line, count] of counts) {
		if (count > minCount) {
			hasDuplicates = true;
			result = result.split(line).join(`${line} (×${count})`);
		}
	}
	return hasDuplicates ? result : text;
}

function safeGlobalOptimize(output: string): string {
	const lines = output.split("\n");
	const optimized: string[] = [];
	let lastWasEmpty = false;
	for (const line of lines) {
		const stripped = line.replace(/[ \t\r]+$/, "");
		if (stripped.trim() === "") {
			if (!lastWasEmpty && optimized.length > 0) {
				optimized.push("");
				lastWasEmpty = true;
			}
			continue;
		}
		let finalLine = stripped;
		if (stripped.length > 200) finalLine = stripped.replace(/\s{2,}/g, " ");
		optimized.push(finalLine);
		lastWasEmpty = false;
	}
	return optimized.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

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

function testCommand(firstWord: string, subcommand: string): boolean {
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

// ---------------------------------------------------------------------------
// Blacklist
// ---------------------------------------------------------------------------

export function applyBlacklist(command: string, output: string, blacklist: BlacklistEntry[]): string | null {
	if (blacklist.length === 0) return null;
	const cmd = command.trim();
	for (const entry of blacklist) {
		let matched = false;
		if (entry.isRegex) {
			try {
				matched = new RegExp(entry.match).test(cmd);
			} catch {
				matched = cmd.includes(entry.match);
			}
		} else {
			matched = cmd.includes(entry.match);
		}
		if (!matched) continue;
		const label = entry.label || entry.match;
		if (entry.dropOutput) {
			return `[output suppressed — blacklisted command: ${label}]`;
		}
		const cap = entry.maxLines && entry.maxLines > 0 ? entry.maxLines : 30;
		const lines = output.split("\n");
		if (lines.length <= cap) return output;
		return (
			lines.slice(0, cap).join("\n") +
			`\n... [truncated by blacklist rule "${label}": ${lines.length} → ${cap} lines]`
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Token profiles
// ---------------------------------------------------------------------------

interface ProfileResult {
	stdout: string;
	stderr: string;
	applied: boolean;
}

async function applyTokenProfiles(
	command: string,
	stdout: string,
	stderr: string,
	options: Options,
	cfg: OptimizerConfig,
	cwd: string
): Promise<ProfileResult> {
	if (options.skipOptimization) {
		return { stdout, stderr, applied: false };
	}
	const profilesPath = cfg.profilesPath ? resolve(cwd, cfg.profilesPath) : join(cwd, "token-profiles.json");
	let raw: string;
	try {
		raw = await readFile(profilesPath, "utf8");
	} catch {
		return { stdout, stderr, applied: false };
	}
	let profiles: TokenProfile[];
	try {
		profiles = JSON.parse(raw);
	} catch {
		return { stdout, stderr, applied: false };
	}
	if (!Array.isArray(profiles)) return { stdout, stderr, applied: false };

	let finalStdout = stdout;
	let finalStderr = stderr;
	let applied = false;
	const cmd = command.trim();

	for (const profile of profiles) {
		if (!profile?.match?.command || !profile?.action?.type) continue;
		let matched = false;
		switch (profile.match.type) {
			case "exact":
				matched = cmd === profile.match.command.trim();
				break;
			case "regex":
				try {
					matched = new RegExp(profile.match.command).test(cmd);
				} catch {
					matched = cmd.includes(profile.match.command);
				}
				break;
			default:
				matched = cmd.includes(profile.match.command);
		}
		if (!matched) continue;

		switch (profile.action.type) {
			case "replace": {
				if (!profile.action.find) continue;
				const findVal = profile.action.find;
				const replaceVal = profile.action.replace ?? "";
				if (profile.action.is_regex) {
					let pattern = findVal;
					if (profile.action.flags?.includes("i")) pattern = "(?i)" + pattern;
					try {
						// JS has no inline-scoped (?i); emulate with flags where possible
						const caseInsensitive = profile.action.flags?.includes("i") ?? false;
						const jsPattern = caseInsensitive ? stripInlineFlags(pattern) : pattern;
						const re = new RegExp(jsPattern, caseInsensitive ? "gi" : "g");
						finalStdout = finalStdout.replace(re, replaceVal);
						finalStderr = finalStderr.replace(re, replaceVal);
						applied = true;
					} catch {
						// invalid regex — skip this profile
					}
				} else {
					finalStdout = finalStdout.split(findVal).join(replaceVal);
					finalStderr = finalStderr.split(findVal).join(replaceVal);
					applied = true;
				}
				break;
			}
			case "delegate":
				// Not applicable in pi (was deferred to the zen-mcp web-agent bridge).
				break;
			case "file": {
				const targetPath = profile.action.path || "/tmp/pi-do-not-read/";
				const filePath = await redirectToFile(command, targetPath, finalStdout, finalStderr);
				if (filePath) {
					const template = profile.action.message || "[Output redirected to file: {path}]";
					finalStdout = template.replaceAll("{path}", filePath);
					finalStderr = "";
					applied = true;
				}
				break;
			}
		}
	}
	return { stdout: finalStdout, stderr: finalStderr, applied };
}

function stripInlineFlags(pattern: string): string {
	return pattern.replace(/^\(\?i\)/, "");
}

async function redirectToFile(command: string, targetPath: string, stdout: string, stderr: string): Promise<string> {
	const idx = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
	const lastSegment = idx >= 0 ? targetPath.slice(idx + 1) : targetPath;
	const isDir = targetPath.endsWith("/") || targetPath.endsWith("\\") || !lastSegment.includes(".");

	if (isDir) {
		try {
			await mkdir(targetPath, { recursive: true });
		} catch {
			// best effort
		}
		let appName = command.trim().toLowerCase().replaceAll(" ", "-");
		appName = appName.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
		if (appName === "") appName = "output";
		let ext = "txt";
		if (command.includes("diff")) ext = "diff";
		else if (command.includes("status")) ext = "status";
		const filePath = join(targetPath, `${appName}-${timestampName()}.${ext}`);
		return writeProfileFile(filePath, command, stdout, stderr);
	}

	try {
		await mkdir(dirname(targetPath), { recursive: true });
	} catch {
		// best effort
	}
	return writeProfileFile(targetPath, command, stdout, stderr);
}

async function writeProfileFile(filePath: string, command: string, stdout: string, stderr: string): Promise<string> {
	const content = `COMMAND: ${command}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n`;
	try {
		await writeFile(filePath, content, { mode: 0o644 });
		return filePath;
	} catch {
		return "";
	}
}

function timestampName(): string {
	return new Date().toISOString().replace(/:/g, "").slice(0, 17);
}

// ---------------------------------------------------------------------------
// Virtualization (port of CheckAndVirtualizeOutput; virtual_store replaced by
// a temp-file handle since pi has no context.db MCP backend)
// ---------------------------------------------------------------------------

const vocabRe = /[a-z0-9_\-]{3,20}/g;

const stopWords = new Set([
	"function", "const", "return", "import", "string", "number", "public", "export",
	"class", "let", "interface", "false", "true", "null", "undefined", "from", "this",
	"void", "async", "await", "awaiting", "with", "index", "type", "object", "array",
	"boolean", "default", "module", "require", "the", "and", "to", "of", "in", "is",
	"that", "it", "he", "was", "for", "on", "are", "as", "his", "they", "at", "be",
	"have", "or", "one", "had", "by", "word", "but", "not", "what", "all", "were",
	"we", "when", "your", "can", "said", "there", "use", "an", "each", "which", "she",
	"do", "how", "their", "if", "will", "up", "other", "about", "out", "many", "then",
	"them", "these", "so", "some", "her", "would", "make", "like", "him", "into",
	"time", "has", "look", "two", "more", "write", "go", "see",
]);

function extractDistinctVocabulary(text: string): string[] {
	const words = text.toLowerCase().match(vocabRe) ?? [];
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const w of words) {
		if (stopWords.has(w) || seen.has(w)) continue;
		seen.add(w);
		unique.push(w);
		if (unique.length >= 15) break;
	}
	return unique;
}

async function virtualizeOutput(toolName: string, text: string): Promise<string> {
	const byteLength = Buffer.byteLength(text);
	if (byteLength <= VIRTUALIZE_LIMIT) return text;
	if (text.startsWith("[CONTEXT VIRTUALIZED") || text.startsWith("[OUTPUT VIRTUALIZED")) return text;

	const dir = join(tmpdir(), "pi-virtualized");
	const virtId = `virt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const filePath = join(dir, `${virtId}.txt`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, text, { mode: 0o644 });
	} catch {
		return text; // fail open: return the original oversized text
	}

	const distinctTerms = extractDistinctVocabulary(text);
	const lineCount = text.split("\n").length;
	const kbSize = (Math.round((byteLength / 1024) * 100) / 100).toFixed(2);

	return JSON.stringify(
		{
			status: "success",
			summary: `Large output (${kbSize}KB, ${lineCount} lines) from '${toolName}' virtualized to file.`,
			index_handle: virtId,
			full_output_path: filePath,
			vocabulary_preview: distinctTerms,
			line_count: lineCount,
			volume_kb: kbSize,
			action_required: `Read the file at ${filePath} with offset/limit (read tool) when you need specific sections.`,
		},
		null,
		2
	);
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

interface Stats {
	calls: number;
	originalBytes: number;
	optimizedBytes: number;
	virtualized: number;
}

export default function tokenOptimizerExtension(pi: ExtensionAPI) {
	let cfg: OptimizerConfig = { ...DEFAULT_CONFIG };
	let stats: Stats = { calls: 0, originalBytes: 0, optimizedBytes: 0, virtualized: 0 };

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

	async function persistEnabled(enabled: boolean, cwd: string): Promise<void> {
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
		void cwd;
	}

	pi.on("session_start", async (_event, ctx) => {
		await loadConfig(ctx.cwd);
		stats = { calls: 0, originalBytes: 0, optimizedBytes: 0, virtualized: 0 };
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

			// 4. virtualize very large outputs
			if (Buffer.byteLength(optimized) > VIRTUALIZE_LIMIT) {
				optimized = await virtualizeOutput("bash", optimized);
				if (optimized.includes('"index_handle"')) stats.virtualized++;
			}

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
				await persistEnabled(arg === "on", ctx.cwd);
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
					`tokopt: ${cfg.enabled ? "enabled" : "DISABLED"} | ultra=${cfg.ultraCompact} | calls=${stats.calls} | ${origK}KB→${optK}KB (-${pct}%) | virtualized=${stats.virtualized}`,
					"info"
				);
			}
		},
	});
}
