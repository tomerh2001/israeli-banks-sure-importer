/* eslint-disable unicorn/no-process-exit */

import process from 'node:process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {type CompanyTypes} from '@tomerh2001/israeli-bank-scrapers';
import Queue from 'p-queue';
import moment from 'moment';
import cron, {type ScheduledTask, validate} from 'node-cron';
import cronstrue from 'cronstrue';
import type {Config, ConfigBank} from './config.js';
import {type BankExportSummary, scrapeAndExportTransactions} from './exporter.js';
import {resolveOutputConfig} from './exporter.utils.js';

let scheduledTask: ScheduledTask | undefined;

async function run() {
	const typedConfig = await loadConfig();
	const queue = new Queue({
		concurrency: 10,
		autoStart: true,
		interval: 1000,
		intervalCap: 10,
	});
	const output = resolveOutputConfig(typedConfig.output);
	await mkdir(output.directory, {recursive: true});

	const bankEntries = Object.entries(typedConfig.banks) as Array<[CompanyTypes, ConfigBank]>;
	if (bankEntries.length === 0) {
		throw new Error('No banks configured. Add at least one bank entry to config.json.');
	}

	const jobs: Array<Promise<BankExportSummary>> = [];
	for (const [companyId, bank] of bankEntries) {
		jobs.push(queue.add(async (): Promise<BankExportSummary> => {
			try {
				return await scrapeAndExportTransactions({companyId, bank, output});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error('Error exporting bank data:', companyId, message);
				return {
					companyId,
					alias: bank.alias,
					exportedAccounts: [],
					error: message,
				};
			}
		}));
	}

	const summaries = await Promise.all(jobs);

	await writeRunSummary(output.directory, output.pretty, output.format, summaries);

	const exportedAccounts = summaries.reduce(
		(count: number, summary: BankExportSummary) => count + summary.exportedAccounts.length,
		0,
	);
	console.log(`Done. Exported ${exportedAccounts} account snapshot(s) to ${output.directory}`);
}

async function safeRun() {
	try {
		await run();
	} catch (error) {
		console.error('Error running exporter:', error);
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

async function writeRunSummary(
	outputDirectory: string,
	pretty: boolean,
	format: string,
	summaries: BankExportSummary[],
) {
	const summaryPath = path.join(outputDirectory, 'index.json');
	const indentation = pretty ? 2 : undefined;
	await writeFile(summaryPath, `${JSON.stringify({
		exportedAt: new Date().toISOString(),
		format,
		banks: summaries,
	}, null, indentation)}\n`);
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
