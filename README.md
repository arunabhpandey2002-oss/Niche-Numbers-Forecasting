# Niche Numbers 2.0

A portable forecasting and variance modelling tool that connects directly to Google Sheets through Google Apps Script.

## Hybrid truth (authoritative math)

**Planning math runs in the app engine** (deterministic RPN evaluation with fixed-scale decimal arithmetic and topological formula order). Google Sheets are the source for **actuals**, **sync**, and **promote** — not the place where driver-based forecast arithmetic is redefined.

- **Determinism**: `+ − × ÷` use integer micros at scale `1e8`; division by zero throws; unresolved formula dependencies are marked with `v.err` (values are `NaN`, never silent zeros).
- **Scenario forks**: saved versions freeze the full driver state (base / steps / ramp / phase / delta) plus overrides, and a series snapshot for variance compare. Load a version as the working scenario to restore drivers for live editing.

## Included

- `index.html` — the complete application and calculation engine.
- `google-apps-script/Code.gs` — the Google Sheets read/write connector.
- `vercel.json` — simple Vercel configuration.

No paid database, server or AI API is required. Model settings are stored in the user's browser.

## Put it on GitHub

1. Create a new empty repository at https://github.com/new.
2. Name it `niche-numbers-2`.
3. Download and unzip this codebase.
4. On the empty repository page, choose **uploading an existing file**.
5. Drag all unzipped files and folders into GitHub.
6. Select **Commit changes**.

## Connect Google Sheets

1. Open a Google Sheet that your Google account can edit.
2. Select **Extensions → Apps Script**.
3. Replace the editor contents with `google-apps-script/Code.gs`.
4. Change `CHANGE_ME` to a private token of your choice.
5. Select **Deploy → New deployment → Web app**.
6. Set **Execute as** to **Me** and **Who has access** to **Anyone**.
7. Deploy and copy the URL ending in `/exec`.
8. In Niche Numbers, select **Connect sheet** and enter the `/exec` URL, the same token, and the Google Sheet URL.

The Google account that deploys the Apps Script must be able to access every spreadsheet used by the app.

## Host on Vercel

1. Sign in at https://vercel.com using GitHub.
2. Select **Add New → Project**.
3. Import the `niche-numbers-2` repository.
4. Leave the framework preset as **Other** and do not add environment variables.
5. Select **Deploy**.

## Update later

Upload changed files to the same GitHub repository. Vercel automatically creates a new deployment after each commit.

For Apps Script changes, use **Deploy → Manage deployments → Edit → New version → Deploy**. The existing `/exec` URL remains the same.

## Security

- The repository contains no token or API key.
- Do not commit your real Apps Script token.
- The connection details entered in the app are stored in that browser's local storage.
- Anyone who knows both the Apps Script URL and token can use the connector with the deploying account's spreadsheet access. Rotate the token if it is exposed.
