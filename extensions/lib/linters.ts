// ruff / jq output compaction.

const ruffLineRe = /^([^:]+):(\d+):(\d+):\s*(.+)/;

export function compactRuff(output: string): string {
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

export function anyString(obj: unknown, keys: string[], fallback: string): string {
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

export function compactJq(output: string): string {
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

export function compactJSONStructure(v: unknown, depth: number): string {
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
