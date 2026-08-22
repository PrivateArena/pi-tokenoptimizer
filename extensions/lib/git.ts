// git output compaction (status / diff / log / add / commit / push / pull).

import type { Options } from "./types.ts";

export function compactGitStatus(output: string): string {
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

export function compactGitDiff(output: string): string {
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

export function compactGitLog(output: string, options: Options): string {
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

export function compactGitAdd(output: string): string {
	if (output.includes("No files")) return "✓ No files to stage";
	return "✓ Staged";
}

export function compactGitCommit(output: string): string {
	const m = /^(\S{7,})/.exec(output);
	if (m) return "✓ " + m[1].slice(0, 8);
	return "✓ Committed";
}

export function compactGitPush(output: string): string {
	if (output.includes("Everything up-to-date")) return "✓ Up to date";
	const m = /(\S+)\s*->\s*(\S+)/.exec(output);
	if (m) return "✓ " + m[2];
	return "✓ Pushed";
}

export function compactGitPull(output: string): string {
	if (output.includes("Already up to date")) return "✓ Up to date";
	const lines = output.trim().split("\n");
	return lines.slice(0, 5).join("\n");
}
