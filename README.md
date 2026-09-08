# Niche Numbers 2.0

A portable forecasting and variance modelling tool that connects directly to Google Sheets through Google Apps Script.

## Hybrid truth (authoritative math)

**Planning math runs in the app engine** (deterministic RPN evaluation with fixed-scale decimal arithmetic and topological formula order). Google Sheets are the source for **actuals**, **sync**, and **promote** — not the place where driver-based forecast arithmetic is redefined.

- **Determinism**: `+ − × ÷` use integer micros at scale `1e8`; division by zero throws; unresolved formula dependencies are marked with `v.err` (values are `NaN`, never silent zeros).
- **Scenario forks**: saved versions freeze the full driver state (base / steps / ramp / phase / delta) plus overrides, and a series snapshot for variance compare. Load a version as the working scenario to restore drivers for live editing.


## P1 — formula helpers, variance polish, promote

**Formula builder v2** (no bundler): formulas support FP&A helpers usable from the Insert/Helpers chips in the variable editor:

| Helper | Meaning |
|--------|---------|
| `lag(var, n)` | Value of `var` *n* periods ago (`0` if out of range) |
| `if(cond, a, b)` | `a` when `cond ≠ 0`, else `b` |
| `sum_periods(var)` / `sum(var)` | Running sum of `var` from period 0 through the **current** period |
| `pct(a, b)` | `a / b × 100` |

Existing `+ − * /` and the deterministic decimal engine are unchanged. Run `node engine-test.mjs` to verify P0 demos plus the new helpers.

**Variance**: version dropdowns label saved forks clearly; window/compare prefs persist via `model.uiState`; **Refresh actuals** is always visible on the Variance tab; comparing forks notes that frozen series snapshots are used; Compare lists saved forks as chips.

**Promote scenario to Sheets**: from Forecast, Versions, or Compare → **Promote to Sheets**. Option A writes mapped input ranges (dry-run when disconnected). Option B creates/overwrites a tab named after the scenario with a driver grid — requires redeploying `google-apps-script/Code.gs` (`ensureSheet` action).


## P2 — wow trio + hygiene

**Wow features** (deterministic, zero new deps):

1. **Number X-ray** — click any number in Forecasting (chart dots / legend KPIs), Variance (table & bridge KPIs), or Compare/Cinema → glass drawer with formula lineage and successive-substitution driver contributions for that period. Esc or click-out closes.
2. **Bridge that talks** — Variance driver bridge adds a short plain-English narrative from bridge steps (fav/unfav + top drivers). Waterfall unchanged.
3. **Scenario cinema** — Compare tab defaults to Cinema: Plan vs selected fork side-by-side, period scrubber/playhead, ghost delta chart, synced period KPIs. Click a cinema number to open X-ray. Toggle **Classic** for the full matrix.

**Hygiene**

- **Export / Import** — top bar downloads or restores a full model JSON (moves models across browsers). Connection secrets are not in the model file.
- **Reconnect polish** — Apps Script URL, sheet IDs, and scale are remembered after disconnect; re-enter token and Test & connect.
- Engine verification: `node engine-test.mjs` (no CI required for this pass).



## P3 — formula-aware scan + breakback

**Formula-aware auto-mapping** (deterministic, no LLMs):

- Apps Script `read` accepts `includeFormulas: true` (GET query or POST body) and returns a parallel `formulas` map (same shape as `values`) via `Range.getFormulas()`.
- Scan / import / connect fetch formulas when the redeployed connector supports them.
- Simple Excel formulas (`+ − × ÷`, `A1`, `Sheet!B2`, `$A$1`) are tokenized and mapped onto line-item keys from the scanned block. Recoverable formulas become `kind:'formula'` with an `expr` in variable keys; bare values on a forecast sheet become candidate `kind:'input'`; everything else stays `kind:'output'`.
- Each variable has `mapStatus`: `auto` | `suggested` | `manual` | `unmapped`. Model setup shows a status chip, a “N lines need review” banner, and filters. Name-only heuristics are not applied silently.
- Merge stays non-destructive (P0): keeps non-`srcLine` drivers; upserts by account identity; attaches parsed formulas when present.

**Breakback upgrades** (leaf inverse-solve, not dimensional splash):

- Pure multiply/divide trees use an **exact algebraic** scale (`output = C · Π leaf^p`). Messy graphs (`+`, `if`, …) still use bisection / damped Newton.
- Per-line policy: `v.solveMode`, `v.solveDriver`, `v.pins` override model defaults. Open the gear on a chart line chip (or the solve bar) to edit that line’s policy.
- After a successful drag on a formula line, **Number X-ray** opens for that key + period.

Run `node engine-test.mjs` for P0–P3 checks (A1→expr parse + exact price×volume backsolve).

**Redeploy note:** update Apps Script from `google-apps-script/Code.gs` (**Deploy → Manage deployments → Edit → New version**) so `includeFormulas` / `getFormulas` are live. Existing `/exec` URL is unchanged.

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
