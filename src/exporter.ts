/* eslint-disable no-await-in-loop */

import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
	createScraper,
	type CompanyTypes,
	type ScraperCredentials,
} from '@tomerh2001/israeli-bank-scrapers';
import moment from 'moment';
import Papa from 'papaparse';
import type {ConfigBank, ResolvedOutputConfig} from './config.js';
import {
	normalizeDate,
	sanitizePathSegment,
	selectScraperAccounts,
	stableRecordId,
	stripUndefined,
	toNumberOrUndefined,
	toStringOrUndefined,
} from './exporter.utils.js';

type ScrapeAndExportContext = {
	companyId: CompanyTypes;
	bank: ConfigBank;
	output: ResolvedOutputConfig;
};

type ExportedTransaction = {
	id: string;
	sourceId?: string;
	date?: string;
	processedDate?: string;
	description?: string;
	memo?: string;
	status?: string;
	type?: string;
	chargedAmount?: number;
	originalAmount?: number;
	currency?: string;
	installmentNumber?: number;
	installmentCount?: number;
	category?: string;
};

type ExportedAccountFile = {
	exporter: {
		name: 'israeli-banks-sure-importer';
		exportedAt: string;
		source: '@tomerh2001/israeli-bank-scrapers';
		companyId: CompanyTypes;
	};
	account: Record<string, unknown>;
	transactions: ExportedTransaction[];
};

export type BankExportSummary = {
	companyId: CompanyTypes;
	alias?: string;
	exportedAccounts: Array<{
		accountNumber: string;
		transactionCount: number;
		balance?: number;
		files: string[];
	}>;
	error?: string;
};

const csvFields: Array<keyof ExportedTransaction> = [
	'id',
	'sourceId',
	'date',
	'processedDate',
	'description',
	'memo',
	'status',
	'type',
	'chargedAmount',
	'originalAmount',
	'currency',
	'installmentNumber',
	'installmentCount',
	'category',
];

export async function scrapeAndExportTransactions({
	companyId,
	bank,
	output,
}: ScrapeAndExportContext): Promise<BankExportSummary> {
	const timeoutMinutes = toNumberOrUndefined(process.env.TIMEOUT) ?? 15;
	const companyDirectory = path.join(output.directory, sanitizePathSegment(bank.alias ?? companyId));
	await mkdir(companyDirectory, {recursive: true});

	const scraper = createScraper({
		companyId,
		startDate: moment().subtract(2, 'years').toDate(),
		timeout: moment.duration(timeoutMinutes, 'minutes').asMilliseconds(),
		args: ['--user-data-dir=./chrome-data'],
		additionalTransactionInformation: true,
		verbose: process.env.VERBOSE === 'true',
		showBrowser: process.env.SHOW_BROWSER === 'true',
	});

	scraper.onProgress((_companyId, payload) => {
		log(companyId, payload.type);
	});

	const result = await scraper.scrape(bank as ScraperCredentials);
	if (!result.success) {
		throw new Error(`Failed to scrape (${result.errorType}): ${result.errorMessage}`);
	}

	const selectedAccounts = selectScraperAccounts(
		result.accounts as unknown as Array<Record<string, unknown>>,
		bank.accounts,
	);
	log(companyId, 'ACCOUNTS_SELECTED', {
		selectedAccounts: selectedAccounts.map(account => account.accountNumber),
	});

	const exportedAccounts: BankExportSummary['exportedAccounts'] = [];
	for (const account of selectedAccounts) {
		const accountNumber = toStringOrUndefined(account.accountNumber) ?? 'unknown';
		const accountFile = buildAccountExport(companyId, accountNumber, account);
		const basePath = path.join(companyDirectory, sanitizePathSegment(accountNumber));
		const files = await writeAccountFiles(basePath, accountFile, output);

		exportedAccounts.push(stripUndefined({
			accountNumber,
			transactionCount: accountFile.transactions.length,
			balance: toNumberOrUndefined(account.balance),
			files,
		}));
	}

	return stripUndefined({
		companyId,
		alias: bank.alias,
		exportedAccounts,
	});
}

function buildAccountExport(
	companyId: CompanyTypes,
	accountNumber: string,
	account: Record<string, unknown>,
): ExportedAccountFile {
	const transactions = Array.isArray(account.txns)
		? account.txns.map(transaction =>
			normalizeTransaction(companyId, accountNumber, transaction as Record<string, unknown>))
		: [];

	return {
		exporter: {
			name: 'israeli-banks-sure-importer',
			exportedAt: new Date().toISOString(),
			source: '@tomerh2001/israeli-bank-scrapers',
			companyId,
		},
		account: stripUndefined({
			accountNumber,
			name: toStringOrUndefined(account.name),
			type: toStringOrUndefined(account.type),
			balance: toNumberOrUndefined(account.balance),
			currency: toStringOrUndefined(account.currency),
			branchNumber: toStringOrUndefined(account.branchNumber),
		}),
		transactions,
	};
}

function normalizeTransaction(
	companyId: CompanyTypes,
	accountNumber: string,
	transaction: Record<string, unknown>,
): ExportedTransaction {
	const installments = transaction.installments as Record<string, unknown> | undefined;

	return stripUndefined({
		id: stableRecordId(companyId, accountNumber, transaction),
		sourceId: toStringOrUndefined(transaction.identifier),
		date: normalizeDate(transaction.date),
		processedDate: normalizeDate(transaction.processedDate),
		description: toStringOrUndefined(transaction.description),
		memo: toStringOrUndefined(transaction.memo),
		status: toStringOrUndefined(transaction.status),
		type: toStringOrUndefined(transaction.type),
		chargedAmount: toNumberOrUndefined(transaction.chargedAmount),
		originalAmount: toNumberOrUndefined(transaction.originalAmount),
		currency: toStringOrUndefined(transaction.currency)
			?? toStringOrUndefined(transaction.originalCurrency)
			?? toStringOrUndefined(transaction.chargedCurrency),
		installmentNumber: toNumberOrUndefined(transaction.installmentNumber)
			?? toNumberOrUndefined(installments?.number),
		installmentCount: toNumberOrUndefined(transaction.installmentCount)
			?? toNumberOrUndefined(installments?.total),
		category: toStringOrUndefined(transaction.category),
	});
}

async function writeAccountFiles(
	basePath: string,
	accountFile: ExportedAccountFile,
	output: ResolvedOutputConfig,
) {
	const files: string[] = [];

	if (output.format === 'json' || output.format === 'json-and-csv') {
		const jsonPath = `${basePath}.json`;
		const indentation = output.pretty ? 2 : undefined;
		await writeFile(jsonPath, `${JSON.stringify(accountFile, null, indentation)}\n`);
		files.push(jsonPath);
	}

	if (output.format === 'csv' || output.format === 'json-and-csv') {
		const csvPath = `${basePath}.csv`;
		const csv = Papa.unparse({
			fields: csvFields,
			data: accountFile.transactions.map(transaction => Object.fromEntries(csvFields.map(field => [field, transaction[field] ?? '']))),
		});
		await writeFile(csvPath, `${csv}\n`);
		files.push(csvPath);
	}

	return files;
}

function log(companyId: CompanyTypes, status: string, details?: Record<string, unknown>) {
	console.debug({
		datetime: new Date().toISOString(),
		companyId,
		status,
		...details,
	});
}
