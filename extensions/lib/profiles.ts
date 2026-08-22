// Token profiles: per-command rewrite rules (replace / file) from token-profiles.json.

import type { OptimizerConfig, Options, TokenProfile } from "./types.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface ProfileResult {
	stdout: string;
	stderr: string;
	applied: boolean;
}

export async function applyTokenProfiles(
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

	let profiles: TokenProfile[] | undefined;
	if (Array.isArray(cfg.profiles) && cfg.profiles.length > 0) {
		// Profiles embedded directly in tokenoptimizer.json take precedence.
		profiles = cfg.profiles;
	} else if (cfg.profilesPath) {
		const profilesPath = resolve(cwd, cfg.profilesPath);
		try {
			profiles = JSON.parse(await readFile(profilesPath, "utf8"));
		} catch {
			return { stdout, stderr, applied: false };
		}
	} else {
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
