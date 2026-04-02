import moment from 'moment';
import type {AccountsSelector} from './config.js';

export const importMarkerLabel = 'Imported by israeli-banks-sure-importer';
const importIdPrefix = 'Source ID: ';

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

export function stableImportedId(
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
		return value.trim();
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return undefined;
}

export function normalizeLookupKey(value: string) {
	return value.trim().toLocaleLowerCase('en-US');
}

export function extractImportedId(notes: string | undefined) {
	if (!notes?.includes(importMarkerLabel)) {
		return undefined;
	}

	const match = new RegExp(String.raw`^${escapeRegex(importIdPrefix)}(.+)$`, 'm').exec(notes);
	return match?.[1]?.trim();
}

export function buildImportedTransactionNotes({
	accountNumber,
	companyId,
	importedId,
	memo,
	originalAmount,
	originalCurrency,
	processedDate,
	status,
	transactionDate,
	installmentCount,
	installmentNumber,
}: {
	accountNumber: string;
	companyId: string;
	importedId: string;
	installmentCount?: number;
	installmentNumber?: number;
	memo?: string;
	originalAmount?: number;
	originalCurrency?: string;
	processedDate?: string;
	status?: string;
	transactionDate?: string;
}) {
	const sections: string[] = [];
	const normalizedMemo = toStringOrUndefined(memo);
	if (normalizedMemo) {
		sections.push(normalizedMemo);
	}

	const metadataLines = [
		importMarkerLabel,
		`${importIdPrefix}${importedId}`,
		`Source bank: ${companyId}`,
		`Source account: ${accountNumber}`,
	];

	if (status && status !== 'completed') {
		metadataLines.push(`Status: ${status}`);
	}

	if (processedDate && processedDate !== transactionDate) {
		metadataLines.push(`Processed date: ${processedDate}`);
	}

	if (
		installmentNumber !== undefined
		&& installmentCount !== undefined
		&& installmentCount > 0
	) {
		metadataLines.push(`Installment: ${installmentNumber}/${installmentCount}`);
	}

	if (originalAmount !== undefined && originalCurrency) {
		metadataLines.push(`Original amount: ${originalAmount} ${originalCurrency}`);
	}

	sections.push(metadataLines.join('\n'));
	return sections.join('\n\n');
}

export function parseFormattedMoney(value: string | undefined) {
	if (!value) {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}

	const sign = trimmed.includes('-') ? -1 : 1;
	const cleaned = trimmed.replaceAll(/[^\d,.-]/g, '');
	if (cleaned === '' || cleaned === '-' || cleaned === ',' || cleaned === '.') {
		return undefined;
	}

	const lastComma = cleaned.lastIndexOf(',');
	const lastDot = cleaned.lastIndexOf('.');

	let normalized = cleaned;
	if (lastComma !== -1 && lastDot !== -1) {
		const decimalSeparator = lastComma > lastDot ? ',' : '.';
		const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
		normalized = normalized.replaceAll(thousandsSeparator, '').replace(decimalSeparator, '.');
	} else if (lastComma !== -1) {
		normalized = normalizeSingleSeparatorNumber(cleaned, ',');
	} else if (lastDot !== -1) {
		normalized = normalizeSingleSeparatorNumber(cleaned, '.');
	}

	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed * sign : undefined;
}

function normalizeSingleSeparatorNumber(value: string, separator: ',' | '.') {
	const parts = value.split(separator);
	if (parts.length === 2 && parts[1] !== undefined && parts[1].length <= 2) {
		return `${parts[0]}.${parts[1]}`;
	}

	return value.replaceAll(separator, '');
}

function escapeRegex(value: string) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
