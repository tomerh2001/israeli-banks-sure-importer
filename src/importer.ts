/* eslint-disable no-await-in-loop */

import process from 'node:process';
import {
	createScraper,
	type CompanyTypes,
	type ScraperCredentials,
} from '@tomerh2001/israeli-bank-scrapers';
import type {Transaction, TransactionsAccount} from '@tomerh2001/israeli-bank-scrapers/lib/transactions';
import moment from 'moment';
import type {ConfigBank, ConfigBankTarget} from './config.js';
import {
	buildImportedTransactionNotes,
	normalizeCurrencyCode,
	normalizeDate,
	parseFormattedMoney,
	selectScraperAccounts,
	stableImportedId,
	toNumberOrUndefined,
	toStringOrUndefined,
} from './importer.utils.js';
import type {SureAccount, SureClient} from './sure-client.js';

type ScrapeAndImportContext = {
	bank: ConfigBank;
	companyId: CompanyTypes;
	sure: SureClient;
};

type NormalizedScrapedTransaction = {
	amount: number;
	category?: string;
	currency?: string;
	date: string;
	importedId: string;
	name: string;
	nature: 'expense' | 'income';
	notes: string;
};

export type TargetImportSummary = {
	importedTransactions: number;
	reconcileAttempted: boolean;
	reconciled: boolean;
	reconciliationMessage?: string;
	selectedAccounts: string[];
	skippedTransactions: number;
	sureAccountId: string;
	sureAccountName: string;
};

export type BankImportSummary = {
	alias?: string;
	companyId: CompanyTypes;
	error?: string;
	targets: TargetImportSummary[];
};

export async function scrapeAndImportTransactions({
	companyId,
	bank,
	sure,
}: ScrapeAndImportContext): Promise<BankImportSummary> {
	if (bank.targets.length === 0) {
		throw new Error(`No Sure targets configured for ${companyId}.`);
	}

	const timeoutMinutes = toNumberOrUndefined(process.env.TIMEOUT) ?? 15;
	const startDate = resolveStartDate(bank.startDate);
	const scraper = createScraper({
		additionalTransactionInformation: true,
		args: ['--user-data-dir=./chrome-data'],
		companyId,
		showBrowser: process.env.SHOW_BROWSER === 'true',
		startDate,
		timeout: moment.duration(timeoutMinutes, 'minutes').asMilliseconds(),
		verbose: process.env.VERBOSE === 'true',
	});

	scraper.onProgress((_companyId, payload) => {
		log(companyId, payload.type);
	});

	const {
		alias: _alias,
		startDate: _startDate,
		targets: _targets,
		...credentials
	} = bank;
	const result = await scraper.scrape(credentials as ScraperCredentials);
	if (!result.success) {
		throw new Error(`Failed to scrape (${result.errorType}): ${result.errorMessage}`);
	}

	const allAccounts = result.accounts ?? [];
	const summaries: TargetImportSummary[] = [];
	for (const target of bank.targets) {
		summaries.push(await importTarget({
			allAccounts,
			bank,
			companyId,
			sure,
			target,
		}));
	}

	return {
		alias: bank.alias,
		companyId,
		targets: summaries,
	};
}

async function importTarget({
	allAccounts,
	bank,
	companyId,
	sure,
	target,
}: {
	allAccounts: TransactionsAccount[];
	bank: ConfigBank;
	companyId: CompanyTypes;
	sure: SureClient;
	target: ConfigBankTarget;
}): Promise<TargetImportSummary> {
	const sureAccount = await sure.resolveAccount(target);
	const selectedAccounts = selectScraperAccounts(allAccounts, target.accounts);
	const selectedAccountNumbers = selectedAccounts.map(account => toStringOrUndefined(account.accountNumber) ?? 'unknown');
	const existingImportedIds = await sure.listImportedTransactionIds(sureAccount.id);
	const sureTags = await sure.ensureTags([...sure.defaultTagRefs, ...(target.tags ?? [])]);
	const tagIds = sureTags.map(tag => tag.id);

	let importedTransactions = 0;
	let skippedTransactions = 0;

	for (const account of selectedAccounts) {
		const accountNumber = toStringOrUndefined(account.accountNumber) ?? 'unknown';
		const accountCurrency = toStringOrUndefined(account.currency);
		const transactions = Array.isArray(account.txns) ? account.txns : [];

		for (const transaction of transactions) {
			const normalizedTransaction = buildSureTransaction({
				accountCurrency,
				accountNumber,
				bankAlias: bank.alias,
				companyId,
				transaction,
			});
			if (!normalizedTransaction) {
				skippedTransactions += 1;
				continue;
			}

			if (existingImportedIds.has(normalizedTransaction.importedId)) {
				skippedTransactions += 1;
				continue;
			}

			const categoryReference = getCategoryReference(target, normalizedTransaction.category);
			const category = await sure.resolveCategory(categoryReference);
			const merchant = await sure.resolveMerchant(normalizedTransaction.name);

			await sure.createTransaction({
				accountId: sureAccount.id,
				amount: normalizedTransaction.amount,
				categoryId: category?.id,
				currency: normalizedTransaction.currency ?? sureAccount.currency,
				date: normalizedTransaction.date,
				merchantId: merchant?.id,
				name: normalizedTransaction.name,
				nature: normalizedTransaction.nature,
				notes: normalizedTransaction.notes,
				tagIds: tagIds.length > 0 ? tagIds : undefined,
			});

			existingImportedIds.add(normalizedTransaction.importedId);
			importedTransactions += 1;
		}
	}

	const reconciliationResult = target.reconcile
		? await reconcileTarget({selectedAccounts, sure, sureAccount})
		: {
			message: 'Reconciliation disabled',
			reconciled: false,
		};

	return {
		importedTransactions,
		reconcileAttempted: Boolean(target.reconcile),
		reconciled: reconciliationResult.reconciled,
		reconciliationMessage: reconciliationResult.message,
		selectedAccounts: selectedAccountNumbers,
		skippedTransactions,
		sureAccountId: sureAccount.id,
		sureAccountName: sureAccount.name,
	};
}

function buildSureTransaction({
	accountCurrency,
	accountNumber,
	bankAlias,
	companyId,
	transaction,
}: {
	accountCurrency?: string;
	accountNumber: string;
	bankAlias?: string;
	companyId: CompanyTypes;
	transaction: Transaction;
}): NormalizedScrapedTransaction | undefined {
	const chargedAmount = toNumberOrUndefined(transaction.chargedAmount);
	const date = normalizeDate(transaction.date);
	const name = toStringOrUndefined(transaction.description);
	const status = toStringOrUndefined(transaction.status);

	if (status?.toLowerCase() === 'pending') {
		log(companyId, 'TRANSACTION_SKIPPED_PENDING', {
			accountNumber,
			description: transaction.description,
		});
		return undefined;
	}

	if (chargedAmount === undefined || date === undefined || name === undefined) {
		log(companyId, 'TRANSACTION_SKIPPED_INVALID', {
			accountNumber,
			description: transaction.description,
		});
		return undefined;
	}

	const importedId = stableImportedId(companyId, accountNumber, transaction);
	const processedDate = normalizeDate(transaction.processedDate);
	const originalAmount = toNumberOrUndefined(transaction.originalAmount);
	const originalCurrency = toStringOrUndefined(transaction.originalCurrency);
	const chargedCurrency = toStringOrUndefined(transaction.chargedCurrency);
	const installmentNumber = toNumberOrUndefined(transaction.installments?.number);
	const installmentCount = toNumberOrUndefined(transaction.installments?.total);

	const notes = buildImportedTransactionNotes({
		accountNumber,
		companyId: bankAlias ?? companyId,
		importedId,
		installmentCount,
		installmentNumber,
		memo: toStringOrUndefined(transaction.memo),
		originalAmount,
		originalCurrency,
		processedDate,
		status,
		transactionDate: date,
	});

	return {
		amount: Math.abs(chargedAmount),
		category: toStringOrUndefined(transaction.category),
		currency: normalizeCurrencyCode(chargedCurrency)
			?? normalizeCurrencyCode(originalCurrency)
			?? normalizeCurrencyCode(accountCurrency),
		date,
		importedId,
		name,
		nature: chargedAmount < 0 ? 'expense' : 'income',
		notes,
	};
}

function getCategoryReference(target: ConfigBankTarget, category: string | undefined) {
	if (!category) {
		return undefined;
	}

	return target.categoryMap?.[category] ?? category;
}

async function reconcileTarget({
	selectedAccounts,
	sure,
	sureAccount,
}: {
	selectedAccounts: TransactionsAccount[];
	sure: SureClient;
	sureAccount: SureAccount;
}) {
	const scrapedBalances = selectedAccounts
		.map(account => toNumberOrUndefined(account.balance))
		.filter((balance): balance is number => balance !== undefined);

	if (scrapedBalances.length === 0) {
		return {
			message: 'Skipped reconciliation because no scraped balances were available.',
			reconciled: false,
		};
	}

	const scrapedBalance = scrapedBalances.reduce((sum, balance) => sum + balance, 0);
	const freshSureAccount = await sure.getAccountById(sureAccount.id, {refresh: true});
	if (!freshSureAccount) {
		return {
			message: `Skipped reconciliation because Sure account ${sureAccount.id} could not be refreshed.`,
			reconciled: false,
		};
	}

	const sureBalance = parseFormattedMoney(freshSureAccount.balance);
	if (sureBalance === undefined) {
		return {
			message: `Skipped reconciliation because Sure balance ${freshSureAccount.balance} could not be parsed.`,
			reconciled: false,
		};
	}

	if (Math.abs(scrapedBalance - sureBalance) < 0.005) {
		return {
			message: 'No reconciliation needed because Sure already matches the scraped balance.',
			reconciled: false,
		};
	}

	await sure.createValuation({
		accountId: sureAccount.id,
		amount: scrapedBalance,
		date: moment().format('YYYY-MM-DD'),
		notes: `Reconciled by israeli-banks-sure-importer from ${sureBalance} to ${scrapedBalance}`,
	});

	const settledBalance = await sure.settleAccountBalance(sureAccount.id, scrapedBalance);
	if (!settledBalance.matched) {
		const observedBalance = settledBalance.observedBalance ?? 'an unknown balance';
		return {
			message: `Created a Sure reconciliation from ${sureBalance} to ${scrapedBalance}, but Sure still reports ${observedBalance} after the follow-up sync.`,
			reconciled: true,
		};
	}

	return {
		message: settledBalance.triggeredSync
			? `Reconciled Sure balance from ${sureBalance} to ${scrapedBalance} and confirmed it after a follow-up Sure sync.`
			: `Reconciled Sure balance from ${sureBalance} to ${scrapedBalance}.`,
		reconciled: true,
	};
}

function resolveStartDate(value: string | undefined) {
	if (!value) {
		return moment().subtract(2, 'years').toDate();
	}

	const parsed = moment(value, moment.ISO_8601, true);
	if (!parsed.isValid()) {
		throw new Error(`Invalid bank.startDate: ${value}`);
	}

	return parsed.toDate();
}

function log(companyId: CompanyTypes, status: string, details?: Record<string, unknown>) {
	console.debug({
		companyId,
		datetime: new Date().toISOString(),
		status,
		...details,
	});
}
