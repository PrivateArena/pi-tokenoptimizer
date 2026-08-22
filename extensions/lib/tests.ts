// Test-runner output compaction (go test, go bench, jest, vitest, pytest, cargo).

import type { Options } from "./types.ts";

const benchRe = /^(\S+)-?\d+\s+(\d+)\s+(\d+)\s+ns\/op(?:\s+(\d+)\s+B\/op)?(?:\s+(\d+)\s+allocs\/op)?/;

interface BenchResult {
	name: string;
	ns: number;
	allocs: number;
}

export function compactGoBench(output: string): string {
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

export function formatMicros(v: number): string {
	return (Math.round(v * 10) / 10).toString().replace(/\.0$/, "") + "µs";
}

const goRunRe = /^\s*===[=]+\s+(run|pass|fail)/;
const goTestLineRe = /^\s*---[ -]+\s+(pass|fail|skip)/i;
const goFailRe = /^\s*---[ -]+\s*FAIL/i;

export function compactTestOutput(output: string, command: string, options: Options): string {
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

export function replaceCheckmarks(s: string): string {
	return s.replaceAll("✓", "").replaceAll("✗", "").replaceAll("✕", "");
}
