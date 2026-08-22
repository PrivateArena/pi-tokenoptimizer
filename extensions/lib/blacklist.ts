// Output blacklist: cap or suppress matched commands.

import type { BlacklistEntry } from "./types.ts";

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
