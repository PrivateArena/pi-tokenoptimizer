// grep / rg / ag output compaction.

import type { Options } from "./types.ts";

const fileColonRe = /^([^:]+):/;
const grepLineRe = /^([^:]+):(\d+):?(.*)$/;

export function compactGrep(output: string, options: Options): string {
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
