import type {CompanyTypes, ScraperCredentials} from '@tomerh2001/israeli-bank-scrapers';

export type AccountsSelector = string[] | 'all';
export type OutputFormat = 'json' | 'csv' | 'json-and-csv';

export type Config = {
	banks: Partial<Record<CompanyTypes, ConfigBank>>;
	output: ConfigOutput;
};

export type ConfigBank = ScraperCredentials & {
	accounts?: AccountsSelector;
	alias?: string;
};

export type ConfigOutput = {
	directory: string;
	format?: OutputFormat;
	pretty?: boolean;
};

export type ResolvedOutputConfig = {
	directory: string;
	format: OutputFormat;
	pretty: boolean;
};
