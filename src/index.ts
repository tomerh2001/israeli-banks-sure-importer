/* eslint-disable no-await-in-loop */
/* eslint-disable unicorn/no-process-exit */

import process from 'node:process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {type CompanyTypes} from '@tomerh2001/israeli-bank-scrapers';
import moment from 'moment';
import cron, {type ScheduledTask, validate} from 'node-cron';
import cronstrue from 'cronstrue';
import {resolveSureConfig, type Config, type ConfigBank} from './config.js';
import {type BankImportSummary, scrapeAndImportTransactions} from './importer.js';
import {SureClient} from './sure-client.js';

let scheduledTask: ScheduledTask | undefined;

async function run() {
	const typedConfig = await loadConfig();
	const sure = new SureClient(resolveSureConfig(typedConfig.sure));

	const bankEntries = Object.entries(typedConfig.banks) as Array<[CompanyTypes, ConfigBank]>;
	if (bankEntries.length === 0) {
		throw new Error('No banks configured. Add at least one bank entry to config.json.');
	}

	const summaries: BankImportSummary[] = [];
	let hadErrors = false;
	for (const [companyId, bank] of bankEntries) {
		try {
			summaries.push(await scrapeAndImportTransactions({companyId, bank, sure}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Error importing bank data:', companyId, message);
			summaries.push({
				alias: bank.alias,
				companyId,
				error: message,
				targets: [],
			});
			hadErrors = true;
		}
	}

	const importedTransactions = summaries.reduce(
		(count: number, summary: BankImportSummary) =>
			count + summary.targets.reduce((sum, target) => sum + target.importedTransactions, 0),
		0,
	);
	const skippedTransactions = summaries.reduce(
		(count: number, summary: BankImportSummary) =>
			count + summary.targets.reduce((sum, target) => sum + target.skippedTransactions, 0),
		0,
	);
	const reconciliations = summaries.reduce(
		(count: number, summary: BankImportSummary) =>
			count + summary.targets.filter(target => target.reconciled).length,
		0,
	);

	console.log(`Done. Imported ${importedTransactions} transaction(s), skipped ${skippedTransactions}, created ${reconciliations} valuation reconciliation(s).`);
	if (hadErrors) {
		process.exitCode = 1;
	}
}

async function safeRun() {
	try {
		await run();
	} catch (error) {
		console.error('Error running importer:', error);
	} finally {
		if (scheduledTask) {
			printNextRunTime();
		}
	}
}

function printNextRunTime() {
	if (!scheduledTask) {
		return;
	}

	const nextRun = scheduledTask.getNextRun();
	console.log('Next run:', moment(nextRun).fromNow(), 'at', moment(nextRun).format('YYYY-MM-DD HH:mm:ss'));
}

async function loadConfig() {
	const configPath = path.resolve(process.env.CONFIG_PATH ?? 'config.json');
	const rawConfig = await readFile(configPath, 'utf8');
	return JSON.parse(rawConfig) as Config;
}

if (process.env?.SCHEDULE) {
	if (!validate(process.env.SCHEDULE)) {
		throw new Error(`Invalid cron schedule: ${process.env?.SCHEDULE}`);
	}

	console.log('Started scheduled run:', process.env?.SCHEDULE, `(${cronstrue.toString(process.env?.SCHEDULE)})`);
	scheduledTask = cron.schedule(process.env.SCHEDULE, safeRun);

	printNextRunTime();
} else {
	await safeRun();
	setTimeout(() => process.exit(0), moment.duration(5, 'seconds').asMilliseconds());
}
