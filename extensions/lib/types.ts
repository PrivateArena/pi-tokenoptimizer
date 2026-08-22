// Shared types & default configuration for the token optimizer.

export interface BlacklistEntry {
	match: string;
	isRegex?: boolean;
	maxLines?: number;
	dropOutput?: boolean;
	label?: string;
}

export interface TokenProfile {
	name: string;
	match: { command: string; type?: string }; // contains | exact | regex
	action: {
		type: string; // replace | file
		find?: string;
		replace?: string;
		is_regex?: boolean;
		flags?: string;
		path?: string;
		message?: string;
	};
}

export interface OptimizerConfig {
	enabled: boolean;
	ultraCompact: boolean;
	maxChainedLength: number;
	deduplicateThreshold: number;
	profilesPath: string;
	profiles?: TokenProfile[]; // optional: embed token profiles directly here
	blacklist: BlacklistEntry[];
}

export const DEFAULT_CONFIG: OptimizerConfig = {
	enabled: true,
	ultraCompact: false,
	maxChainedLength: 50 * 1024,
	deduplicateThreshold: 3,
	profilesPath: "token-profiles.json",
	blacklist: [],
};

export interface Options {
	ultraCompact: boolean;
	exitOk: boolean; // false when the tool result is an error — suppresses "all passed" shortcuts
	skipOptimization: boolean;
}
