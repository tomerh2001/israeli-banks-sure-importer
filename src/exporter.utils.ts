import path from 'node:path';
import process from 'node:process';
import moment from 'moment';
import type {
	AccountsSelector,
	ConfigOutput,
	OutputFormat,
	ResolvedOutputConfig,
} from './config.js';

export function stripUndefined<T extends Record<string, unknown>>(object: T): T {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

export function selectScraperAccounts<T extends {accountNumber?: string | number}>(
	allAccounts: T[] | undefined,
	selector: AccountsSelector | undefined,
): T[] {
	const accounts = allAccounts ?? [];
	if (selector === undefined || selector === 'all') {
		return accounts;
	}

	const wantedAccounts = new Set(selector.map(String));
	return accounts.filter(account => wantedAccounts.has(String(account.accountNumber)));
}

export function stableRecordId(
	companyId: string,
	accountNumber: string | undefined,
	transaction: {
		identifier?: unknown;
		date?: unknown;
		chargedAmount?: unknown;
		description?: unknown;
		memo?: unknown;
	},
) {
	const explicitIdentifier = toStringOrUndefined(transaction.identifier);
	const fallbackIdentifier = [
		normalizeDate(transaction.date) ?? 'unknown-date',
		toStringOrUndefined(transaction.chargedAmount) ?? 'unknown-amount',
		toStringOrUndefined(transaction.description) ?? '',
		toStringOrUndefined(transaction.memo) ?? '',
	].join(':');

	return `${companyId}:${accountNumber ?? 'unknown'}:${explicitIdentifier ?? fallbackIdentifier}`;
}

export function sanitizePathSegment(value: string) {
	const cleaned = value
		.trim()
		.replaceAll(/[^\w.-]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');

	return cleaned || 'unknown';
}

export function normalizeDate(value: unknown) {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}

	const date = moment(value);
	return date.isValid() ? date.format('YYYY-MM-DD') : undefined;
}

export function toNumberOrUndefined(value: unknown) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

export function toStringOrUndefined(value: unknown) {
	if (typeof value === 'string' && value.trim() !== '') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return undefined;
}

export function resolveOutputConfig(output: ConfigOutput): ResolvedOutputConfig {
	const directory = process.env.OUTPUT_DIRECTORY?.trim() ?? output.directory;
	const format = normalizeOutputFormat(process.env.OUTPUT_FORMAT?.trim() ?? output.format);
	const pretty = parseBoolean(process.env.OUTPUT_PRETTY, output.pretty ?? true);

	return {
		directory: path.resolve(directory),
		format,
		pretty,
	};
}

function normalizeOutputFormat(format: string | undefined): OutputFormat {
	switch (format) {
		case 'csv': {
			return format;
		}

		case 'json-and-csv': {
			return format;
		}

		case 'json':
		case undefined:
		case '': {
			return 'json';
		}

		default: {
			return 'json';
		}
	}
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
