# Niche Numbers 2.0

A portable, single-file forecasting **and** variance-analysis tool. It builds a driver-based financial model in the browser, runs a deterministic calculation engine, and connects to Google Sheets (via Google Apps Script) for actuals, sync, and write-back. No server, no database, no AI API. All state lives in the browser's `localStorage`.

> **This README is the full handoff document.** It is written so a coding agent (or a person) can pick up the project cold — the architecture, the data model, every tab, the connector, the tests, the deploy steps, the invariants you must not break, and a changelog of recent work. Read the "Invariants" section before changing anything.

---

## 1. What it does (one paragraph)

You define **variables** that form a dependency graph. Each variable is an `input` (you drive it), a `formula` (computed from other variables), or an `output` (read straight from a sheet). The engine computes every formula per period in deterministic order. You forecast by editing inputs (with steps, ramps, seasonality, and scenario overrides), you compare any two versions (Plan / Scenario / a saved fork / Actuals / prior period) on the **Variance** tab, and the tool decomposes each line's variance into its **driver contributions**, ranks the base variables driving the gap, and lets you **roll a driver forward into future periods** or reject it. It can also write forecast inputs and formula logic back to your sheet.

---

## 2. Files

| File | What it is |
|------|-----------|
| `index.html` | The **entire** application: CSS, HTML shell, calculation engine, all five tabs, the Google Sheets client, persistence. ~6,500 lines. Single file by design. |
| `google-apps-script/Code.gs` | The Google Sheets read/write connector (a Web App). Deployed by the user into their own Google account. |
| `google-apps-script/connector-test.mjs` | Node contract test for `Code.gs` — mocks `SpreadsheetApp` and checks list/read/write/ensureSheet + `includeFormulas`. |
| `engine-test.mjs` | Node test harness for the calculation engine (P0–P4): RPN eval, determinism, helpers, bridge/root-cause math, A1→expr parsing, exact backsolve. |
| `vercel.json` | Static hosting config (cleanUrls, no framework). |
| `README.md` | This document. |
| `index.html.bak-*`, `README.md.bak-*` | Timestamped backups created before edits (there is **no git repo** in this folder — see Invariants). |

Run both test suites (no build step, no deps):

```
node engine-test.mjs
node google-apps-script/connector-test.mjs
```

---

## 3. Architecture overview

Single HTML file, three layers:

1. **Engine** (`compile` → `evalRPN` → `evalModel`) — pure functions, deterministic, no DOM.
2. **Model + state** — a global `model` object (the graph, periods, overrides, versions, UI state) and a global `conn` object (Sheets connection). Persisted to `localStorage`.
3. **UI** — a tab router (`render()` / `switchTab()`) that rebuilds one of five views into `#main` and wires events. Views are string-templated HTML re-rendered on every change; there is no virtual DOM.

Boot is the last two lines of the script: `loadLocal(); render();`.

### "Hybrid truth"
Forecast **arithmetic runs in the app engine** (deterministic). Google Sheets is the source for **actuals, sync, and promote** — never where forecast math is redefined. For variance, every scanned line keeps its authoritative workbook forecast series; the bridge *explains* the gap, it does not silently replace the source forecast.

---

## 4. The calculation engine

### 4.1 Expression compiler — `compile(expr)`
Shunting-yard parser → RPN token list plus a `deps` array (variable names referenced). Supports `+ - * /` with precedence and parentheses, numbers, variable identifiers, and FP&A helper functions.

Helper functions (`NN_FN_ARITY`): 

| Helper | Meaning |
|--------|---------|
| `lag(var, n)` | Value of `var` *n* periods ago (0 if out of range) |
| `if(cond, a, b)` | `a` when `cond ≠ 0`, else `b` |
| `sum_periods(var)` / `sum(var)` | Running sum of `var` from period 0 through the current period |
| `pct(a, b)` | `a / b × 100` |
| `max(a, b)` / `min(a, b)` | Numeric max / min |

`lag`, `sum_periods`, `sum` take a **variable reference** as their first arg (rewritten to a `{vref}` token so the name survives into eval for cross-period lookups).

### 4.2 Deterministic decimal arithmetic — `evalRPN(rpn, scope, ctx)`
All `+ - * /` run on **integer micros at scale `1e8`** (`NN_SCALE`), so results are reproducible across machines. Division by zero **throws** (`'Division by zero'`). Unresolved / non-finite operands yield `NaN` (never a silent 0). `ctx = {period, lookup(key,q)}` enables cross-period helpers.

### 4.3 The model graph — `evalModel(scenario)`
- `inputs()`, `formulas()`, `outputs()` partition `model.vars` by `kind`.
- `recompileAll()` compiles every formula's `expr` into `v.compiled` and sets `v.err`.
- `formulaTopoOrder()` — deterministic Kahn topological sort (always dequeues the lexicographically smallest ready key). Formulas in a cycle or with unresolved deps are returned as `leftover` and marked `v.err` and evaluated to `NaN`.
- `evalModel(scenario)` returns `{key: [values per period]}`. When `scenario` is true, per-period **input overrides** are applied.
- Missing dependency → `v.err = 'Missing dependency: …'` and `NaN` for that cell (never 0).

### 4.4 Inputs over time
- `levelArray(v)` — baseline level per period: either a **ramp** (`v.ramp = {on, start, months, from, to}`) or `v.base` with forward-filled **step changes** (`v.steps = [{from, value}]`).
- `schedule(v)` — `levelArray × seasonal phase` (`v.phase[p]`, default 1).
- **Scenario overrides are forward-carrying anchors:** `model.ov[key][period] = value`. From the anchor period onward, later periods keep the baseline's own month-to-month movement re-based to the dragged level: `scenario[q] = anchorValue + (baseline[q] − baseline[anchorPeriod])`. `setOv/delOv/hasOv` manage them.

---

## 5. Data model (`model`) — shape reference

```
model = {
  periods: ["Sep '26", …],       // labels; genMonths(n, startM, startY)
  closed: 0,                      // # of closed/actual periods; "future" = index >= closed
  vars: [ …variables… ],
  ov: { key: { periodIndex: value } },   // scenario overrides (anchors)
  versions: [ {id, name, drivers, ov, series, …} ],  // saved scenario forks (frozen snapshots)
  displayVars: ["revenue"],       // lines charted on Forecast
  vnotes: { key: {reason, remark} },     // variance reason codes + commentary
  reasonCodes: [ …custom reasons… ],
  matThresh: 0,                   // materiality % filter
  sources: { forecast, actuals, graph } | null,  // imported-file source refs
  pages: ["Page 1"], canvasPage: 0, nodePos: {},  // setup canvas layout
  rollForwardLog: [ …audit entries… ],
  uiState: { mapFilter, selKey, v:{…}, c:{…}, scanCatalog, scanActualsCatalog, graphIngestVersion, closedMode },
  solveMode, solveDriver, pins,   // breakback defaults
}
```

### Variable shape
```
{
  key,            // unique lowercase identifier used in formulas
  name,           // display name
  unit,           // '₹' | '#' | '%' | 'INR' …
  kind,           // 'input' | 'formula' | 'output'
  base, steps, ramp, phase, delta,   // input drivers
  expr, compiled, err,               // formula
  read,           // output series read from sheet
  range,          // A1 range of the FORECAST cells (across periods)
  actualRange, actuals, actualPeriods, // actuals mapping + data
  writable,       // input write-back allowed
  mapStatus,      // 'auto' | 'suggested' | 'confirmed' | 'unmapped'  (see mapStatusOf)
  account, metric,// grouping labels from the sheet
  good, favOverride,  // variance polarity
  sheetFormula, srcLine, srcGraph, srcPricing, // scan provenance
  solveMode, solveDriver, pins,       // per-line breakback policy
}
```

`mapStatusOf(v)` normalizes status (confirmed-without-range demotes to suggested; legacy `manual` shows as confirmed; `auto`-without-range is `unmapped`).

---

## 6. Persistence

`localStorage` keys:
- `nn_model` — the whole `model` (via `saveModel()`; also runs `persistUiState()`).
- `nn_conn2` — the `conn` object (URL, token, ssid, sheets, actualsSsid…). **Contains the token** — never committed.
- `nn_conn_prefs` — URL / ssid / scale / actualsSsid remembered after disconnect (no token).
- `nn_pricing` — the Pricing tab state.

**Export / Import** (top bar): `exportModelJson()` downloads `{format:'niche-numbers-model', version:2, model}`; `importModelJson()` restores it. Connection secrets are **not** in the model file. This is the portable way to move a model between browsers — and the fastest way to hand a coding agent the exact current model state for debugging.

`loadLocal()` migrates older models (fills defaults, `ensureModelShape()`), restores UI sub-state, and drops Pricing ghosts when a graph model is present.

---

## 7. The five tabs

Router: `render()` dispatches on `uiTab` to `viewSetup / viewForecast / viewVariance / viewPricing / viewCompare`, then a `mount*` wires events.

### 7.1 Model setup (`viewSetup`)
- The **variable table** (add/edit/delete lines, kind, unit, formula, sheet mapping) and a **drag-and-drop lineage canvas** (`renderCanvas`, `redrawLinks`) with pages, pan/zoom, link create/remove.
- `varModal` / `saveVar` — full variable editor (kind, expr with Insert/Helper chips, forecast range, actuals range — pick from scanned catalog or type sheet/col/row).
- `openConfirmClassify(key)` — the **assisted-mapping** dialog: accept the scanned classification, or point a line at a scanned sheet line (dropdown of every tab/row the scan found) / type the exact cell, for both forecast and actuals. This is the machinery the variance driver-coverage gaps link to (rung 2, below).
- Map-status chips + "N lines need review" banner + filters. A **stale-model banner** (`staleGraphModel`) warns when old fake P&L inputs remain (fix: Clear all → Connect & Scan).

### 7.2 Forecasting (`viewForecast`)
- Draggable line chart. Dragging a charted line **backsolves** its drivers (`applyDrag` → `tryExactBacksolve` for pure ×/÷ monomial trees via `monomialFactorization`; otherwise bisection / damped Newton in `backsolvePeriod`). Per-line policy (`solveMode`, `solveDriver`, `pins`) via the gear/solve bar.
- Assumptions cards (base, steps, ramp/seasonality via `openShape`), scenario overrides, X-ray on any number.

### 7.3 Variance analysis (`viewVariance`) — the core of this project
See section 8.

### 7.4 Pricing (`viewPricing`)
Tiered/seat/SaaS pricing model that can **seed drivers into the shared graph** (`syncPricingDrivers`) so pricing feeds the forecaster/X-ray/scenarios. `computePricing`, tier editors, promote rows.

### 7.5 Compare scenarios (`viewCompare`)
Default **Cinema** mode: Plan vs a selected fork side-by-side with a period scrubber/playhead, ghost delta chart, synced KPIs; click a number for X-ray. **Classic** toggle shows the full matrix.

---

## 8. Variance analysis — internals

### 8.1 Versions — `versionData(which, ctxA)`
Resolves a comparison side to a `{key:[series]}` object. `which` ∈ `plan | scenario | forecast | actual | prior | v:<id>` (saved fork). Saved forks use their **frozen series snapshot**, not live drivers. `_vState = {A, B, line, win, priorN}` holds the current comparison; `_cState` holds Compare's.

### 8.2 The driver bridge — `bridge(key, A, B, win)`
For a **formula** line, decomposes its variance into driver contributions by **successive substitution**: swap each driver from side B to side A one at a time and attribute the step. Averaged over the window with the line's aggregation method (`sum/avg/last`).
- The selected line's mapped figures are the **authoritative endpoints** (`start = vAgg(B)`, `end = vAgg(A)`).
- A driver with no value on one side is added to `missingDeps` and **held constant** — never turned into a phantom 0 contribution. Its share of the gap lands in `residual`.
- Returns `{start, end, steps[], residual, computedStart, computedEnd, missingDeps}`.
- A driver **referenced by the formula but with no variable** (`vget` returns nothing) is silently dropped — this is why the driver-coverage readout (8.5) exists.

`renderBridge` draws the waterfall, a plain-English narrative (`bridgeNarrative`), per-driver contribution rows with "drill in", and a variance-over-time sparkline.

### 8.3 Diagnostics for an unexplained gap — `bridgeResidualInfo(v, br, totVar)`
When the residual is material, returns a specific label instead of a dead-end "unexplained":
- **Driver actuals unavailable** (names the missing metrics),
- **Formula review required · N** (names unconfirmed lines; `pendingFormulaLines` walks the dep tree for `suggested`/`unmapped` vars),
- **Formula reconciliation gap** (mapped formula doesn't reproduce the endpoints).

### 8.4 Coverage badge — auto vs tagged (split)
The toolbar badge shows **two numbers over a two-color bar**: `X% auto` (variance on lines whose driver bridge fully reconciles — see `isAutoExplained`) and `Y% tagged` (variance on lines the user manually tagged with a reason). The remainder is still unexplained.
- `isAutoExplained(v, A, B, win)` — true only if `v` is a formula line, has driver steps, has **no missing driver actuals**, and residual ≤ 1% of the total variance. Deliberately strict so "auto" never overstates what the model knows.

### 8.5 Driver coverage readout + the escalation ladder
For the selected line, `driverCoverage(rootKey, A, B, win)` walks the **full leaf tree** down to raw inputs and classifies every driver:
- **✓ ok** — variable exists and has data on both compared sides (feeds `auto`),
- **⚠ noactual** — in the model but missing actuals on one side,
- **✕ notinmodel** — referenced by a formula but no variable exists (used to vanish silently).

Rendered as a "Driver coverage · X/Y mapped with actuals" panel in the bridge (collapses to a green "✓ All N drivers mapped" when complete). This is how you **verify drivers are 100% picked up**. Each gap row carries a fix action — the escalation ladder:

1. **Auto from the model** — when a driver is mapped with actuals it feeds the auto split automatically.
2. **Assisted mapping ("the driver exists, here's where")** — ⚠ rows open `openConfirmClassify(key)` (Point to sheet →) to map the actuals cell; ✕ rows call `fixMissingDriver(parentKey, missingKey)` (Fix in setup →) which jumps to Model setup, focuses the parent line, and names the missing key.
3. **Manual tag by a human** — when a driver genuinely doesn't exist, the inline **Reason** box in the bridge (`setReason`/`setRemark`, reason codes from `allReasons()`, "＋ Add…") records the reason; it counts toward the `tagged` badge.

### 8.6 Reason codes & commentary
`REASONS_DEFAULT` + user `reasonCodes`. Per-line `vnotes[key] = {reason, remark}`. Table dropdown, inline bridge tagger, and a slide-out commentary drawer (`openCommentary`) all edit the same note.

### 8.7 Root-cause roll-forward — **flag the driving variable, adjust future forecasts** (`renderRollForward`)
This is the "what drove the variance, and should the forecast change?" panel below the bridge. It:
- Traces the outcome to its **leaf inputs** and ranks them by share of the gap using a **two-direction Shapley approximation** (`rfLeafAttribution` — forward and reverse substitution averaged; contributions reconcile to the leaf-modeled gap; reports `coverage`, `residual`, `orderSensitivity`).
- Tests **persistence** across periods (`rfLeafEvidence`) and reports observed min/max/median vs plan median.
- `collectRollForwardSuggestions(win)` keeps drivers with material share (≥ `matThresh`, floor 5%) and persistence ≥ 60%, top 6, and marks each `high` (auto-Apply allowed) or `review`.

Each card, e.g. **"Take rate explains ~81% of the Net revenue variance. Actuals held at 1.6% vs a plan median of 2.0%,"** offers:
- **Apply actual median to open forecast** (`rollForwardApply`) — writes the observed median into **open future periods only** via `setOv`; high-confidence only.
- **Reject · keep plan** (`rollForwardKeepPrompt`/`Keep`) — keeps the plan, **requires an audit reason**, stashes it on the line note.
- **Custom…** (`rollForwardCustomPrompt`/`Custom`) — apply an exact value to open periods.
- **Mark a driver yourself** — pick any leaf, set a value, apply to open months (for review-confidence drivers or deliberate decisions).

Every action is logged to `model.rollForwardLog` with timestamp, values, reason, and periods touched.

**"Future periods only" is bounded by `model.closed`.** `openFuturePeriods()` returns periods from `model.closed` onward; `syncClosedFromActuals()` sets `model.closed = lastActualIdx() + 1` on scan/refresh/ingest. So Apply never overwrites closed/actual months — provided actuals are mapped (which sets `closed`).

> The roll-forward cards only appear once the driving leaf (e.g. take rate) is **mapped with actuals**. If they're empty, the driver isn't mapped yet — use the driver-coverage ladder (8.5) to map it, then the card surfaces automatically. This is the intended trust behavior: the tool never fabricates a take-rate explanation from a P&L that doesn't contain take rate.

### 8.8 Other variance UI
- **Number X-ray** (`openXray`) — glass drawer with formula lineage + successive-substitution driver contributions for one period. Click any number in Forecast/Variance/Compare.
- **Account view** (`openAccount`) — every metric for one account as forecast-vs-actual charts (double-click a row).

---

## 9. Google Sheets connector

### 9.1 `Code.gs` (Apps Script Web App)
One deployment reads/writes any spreadsheet the deploying Google account can access. Token-guarded (`const TOKEN = 'CHANGE_ME'` — change before deploy). Actions:
- `list` — sheet names, rows, cols.
- `read` — values for `ranges` (`A|B|C` separated). With `includeFormulas=true` (GET query or POST body) also returns a parallel `formulas` map via `Range.getFormulas()`. Bad ranges are skipped (returned in `skipped`), never fatal.
- `write` (POST) — each write has a `range` and either `values` (2-D array) or `formulas` (1×N; columns auto-expanded via `writeFormulasClamped_`). Formulas preferred over values.
- `ensureSheet` (POST) — create/clear a tab and dump a grid (used by "Promote scenario to Sheets").

Client entry point: `gasReadRanges(ranges, opts)` — POST first (long range lists + formulas flag), GET fallback; filters obviously broken A1.

### 9.2 Formula-aware scan / ingest (deterministic, no LLM)
- `ingestFormulaGraphFromSheet` / `walkFormulaGraph` — follow cross-sheet A1 refs to build the model graph from the sheet's own formulas.
- `sheetFormulaToExpr(formula, cellMap, defaultSheet)` — tokenize simple Excel formulas (`+ - * /`, `A1`, `Sheet!B2`, `$A$1`), map cell refs to line-item keys. Functions/names → not accepted (except `SUM(contiguous)` pre-expanded by `expandExcelSumRanges`). Recoverable formulas become `kind:'formula'` with an `expr`.
- Layout auto-detection: `detectLayoutFromGrid`, `isPeriodHeader`, `parseLines`, `rankedSheetTabs` (P&L tabs rank ahead of Pricing/Cash Flow).
- Actuals placement: `placeActualsOntoGraphModel` matches actuals-tab rows to model vars by label (`labelMatchScore`, `bestLabelMatch`).
- Scan catalogs live on `uiState.scanCatalog` / `scanActualsCatalog` and power the mapping dropdowns.

### 9.3 Promote & write-back
- **Write inputs** (`openWriteback`/`confirmWriteback`) — push scenario input values into their mapped ranges (dry-run when disconnected).
- **Write formula logic** (`writeFormulaLogicToSheet`) — push model formulas back as real sheet formulas.
- **Promote scenario** (`openPromoteModal`) — Option A writes mapped inputs; Option B creates/overwrites a scenario tab with a driver grid (needs `ensureSheet` in the deployed `Code.gs`).

---

## 10. Tests

- `node engine-test.mjs` — P0–P4: `10/2`, div-by-zero throw, price×volume graph, topo order, missing-dep→NaN, `pct/if/lag/sum_periods/sum`, bridge authoritative endpoints + residual reconciliation, `gapShareLabel`, acquisition-cost reconciliation, bridge narrative, period contributions, robust-center/persistence/two-direction attribution, P&L layout detection, A1→expr parsing, exact monomial backsolve.
- `node google-apps-script/connector-test.mjs` — mocks `SpreadsheetApp`; checks token guard, list, read (+formulas, +skipped), write values, write formulas (+column expansion), ensureSheet (+clear/flush).

**Test gap to be aware of:** the engine has `max`/`min` helpers in `index.html` that `engine-test.mjs` does **not** yet cover. Add cases if you touch them.

There is no runtime harness for `index.html`'s UI. For syntax safety after editing the big file, extract the `<script>` body and run `node --check` on it.

---

## 11. Deploy

**Static app (Vercel):** push to GitHub, import the repo, framework preset "Other", no env vars, Deploy. Each commit redeploys.

**Connector (Apps Script):** open a Google Sheet → Extensions → Apps Script → paste `Code.gs` → set `TOKEN` → Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → copy the `/exec` URL. In the app: Connect sheet → paste the `/exec` URL, the same token, and the Sheet URL. Redeploy note: after changing `Code.gs` use Deploy → Manage deployments → Edit → New version; the `/exec` URL stays the same. (`includeFormulas`/`getFormulas` and `ensureSheet` require a redeploy of the version.)

**Security:** the repo contains no token. `conn` (with token) lives only in that browser's `localStorage`. Anyone with both the `/exec` URL and token can use the connector with the deploying account's spreadsheet access — rotate the token if exposed.

---

## 12. Invariants — read before changing anything

1. **Determinism is the product.** Keep `+ - * /` on integer micros (`NN_SCALE`). Division by zero must throw. Never let an unresolved value become a silent 0 — it must be `NaN` and set `v.err`.
2. **Never fabricate a variance reason.** If a driver's actual isn't present, it stays in `residual`/`missingDeps` — do not manufacture a contribution. Auto-attribution is only as good as the mapped drivers; the coverage readout exists to make that honest and visible.
3. **Apply changes the future only.** Roll-forward writes to `openFuturePeriods()` (index ≥ `model.closed`). Keep `syncClosedFromActuals()` wiring intact so closed/actual months are never overwritten.
4. **Authoritative endpoints.** The bridge's start/end are the line's own mapped figures; driver substitution explains the movement between them and reconciles via `residual`.
5. **This folder is NOT a git repo.** There is no version control here. Make a timestamped backup (`cp index.html index.html.bak-$(date +%Y%m%d-%H%M%S)`) before editing, and run both test suites + `node --check` on the extracted script after.
6. **Single file.** Do not split `index.html` into separate CSS/JS files; the project is intentionally one portable file. External scripts, if ever needed, from cdnjs only.
7. **Secrets.** Never write the Apps Script token into the repo or the exported model JSON. It belongs only in `localStorage` (`nn_conn2`).
8. **Redeploy awareness.** Any change to `Code.gs` behavior (e.g. new action, formula reads) requires the user to redeploy a new Apps Script version; note it in your handoff.

---

## 13. Changelog (recent work beyond the P0–P4 base)

The base tool ships P0–P4 (formula helpers, variance polish, promote, wow trio, formula-aware scan, breakback, root-cause roll-forward). Recent additions on top:

- **Unexplained diagnostics** — `bridgeResidualInfo` returns specific labels (Driver actuals unavailable / Formula review required · N / Formula reconciliation gap) instead of a dead-end "Other / unexplained."
- **Inline reason tagging in the bridge** — a Reason dropdown + note box appears in the bridge for any line that can't be auto-explained (or is a flat input/output, or is already tagged), so a human reason is one click away. Reuses `setReason`/`setRemark`/`allReasons`.
- **Split coverage badge** — the toolbar badge shows `X% auto` (driver-reconciled, `isAutoExplained`) vs `Y% tagged` (manual), over a two-color bar; the remainder is unexplained.
- **Driver-coverage readout + escalation ladder** — `driverCoverage()` walks the full leaf tree and classifies every driver ✓/⚠/✕; gap rows link to `openConfirmClassify` (Point to sheet) or `fixMissingDriver` (Fix in setup). Makes "are all drivers picked up?" verifiable and one-click fixable, ahead of falling back to manual tagging.

### Reference test data
`PulseStack_SaaS_Forecast_Model.xlsx` and `PulseStack_SaaS_Actuals_Jan-Dec2026.xlsx` are the canonical example: tabs `Growth Engine` (customers, seats, churn, cost/comp drivers), `Plan Mix & Pricing` (plan mix, per-seat prices, blended price), `P&L (CM view)` (subscription revenue = total paid seats × blended price, etc.), `Cash Flow`. The forecast holds the formulas; the actuals mirror every row as hardcoded values, including the drivers — so the full chain is attributable once mapped.
