/* eslint-disable no-await-in-loop */

import type {ConfigBankTarget, ResolvedSureConfig} from './config.js';
import {
	extractImportedId,
	importMarkerLabel,
	normalizeLookupKey,
	parseFormattedMoney,
	stripUndefined,
} from './importer.utils.js';

type SurePagination = {
	page: number;
	per_page: number;
	total_count: number;
	total_pages: number;
};

type SureCollectionResponse<CollectionKey extends string, Item> = Record<CollectionKey, Item[]> & {
	pagination: SurePagination;
};

export type SureAccount = {
	account_type: string;
	balance: string;
	classification: string;
	currency: string;
	id: string;
	name: string;
};

export type SureCategory = {
	color: string;
	created_at: string;
	icon: string;
	id: string;
	name: string;
	parent?: {
		id: string;
		name: string;
	};
	subcategories_count: number;
	updated_at: string;
};

export type SureMerchant = {
	created_at: string;
	id: string;
	name: string;
	type: string;
	updated_at: string;
};

export type SureTag = {
	color: string;
	created_at: string;
	id: string;
	name: string;
	updated_at: string;
};

type SureTransaction = {
	account: {
		account_type: string;
		id: string;
		name: string;
	};
	amount: string;
	amount_cents: number;
	category?: {
		color: string;
		icon: string;
		id: string;
		name: string;
	};
	classification: 'expense' | 'income';
	created_at: string;
	currency: string;
	date: string;
	id: string;
	merchant?: {
		id: string;
		name: string;
	};
	name: string;
	notes?: string;
	signed_amount_cents: number;
	tags: SureTag[];
	updated_at: string;
};

type SureTransactionCreateInput = {
	accountId: string;
	amount: number;
	categoryId?: string;
	currency?: string;
	date: string;
	merchantId?: string;
	name: string;
	nature: 'expense' | 'income';
	notes: string;
	tagIds?: string[];
};

type SureValuationCreateInput = {
	accountId: string;
	amount: number;
	date: string;
	notes: string;
};

type SureSync = {
	completed_at?: string;
	id: string;
	message: string;
	status: string;
	syncable_id: string;
	syncable_type: string;
	syncing_at?: string;
	window_end_date?: string;
	window_start_date?: string;
};

type SureBalanceSettlement = {
	matched: boolean;
	observedBalance?: number;
	triggeredSync: boolean;
};

const balanceTolerance = 0.005;
const reconciliationSettleDelayMs = 2000;
const reconciliationPollIntervalMs = 1000;

export class SureClient {
	readonly defaultTagRefs: string[];
	private accountCache?: SureAccount[];
	private categoryCache?: SureCategory[];
	private merchantCache?: SureMerchant[];
	private tagCache?: SureTag[];

	constructor(private readonly config: ResolvedSureConfig) {
		this.defaultTagRefs = [...config.defaultTags];
	}

	async refreshAccounts() {
		this.accountCache = await this.listPaginatedCollection('/api/v1/accounts', 'accounts');
		return this.accountCache;
	}

	async getAccounts() {
		this.accountCache ??= await this.refreshAccounts();
		return this.accountCache;
	}

	async getAccountById(accountId: string, options?: {refresh?: boolean}) {
		const accounts = options?.refresh ? await this.refreshAccounts() : await this.getAccounts();
		return accounts.find(account => account.id === accountId);
	}

	async resolveAccount(target: ConfigBankTarget, options?: {refresh?: boolean}) {
		const accounts = options?.refresh ? await this.refreshAccounts() : await this.getAccounts();
		if ('sureAccountId' in target) {
			const account = accounts.find(candidate => candidate.id === target.sureAccountId);
			if (!account) {
				throw new Error(`Sure account not found for id ${target.sureAccountId}`);
			}

			return account;
		}

		const wantedName = normalizeLookupKey(target.sureAccountName);
		const matches = accounts.filter(account => normalizeLookupKey(account.name) === wantedName);
		if (matches.length === 0) {
			throw new Error(`Sure account not found for name ${target.sureAccountName}`);
		}

		if (matches.length > 1) {
			throw new Error(`Multiple Sure accounts matched the name ${target.sureAccountName}. Use sureAccountId instead.`);
		}

		return matches[0];
	}

	async getCategories() {
		this.categoryCache ??= await this.listPaginatedCollection('/api/v1/categories', 'categories');
		return this.categoryCache;
	}

	async resolveCategory(reference: string | undefined) {
		if (!reference) {
			return undefined;
		}

		const categories = await this.getCategories();
		return categories.find(category => category.id === reference || normalizeLookupKey(category.name) === normalizeLookupKey(reference));
	}

	async getMerchants() {
		this.merchantCache ??= await this.request<SureMerchant[]>('/api/v1/merchants');
		return this.merchantCache;
	}

	async resolveMerchant(name: string | undefined) {
		if (!name) {
			return undefined;
		}

		const merchants = await this.getMerchants();
		return merchants.find(merchant => normalizeLookupKey(merchant.name) === normalizeLookupKey(name));
	}

	async getTags() {
		this.tagCache ??= await this.request<SureTag[]>('/api/v1/tags');
		return this.tagCache;
	}

	async ensureTags(references: string[]) {
		if (references.length === 0) {
			return [];
		}

		const trimmedReferences = [...new Set(references.map(reference => reference.trim()).filter(Boolean))];
		const resolvedTags: SureTag[] = [];
		for (const reference of trimmedReferences) {
			const existing = await this.findTag(reference);
			if (existing) {
				resolvedTags.push(existing);
				continue;
			}

			if (!this.config.createMissingTags) {
				throw new Error(`Sure tag not found: ${reference}`);
			}

			const created = await this.request<SureTag>('/api/v1/tags', {
				body: JSON.stringify({tag: {name: reference}}),
				method: 'POST',
			});
			this.tagCache = undefined;
			resolvedTags.push(created);
		}

		return resolvedTags;
	}

	async listImportedTransactionIds(accountId: string) {
		const transactions = await this.listPaginatedCollection<SureTransaction>(
			'/api/v1/transactions',
			'transactions',
			Object.fromEntries([
				['account_id', accountId],
				['per_page', '100'],
				['search', importMarkerLabel],
			]),
		);

		return new Set(transactions.map(transaction => extractImportedId(transaction.notes)).filter(Boolean));
	}

	async createTransaction(transaction: SureTransactionCreateInput) {
		const sureTransactionEntries: Array<[string, unknown]> = [
			['account_id', transaction.accountId],
			['amount', transaction.amount],
			['category_id', transaction.categoryId],
			['currency', transaction.currency],
			['date', transaction.date],
			['merchant_id', transaction.merchantId],
			['name', transaction.name],
			['nature', transaction.nature],
			['notes', transaction.notes],
			['tag_ids', transaction.tagIds],
		];
		const sureTransaction = toDefinedRecord(sureTransactionEntries);

		return this.request<SureTransaction>('/api/v1/transactions', {
			body: JSON.stringify({
				transaction: sureTransaction,
			}),
			method: 'POST',
		});
	}

	async createValuation(valuation: SureValuationCreateInput) {
		const sureValuationEntries: Array<[string, unknown]> = [
			['account_id', valuation.accountId],
			['amount', valuation.amount],
			['date', valuation.date],
			['notes', valuation.notes],
		];
		const sureValuation = toDefinedRecord(sureValuationEntries);

		return this.request('/api/v1/valuations', {
			body: JSON.stringify({
				valuation: sureValuation,
			}),
			method: 'POST',
		});
	}

	async settleAccountBalance(accountId: string, expectedBalance: number): Promise<SureBalanceSettlement> {
		const initialBalance = await this.getParsedAccountBalance(accountId, {refresh: true});
		if (matchesBalance(initialBalance, expectedBalance)) {
			return {
				matched: true,
				observedBalance: initialBalance,
				triggeredSync: false,
			};
		}

		await delay(reconciliationSettleDelayMs);
		const settledBalance = await this.getParsedAccountBalance(accountId, {refresh: true});
		if (matchesBalance(settledBalance, expectedBalance)) {
			return {
				matched: true,
				observedBalance: settledBalance,
				triggeredSync: false,
			};
		}

		await this.request<SureSync>('/api/v1/sync', {
			method: 'POST',
		});

		const deadline = Date.now() + Math.max(this.config.timeoutMs, 30_000);
		let observedBalance = settledBalance;
		while (Date.now() <= deadline) {
			await delay(reconciliationPollIntervalMs);
			observedBalance = await this.getParsedAccountBalance(accountId, {refresh: true});
			if (matchesBalance(observedBalance, expectedBalance)) {
				return {
					matched: true,
					observedBalance,
					triggeredSync: true,
				};
			}
		}

		return {
			matched: false,
			observedBalance,
			triggeredSync: true,
		};
	}

	private async getParsedAccountBalance(accountId: string, options?: {refresh?: boolean}) {
		const account = await this.getAccountById(accountId, options);
		return parseFormattedMoney(account?.balance);
	}

	private async findTag(reference: string) {
		const tags = await this.getTags();
		return tags.find(tag => tag.id === reference || normalizeLookupKey(tag.name) === normalizeLookupKey(reference));
	}

	private async listPaginatedCollection<Item>(
		pathname: string,
		collectionKey: string,
		query?: Record<string, string>,
	) {
		const items: Item[] = [];
		let page = 1;

		while (true) {
			const pageResponse = await this.request<SureCollectionResponse<string, Item>>(pathname, {
				query: {
					...query,
					page: String(page),
				},
			});
			const pageItems = pageResponse[collectionKey];
			if (!Array.isArray(pageItems)) {
				throw new TypeError(`Sure API ${pathname} returned an invalid ${collectionKey} collection.`);
			}

			items.push(...pageItems);
			if (page >= pageResponse.pagination.total_pages) {
				break;
			}

			page += 1;
		}

		return items;
	}

	private async request<Response>(
		pathname: string,
		options?: {
			body?: string;
			method?: 'GET' | 'POST';
			query?: Record<string, string | undefined>;
		},
	) {
		const url = new URL(pathname, this.config.baseUrl);
		for (const [key, value] of Object.entries(options?.query ?? {})) {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, value);
			}
		}

		const response = await fetch(url, {
			body: options?.body,
			headers: stripUndefined({
				'Content-Type': options?.body ? 'application/json' : undefined,
				'X-Api-Key': this.config.apiKey,
			}),
			method: options?.method ?? 'GET',
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const text = await response.text();
		const body = text === '' ? undefined : JSON.parse(text) as Record<string, unknown>;
		if (!response.ok) {
			throw new Error(this.buildErrorMessage(pathname, response.status, body));
		}

		return body as Response;
	}

	private buildErrorMessage(pathname: string, status: number, body: Record<string, unknown> | undefined) {
		const candidates = [
			readString(body?.message),
			readString(body?.error),
			readStringArray(body?.errors)?.join(', '),
		].filter(Boolean);

		return `Sure API ${pathname} failed (${status}): ${candidates.join(' | ') || 'Unknown error'}`;
	}
}

function matchesBalance(observedBalance: number | undefined, expectedBalance: number) {
	return observedBalance !== undefined && Math.abs(observedBalance - expectedBalance) < balanceTolerance;
}

async function delay(ms: number) {
	await new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

function readString(value: unknown) {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readStringArray(value: unknown) {
	return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

function toDefinedRecord(entries: Array<[string, unknown]>) {
	const record: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (value !== undefined) {
			record[key] = value;
		}
	}

	return record;
}
