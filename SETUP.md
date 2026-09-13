# Setting up Niche Numbers — a one-time guide

This guide gets you from zero to a working setup: the app connected to your own Google Sheet, reading your projections and your actuals. **Almost all of this is a one-time effort.** Once it's done, day to day you just open the app and use it — you won't touch any of the setup again.

There are three one-time steps:

1. Connect the app to Google Sheets (deploy a small script once).
2. Point the app at your sheet.
3. Confirm a handful of lines the app flags for review.

Then you're set.

---

## Before you start

You'll need:

- A **Google account** that can open your projections spreadsheet.
- Your **projections / forecast** spreadsheet in Google Sheets (and, when you have them, your **actuals** in a second sheet).
- The **app** — open it in your browser (for example the hosted link you were given, e.g. `niche-numbers-forecasting.vercel.app`).

> **The one rule that matters most:** the Google account you use to set up the script in Step 1 must be able to open the spreadsheet(s) you want to forecast. The simplest way to guarantee that is to keep the **spreadsheet and the script under the same Google account.** If they're in different accounts, the connection will fail with a permission error.

---

## Step 1 — Connect the app to Google Sheets (one time)

This installs a tiny "bridge" script inside your spreadsheet so the app can read and write it. You do this **once**.

1. Open your **projections** spreadsheet in Google Sheets.
2. In the top menu, click **Extensions → Apps Script**. A code editor opens in a new tab.
3. Delete whatever is in that editor, and paste in the full contents of the **`Code.gs`** file (from this project).
4. Near the top of the code you'll see a line like `const TOKEN = 'CHANGE_ME';`. Change `CHANGE_ME` to a **private password of your own** (any word or phrase — this is your key; keep it private). For example `const TOKEN = 'my-secret-123';`.
5. Click **Deploy → New deployment**.
6. Click the gear/"Select type" and choose **Web app**.
7. Set **Execute as** to **Me**, and **Who has access** to **Anyone**.
8. Click **Deploy**. Google will ask you to authorize it the first time — approve it (it's your own script accessing your own sheet).
9. It gives you a **Web app URL** ending in **`/exec`**. **Copy that URL and keep it** — along with the token you chose in step 4. These two together are what connect the app to your sheet.

**That's the once-only part.** You don't redeploy or touch Apps Script again unless the `Code.gs` code itself is updated later (and even then the URL stays the same — you'd just publish a new version).

---

## Step 2 — Point the app at your sheet (one time)

1. Open the **app** in your browser.
2. Click **Connect sheet** (top-right).
3. Paste in:
   - the **Web app URL** (the `/exec` link from Step 1),
   - the **token** you chose,
   - the **link to your Google Sheet** (just copy the sheet's normal URL from your browser).
4. Click **Test & connect**, then **Scan**.

The app now reads your sheet's own formulas and builds the model for you — most of it automatically.

---

## Step 3 — Confirm the lines flagged for review (one time)

After the scan, most lines map themselves. A few may show up as **"needs review"** — these are lines the app wants you to confirm so it knows exactly which row in your sheet each one is.

For each flagged line, open it and **point it at the right sheet line** (pick it from the list, or accept the suggestion). That's it.

> Think of this as **furnishing a room once.** It takes a few minutes the first time, and then it's done — the app remembers your mappings, so you won't repeat this. You only revisit it if you later add brand-new lines to your model.

---

## You're set — day to day

From here on, using the tool is just:

- Open the app (it remembers your connection).
- Edit your assumptions and see the forecast update.
- Load actuals and use the **Variance** tab to see what drove the difference — and roll drivers forward into future periods.

No Apps Script, no re-mapping, no re-connecting. The one-time setup above is the only "technical" part.

---

## A few good-to-knows

- **Keep your token and `/exec` URL private.** Anyone who has *both* can read and write the sheets your Google account can access. If either is ever exposed, just change the token (repeat Step 1, step 4–8) — the old one stops working.
- **Actuals sheet.** When you're ready to compare plan vs actual, put your actuals in a second Google Sheet (same account) and add it in the Connect screen the same way. The app matches your actuals rows to your plan lines by their labels.
- **If a connection ever fails**, it's almost always the same-account rule from the top: the account that deployed the script must be able to open the sheet. Check that first.
- **Your settings live in your browser.** The app stores your model and connection in the browser you use it in. To move to another browser or computer, use **Export** (top bar) to save a model file and **Import** it on the other side. (Your token isn't included in that file, so you'd re-enter it once.)
