// ls / tree / cat output compaction.

import type { Options } from "./types.ts";

export function compactLs(output: string, options: Options): string {
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

export function compactTree(output: string, options: Options): string {
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

export function compactCat(output: string, options: Options): string {
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
