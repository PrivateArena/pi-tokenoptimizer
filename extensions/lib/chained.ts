// Chained-command optimization & global fallback.

import type { OptimizerConfig } from "./types.ts";

export function optimizeChainedCommand(output: string, cfg: OptimizerConfig): string {
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

export function collapseNewlines(s: string): string {
	return s.replace(/\n{3,}/g, "\n\n");
}

export function deduplicateWithThreshold(text: string, minCount: number): string {
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

export function safeGlobalOptimize(output: string): string {
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
