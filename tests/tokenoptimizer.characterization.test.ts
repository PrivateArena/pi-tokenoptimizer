// Characterization tests pinning the exact observable behavior of the token
// optimizer's public API (optimizeOutput / applyBlacklist / applyTokenProfiles).
// These double as the regression guard after modularization: any drift in
// compaction output breaks a specific assertion here.

import {
	optimizeOutput,
	applyBlacklist,
	applyTokenProfiles,
	DEFAULT_CONFIG,
} from "../extensions/tokenoptimizer.ts";
import type { OptimizerConfig, Options, TokenProfile } from "../extensions/lib/types.ts";

// ---- tiny assertion helpers (no external deps, offline-friendly) ----
function eq(actual: unknown, expected: unknown, msg?: string): void {
	if (actual !== expected) {
		throw new Error(
			`Assertion failed${msg ? `: ${msg}` : ""}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
		);
	}
}
function includes(actual: string, needle: string, msg?: string): void {
	if (!actual.includes(needle)) {
		throw new Error(`Expected to include ${JSON.stringify(needle)}${msg ? `: ${msg}` : ""}\n  actual: ${JSON.stringify(actual)}`);
	}
}
function notIncludes(actual: string, needle: string, msg?: string): void {
	if (actual.includes(needle)) {
		throw new Error(`Expected NOT to include ${JSON.stringify(needle)}${msg ? `: ${msg}` : ""}\n  actual: ${JSON.stringify(actual)}`);
	}
}

function cfg(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
	return { ...DEFAULT_CONFIG, ...over };
}
function opts(over: Partial<Options> = {}): Options {
	return { ultraCompact: false, exitOk: true, skipOptimization: false, ...over };
}

const N = (n: number, s = "x") => Array.from({ length: n }, (_, i) => `${s}${i}`).join("\n");

// ===================== git =====================
Deno.test("git status: modified + untracked sections", () => {
	const r = optimizeOutput("git status", "M  foo.ts\n?? bar.ts", opts(), cfg());
	eq(r, "Modified (1): foo.ts\nUntracked (1): bar.ts", "git status");
});

Deno.test("git status: clean", () => {
	eq(optimizeOutput("git status", "nothing to commit, working tree clean", opts(), cfg()), "✓ Clean");
});

Deno.test("git diff: large diff summarized", () => {
	const out = N(50, "file").split("\n").map((f) => `${f}.ts | 3 +++`).join("\n");
	const r = optimizeOutput("git diff", out, opts(), cfg());
	includes(r, "50 files:", "file count");
	includes(r, "+150/-0", "insertion/deletion tally");
	includes(r, "more files", "overflow indicator");
});

Deno.test("git log: capped to 15 lines", () => {
	const r = optimizeOutput("git log", N(20, "commit"), opts(), cfg());
	eq(r.split("\n").length, 15, "git log line cap");
});

Deno.test("git log ultraCompact: capped to 10 lines", () => {
	const r = optimizeOutput("git log", N(20, "commit"), opts({ ultraCompact: true }), cfg());
	eq(r.split("\n").length, 10, "git log ultra cap");
});

Deno.test("git add: no files", () => {
	eq(optimizeOutput("git add .", "No files to stage", opts(), cfg()), "✓ No files to stage");
});
Deno.test("git add: staged", () => {
	eq(optimizeOutput("git add .", "1 file changed", opts(), cfg()), "✓ Staged");
});
Deno.test("git commit: short sha", () => {
	eq(optimizeOutput("git commit -m x", "a1b2c3d4 message here", opts(), cfg()), "✓ a1b2c3d4");
});
Deno.test("git push: up to date", () => {
	eq(optimizeOutput("git push", "Everything up-to-date", opts(), cfg()), "✓ Up to date");
});
Deno.test("git push: branch name", () => {
	eq(optimizeOutput("git push", "abc1234..def  main -> main", opts(), cfg()), "✓ main");
});
Deno.test("git pull: already up to date", () => {
	eq(optimizeOutput("git pull", "Already up to date", opts(), cfg()), "✓ Up to date");
});

// ===================== fs view =====================
Deno.test("ls: plain names pass through", () => {
	eq(optimizeOutput("ls", "a.txt\nb dir\nc.log", opts(), cfg()), "a.txt\nb dir\nc.log");
});
Deno.test("ls: detailed listing -> names only", () => {
	const out = "total 4\ndrwxr-xr-x 2 u 4096 Jan 1  docs\n-rw-r--r-- 1 u 0 Jan 1  readme.md";
	eq(optimizeOutput("ls -la", out, opts(), cfg()), "4\ndocs/\nreadme.md");
});
Deno.test("ls ultraCompact: last path segment", () => {
	eq(optimizeOutput("ls", "a  b  c", opts({ ultraCompact: true }), cfg()), "c");
});
Deno.test("tree: small tree unchanged", () => {
	const out = ".\n├── a\n└── b";
	eq(optimizeOutput("tree", out, opts(), cfg()), out);
});
Deno.test("tree: large tree truncated to 40 lines", () => {
	const r = optimizeOutput("tree", N(60, "line"), opts(), cfg());
	eq(r.split("\n").length, 41, "tree truncation");
	includes(r, "...");
});
Deno.test("cat: >500 lines truncated", () => {
	const r = optimizeOutput("cat f", "x\n".repeat(600), opts(), cfg());
	includes(r, "+200 more lines", "cat overflow");
	includes(r, "use head/tail/range", "cat hint");
});
Deno.test("cat: <=500 lines unchanged", () => {
	const out = "y\n".repeat(100);
	eq(optimizeOutput("cat f", out, opts(), cfg()), out);
});

// ===================== grep =====================
Deno.test("grep: content mode per-file counts", () => {
	const r = optimizeOutput("grep foo", "a.ts:10:  const x = 1", opts(), cfg());
	eq(r, "a.ts: 1\n  10: const x = 1");
});
Deno.test("grep -l: list mode dedups to file paths", () => {
	const r = optimizeOutput("rg -l foo", "src/a.ts\nsrc/b.ts\nsrc/a.ts", opts(), cfg());
	eq(r, "a.ts\nb.ts");
});
Deno.test("grep ultraCompact list: capped at 10 files", () => {
	const r = optimizeOutput("rg foo", N(20, "f") + ".ts", opts({ ultraCompact: true }), cfg());
	includes(r, "+10 more", "grep ultra file cap");
});

// ===================== test runners =====================
Deno.test("jest: passing -> All tests passed", () => {
	eq(optimizeOutput("jest", "PASS src/a.test.ts\n✓ renders correctly", opts(), cfg()), "✓ All tests passed");
});
Deno.test("jest: failing -> FAILED summary", () => {
	const r = optimizeOutput("jest", "FAIL src/a.test.ts\n✗ breaks", opts(), cfg());
	includes(r, "FAILED: 2 tests");
	includes(r, "FAIL src/a.test.ts");
});
Deno.test("go test: passing -> All tests passed", () => {
	eq(optimizeOutput("go test ./...", "ok   pkg  0.5s", opts(), cfg()), "✓ All tests passed");
});
Deno.test("go test: failing -> FAILED summary", () => {
	const r = optimizeOutput("go test ./...", "--- FAIL: TestX\nFAIL\nexit status 1", opts(), cfg());
	includes(r, "FAILED: 1 test(s)");
	includes(r, "--- FAIL: TestX");
});
Deno.test("pytest: passing -> All tests passed", () => {
	eq(optimizeOutput("pytest", "==== 5 passed in 0.1s ====", opts(), cfg()), "✓ All tests passed");
});
Deno.test("pytest: failing -> FAILED summary with test name", () => {
	const r = optimizeOutput("pytest", "==== 1 failed ====\ntests/test_x.py::test_y FAILED", opts(), cfg());
	includes(r, "FAILED: 1 tests");
	includes(r, "tests/test_x.py::test_y");
});

// ===================== linters =====================
Deno.test("ruff: empty -> no issues", () => {
	eq(optimizeOutput("ruff check .", "", opts(), cfg()), "✓ No issues found");
});
Deno.test("ruff: line output summarized", () => {
	const out = "file.py:1:1: E501 line too long\nsrc/file.py:2:5: F401 unused import";
	const r = optimizeOutput("ruff check .", out, opts(), cfg());
	includes(r, "Found 2 issues");
	includes(r, "file.py: 2");
	includes(r, "E501");
});
Deno.test("ruff: JSON output summarized by rule", () => {
	const r = optimizeOutput("ruff check .", '[{"filename":"a.py","code":"E501","message":"x"}]', opts(), cfg());
	includes(r, "Found 1 issues");
	includes(r, "E501: 1");
});
Deno.test("jq: small JSON compacted", () => {
	eq(optimizeOutput("jq .", '{"a":1,"b":2,"c":3}', opts(), cfg()), "{ a: 1, b: 2, c: 3 }");
});
Deno.test("jq: many lines truncated", () => {
	const r = optimizeOutput("jq .", N(51, "line"), opts(), cfg());
	includes(r, "+41 more lines", "jq overflow");
});

// ===================== chained + global fallback =====================
Deno.test("chained: duplicate lines collapsed with count", () => {
	eq(optimizeOutput("echo a && echo b", "a\na\na\na\nb\nb", opts(), cfg()), "a (×4)\nb");
});
Deno.test("chained: oversized unique output truncated with marker", () => {
	const r = optimizeOutput("echo a && cat b", N(30000, "line"), opts(), cfg());
	includes(r, "output truncated", "chained truncation");
	includes(r, "50KB", "truncation target size");
	notIncludes(r, "line29999", "tail removed by truncation");
});
Deno.test("global fallback: blank runs collapsed to one", () => {
	eq(optimizeOutput("foobar", "x\n\n\n\ny", opts(), cfg()), "x\n\ny");
});
Deno.test("global fallback: long line whitespace collapsed", () => {
	const longLine = "word ".repeat(60);
	const r = optimizeOutput("foobar", longLine, opts(), cfg());
	notIncludes(r, "  ", "no double spaces in long line");
});

// ===================== pass-through commands =====================
for (const cmd of ["npm run build", "yarn build", "pnpm build", "bun run x", "cargo build", "python script.py", "go build"]) {
	Deno.test(`pass-through: ${cmd} untouched`, () => {
		const out = "lots of output here that should be untouched";
		eq(optimizeOutput(cmd, out, opts(), cfg()), out);
	});
}

// ===================== blacklist =====================
Deno.test("blacklist: empty -> null", () => {
	eq(applyBlacklist("ls", "x", []), null);
});
Deno.test("blacklist: dropOutput suppresses", () => {
	eq(applyBlacklist("cat secret.txt", "data", [{ match: "secret", dropOutput: true }]), "[output suppressed — blacklisted command: secret]");
});
Deno.test("blacklist: maxLines truncates", () => {
	const r = applyBlacklist("terraform plan", "L\n".repeat(50), [{ match: "terraform plan", isRegex: false, maxLines: 30 }]);
	includes(r ?? "", "truncated by blacklist rule");
	includes(r ?? "", "51 → 30 lines");
});
Deno.test("blacklist: regex match", () => {
	const r = applyBlacklist("rm -rf /", "L\n".repeat(10), [{ match: "^rm ", isRegex: true, maxLines: 5 }]);
	includes(r ?? "", "truncated by blacklist rule");
});

// ===================== token profiles =====================
async function withProfiles(profiles: TokenProfile[], command = "echo hi", stdout = "hi there"): Promise<string> {
	const tmp = await Deno.makeTempFile();
	await Deno.writeTextFile(tmp, JSON.stringify(profiles));
	const res = await applyTokenProfiles(
		command,
		stdout,
		"",
		opts(),
		{ ...DEFAULT_CONFIG, profilesPath: tmp },
		"/tmp"
	);
	await Deno.remove(tmp).catch(() => {});
	return JSON.stringify(res);
}

Deno.test("profiles: literal replace applied", async () => {
	const r = await withProfiles([{ name: "r", match: { command: "echo hi", type: "contains" }, action: { type: "replace", find: "hi", replace: "bye" } }]);
	includes(r, '"applied":true');
	includes(r, "bye there");
});
Deno.test("profiles: regex replace applied", async () => {
	const r = await withProfiles([{ name: "r", match: { command: "log", type: "contains" }, action: { type: "replace", is_regex: true, find: "\\d+", replace: "N" } }], "git log", "abc123def");
	includes(r, '"applied":true');
	includes(r, "abcNdef");
});
Deno.test("profiles: file action redirects stdout", async () => {
	const r = await withProfiles([{ name: "f", match: { command: "bigdump", type: "contains" }, action: { type: "file", path: "/tmp/pi-do-not-read/", message: "[Output redirected to file: {path}]" } }], "bigdump", "somedata");
	includes(r, '"applied":true');
	includes(r, "[Output redirected to file:");
	includes(r, "/tmp/pi-do-not-read/");
});
Deno.test("profiles: delegate is a no-op (not applied)", async () => {
	const r = await withProfiles([{ name: "d", match: { command: "x", type: "contains" }, action: { type: "delegate" } }], "echo x", "hi there");
	includes(r, '"applied":false');
	includes(r, "hi there");
});
Deno.test("profiles: embedded in config (no separate file)", async () => {
	const profiles: TokenProfile[] = [{ name: "r", match: { command: "echo hi", type: "contains" }, action: { type: "replace", find: "hi", replace: "bye" } }];
	const res = await applyTokenProfiles("echo hi", "hi there", "", opts(), { ...DEFAULT_CONFIG, profiles }, "/tmp");
	includes(JSON.stringify(res), '"applied":true');
	includes(JSON.stringify(res), "bye there");
});
Deno.test("profiles: embedded takes precedence over profilesPath file", async () => {
	const tmp = await Deno.makeTempFile();
	await Deno.writeTextFile(tmp, JSON.stringify([{ name: "f", match: { command: "zzz", type: "contains" }, action: { type: "replace", find: "hi", replace: "NOPE" } }]));
	const profiles: TokenProfile[] = [{ name: "r", match: { command: "echo hi", type: "contains" }, action: { type: "replace", find: "hi", replace: "bye" } }];
	const res = await applyTokenProfiles("echo hi", "hi there", "", opts(), { ...DEFAULT_CONFIG, profilesPath: tmp, profiles }, "/tmp");
	await Deno.remove(tmp).catch(() => {});
	includes(JSON.stringify(res), '"applied":true');
	includes(JSON.stringify(res), "bye there");
});
