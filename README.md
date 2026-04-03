# Israeli Banks Sure Importer

`israeli-banks-sure-importer` logs into supported Israeli banks with [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) and imports the scraped activity into [Sure](https://github.com/we-promise/sure) through Sure's public API.

## What It Does

- Scrapes supported Israeli banks and credit-card providers through `israeli-bank-scrapers`
- Creates Sure transactions through `POST /api/v1/transactions`
- Optionally reconciles Sure account balances through `POST /api/v1/valuations`
- Matches existing Sure categories and merchants by exact name when possible
- Creates missing Sure tags when configured to do so
- Works as a one-shot run or on a cron schedule inside Docker

## Important Sure API Limits

- Sure's public API can list accounts, categories, merchants, and existing imports.
- Sure's public API can create tags, transactions, and valuations.
- Sure's public API does not expose provider-style transaction `external_id` fields, so this importer stores a stable import marker in each Sure transaction note and uses that marker for idempotent re-runs.
- Sure accounts, merchants, and categories must already exist. This importer maps into them; it does not provision the whole Sure budget model from scratch.

## Configuration

Create a `config.json` file in the project root and validate it against [`config.schema.json`](./config.schema.json).

```json
{
  "sure": {
    "baseUrl": "https://sure.example.com",
    "apiKey": "sure_api_key",
    "createMissingTags": true,
    "defaultTags": [
      "Imported"
    ]
  },
  "banks": {
    "leumi": {
      "username": "your-username",
      "password": "your-password",
      "targets": [
        {
          "sureAccountName": "Leumi Checking",
          "accounts": "all",
          "reconcile": true,
          "tags": [
            "Bank Import"
          ],
          "categoryMap": {
            "Dining": "Restaurants",
            "ATM": "Cash"
          }
        }
      ]
    },
    "cal": {
      "userCode": "123456789",
      "password": "your-password",
      "targets": [
        {
          "sureAccountId": "c3d1c26c-61dd-4aa6-a4c9-66de73d79a59",
          "accounts": [
            "8538",
            "7697"
          ],
          "reconcile": true
        }
      ]
    }
  }
}
```

### Bank Entries

Each bank entry keeps the credential shape expected by `israeli-bank-scrapers`, plus importer-specific fields:

- `alias`: optional display name used in logs and import metadata
- `startDate`: optional ISO date to override the default two-year scrape window
- `targets`: one or more Sure import targets

Supported company IDs and credential combinations come from the upstream scraper project:
https://github.com/eshaham/israeli-bank-scrapers

### Target Settings

- `sureAccountId` or `sureAccountName`: the existing Sure account to import into
- `accounts`: `"all"` or a list of scraper `accountNumber` values to map into that Sure account
- `reconcile`: when `true`, compare the summed scraped balance with the Sure account balance and create a Sure valuation if they differ
- `tags`: optional Sure tag names or IDs to attach to every imported transaction for that target
- `categoryMap`: optional map from scraper category names to Sure category names or IDs

## Environment Overrides

- `SCHEDULE`: cron expression for recurring runs
- `TIMEOUT`: scraper timeout in minutes, defaults to `15`
- `CONFIG_PATH`: optional path to a config file, defaults to `./config.json`
- `SURE_BASE_URL`: overrides `sure.baseUrl`
- `SURE_API_KEY`: overrides `sure.apiKey`
- `SURE_CREATE_MISSING_TAGS`: overrides `sure.createMissingTags`
- `SURE_TIMEOUT_MS`: overrides `sure.timeoutMs`
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
      # - SURE_BASE_URL=https://sure.example.com
      # - SURE_API_KEY=replace-me
    volumes:
      - ./config.json:/app/config.json:ro
      - ./chrome-data:/app/chrome-data
```

## CI/CD Docker Publishing

GitHub Actions validates every push and pull request, then runs semantic-release on `main` and `develop`.

- The release job publishes the Docker image `tomerh2001/israeli-banks-sure-importer`
- It uses the built-in GitHub Actions token for GitHub release/tag work
- It only requires Docker Hub secrets: `DOCKER_REGISTRY_USER` and `DOCKER_REGISTRY_PASSWORD`

## Local Run

```bash
yarn install
yarn start
```

## Import Notes

- Imported Sure transactions include a stable note marker so repeated runs stay idempotent even though the public Sure API does not expose provider `external_id` fields.
- Imported transaction notes also preserve the scraper memo, source bank, source account, and useful source metadata such as pending status or installment details.
- Merchant matching is exact-name only against merchants that already exist in Sure.
- Category matching is exact-name unless you override it with `categoryMap`.
- When `reconcile` is enabled, the importer now waits for Sure to reflect the valuation and triggers one follow-up Sure sync if the balance cache is still stale after the transaction import finishes.
