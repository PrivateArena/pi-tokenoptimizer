// Verifies the user-requested removal of output "virtualization": oversized
// bash output must no longer be rewritten into a JSON file-handle that the
// agent cannot see. Chained-command truncation still applies.

import tokenOptimizerExtension from "../extensions/tokenoptimizer.ts";

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function makeBigChainedOutput(): string {
	// 30k UNIQUE lines -> survives dedup, exceeds the 50KB chained cap, and
	// (in the old code) would have exceeded the 24KB virtualize limit.
	return Array.from({ length: 30000 }, (_, i) => `line${i}`).join("\n");
}

Deno.test("virtualization removed: handler returns compacted text, not a JSON handle", async () => {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const pi = {
		on: (event: string, fn: (event: any, ctx: any) => any) => {
			handlers[event] = fn;
		},
		registerCommand: (_name: string, _cfg: unknown) => {},
	} as any;

	await tokenOptimizerExtension(pi);
	await handlers["session_start"]({}, { cwd: "/tmp", ui: { notify() {} } });

	const big = makeBigChainedOutput();
	const res = await handlers["tool_result"](
		{
			toolName: "bash",
			input: { command: "echo a && cat b" },
			content: [{ type: "text", text: big }],
			isError: false,
		},
		{ cwd: "/tmp", ui: { notify() {} } }
	);

	assert(res !== undefined, "handler should return a (non-virtualized) content patch");
	const text = (res.content[0] as any).text as string;
	assert(typeof text === "string", "returned content is a string");
	assert(!text.includes("index_handle"), "output must NOT be virtualized to a JSON handle");
	assert(!text.includes("[CONTEXT VIRTUALIZED"), "no CONTEXT virtualization marker");
	assert(!text.includes("[OUTPUT VIRTUALIZED"), "no OUTPUT virtualization marker");
	assert(text.includes("output truncated"), "chained truncation still applies");
});
