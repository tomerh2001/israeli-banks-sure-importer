# Israeli Banks Sure Importer

`israeli-banks-sure-importer` is a standalone Israeli bank transaction exporter powered by [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers).

This fork is intentionally no longer tied to Actual Budget. It logs into supported Israeli banks, scrapes account activity, and writes normalized account snapshots to disk as JSON, CSV, or both.

## What It Does

- Scrapes supported Israeli banks and credit-card providers through `israeli-bank-scrapers`
- Exports one file per scraped account under a stable output directory
- Supports JSON, CSV, or JSON+CSV output
- Works as a one-shot run or on a cron schedule inside Docker

## Output Layout

Each run writes or refreshes files under the configured `output.directory`.

```text
output/
  index.json
  leumi/
    123456789.json
    123456789.csv
  cal/
    8538.json
    8538.csv
```

- `index.json` contains the top-level run summary.
- Each account file contains the latest normalized snapshot for that bank account.

## Configuration

Create a `config.json` file in the project root and validate it against [`config.schema.json`](./config.schema.json).

```json
{
  "output": {
    "directory": "./output",
    "format": "json-and-csv",
    "pretty": true
  },
  "banks": {
    "leumi": {
      "username": "your-username",
      "password": "your-password",
      "accounts": "all"
    },
    "cal": {
      "userCode": "123456789",
      "password": "your-password",
      "accounts": [
        "8538",
        "7697"
      ]
    }
  }
}
```

### Bank Entries

Each bank entry keeps the credential shape expected by `israeli-bank-scrapers`, plus two optional fields:

- `alias`: optional folder/display name override for the bank
- `accounts`: `"all"` or a list of account numbers to export

Supported company IDs and credential combinations come from the upstream scraper project:
https://github.com/eshaham/israeli-bank-scrapers

### Output Settings

- `directory`: required base directory for exported files
- `format`: `json`, `csv`, or `json-and-csv`
- `pretty`: pretty-print JSON output when `true`

## Environment Overrides

- `SCHEDULE`: cron expression for recurring runs
- `TIMEOUT`: scraper timeout in minutes, defaults to `15`
- `CONFIG_PATH`: optional path to a config file, defaults to `./config.json`
- `OUTPUT_DIRECTORY`: overrides `output.directory`
- `OUTPUT_FORMAT`: overrides `output.format`
- `OUTPUT_PRETTY`: overrides `output.pretty`
- `SHOW_BROWSER`: set to `true` to run the browser visibly
- `VERBOSE`: set to `true` for verbose scraper logs

## Docker Compose

```yaml
services:
  israeli-banks-sure-importer:
    image: tomerh2001/israeli-banks-sure-importer:latest
    restart: always
    environment:
      - TZ=Asia/Jerusalem
      # - SCHEDULE=0 */6 * * *
      # - OUTPUT_DIRECTORY=/app/output
      # - OUTPUT_FORMAT=json-and-csv
    volumes:
      - ./config.json:/app/config.json:ro
      - ./output:/app/output
      - ./chrome-data:/app/chrome-data
```

## Local Run

```bash
yarn install
yarn start
```

## Migration Note

This project was forked from `israeli-banks-actual-budget-importer` but is not backward compatible with that configuration format. The old `actual` block and account-target mapping were removed on purpose so the fork is clearly a standalone exporter.
