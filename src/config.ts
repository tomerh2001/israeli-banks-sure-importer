import process from 'node:process';
import type {CompanyTypes, ScraperCredentials} from '@tomerh2001/israeli-bank-scrapers';

export type AccountsSelector = string[] | 'all';

export type Config = {
	banks: Partial<Record<CompanyTypes, ConfigBank>>;
	sure: ConfigSure;
};

export type ConfigSure = {
	apiKey: string;
	baseUrl: string;
	createMissingTags?: boolean;
	defaultTags?: string[];
	timeoutMs?: number;
};

type ConfigTargetBase = {
	accounts?: AccountsSelector;
	alias?: string;
	categoryMap?: Record<string, string>;
	reconcile?: boolean;
	tags?: string[];
};

export type ConfigBankTarget = (
	| {
		sureAccountId: string;
		sureAccountName?: never;
	}
	| {
		sureAccountId?: never;
		sureAccountName: string;
	}
) & ConfigTargetBase;

export type ConfigBank = ScraperCredentials & {
	alias?: string;
	startDate?: string;
	targets: ConfigBankTarget[];
};

export type ResolvedSureConfig = {
	apiKey: string;
	baseUrl: string;
	createMissingTags: boolean;
	defaultTags: string[];
	timeoutMs: number;
};

export function resolveSureConfig(config: ConfigSure): ResolvedSureConfig {
	return {
		apiKey: process.env.SURE_API_KEY?.trim() ?? config.apiKey,
		baseUrl: normalizeBaseUrl(process.env.SURE_BASE_URL?.trim() ?? config.baseUrl),
		createMissingTags: parseBoolean(process.env.SURE_CREATE_MISSING_TAGS, config.createMissingTags ?? true),
		defaultTags: config.defaultTags ?? [],
		timeoutMs: toNumberOrUndefined(process.env.SURE_TIMEOUT_MS) ?? config.timeoutMs ?? 30_000,
	};
}

function normalizeBaseUrl(value: string) {
	const normalized = value.trim();
	return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
	if (!value) {
		return fallback;
	}

	const normalized = value.toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) {
		return true;
	}

	if (['0', 'false', 'no', 'off'].includes(normalized)) {
		return false;
	}

	return fallback;
}

function toNumberOrUndefined(value: string | undefined) {
	if (!value || value.trim() === '') {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
