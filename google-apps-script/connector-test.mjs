/** Contract tests for Code.gs. Run: node google-apps-script/connector-test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const calls = { flush: 0, inserted: 0, values: [], formulas: [], cleared: 0 };

const ranges = {
  'Plan!B2:C2': {
    getValues: () => [[10, 20]],
    getFormulas: () => [['=A2*2', '=B2*2']],
    getSheet: () => sheet,
    getRow: () => 2,
    getColumn: () => 2,
    setValues: values => calls.values.push(values),
    setFormulas: formulas => calls.formulas.push(formulas)
  }
};

const sheet = {
  getName: () => 'Plan',
  getLastRow: () => 20,
  getLastColumn: () => 8,
  getMaxColumns: () => 2,
  insertColumnsAfter: (_after, count) => { calls.inserted += count; },
  getRange: (row, col, height, width) => ({
    setValues: values => calls.values.push({ row, col, height, width, values }),
    setFormulas: formulas => calls.formulas.push({ row, col, height, width, formulas })
  }),
  clear: () => { calls.cleared += 1; }
};

const spreadsheet = {
  getName: () => 'Forecast Model',
  getSheets: () => [sheet],
  getRange: range => {
    if (!ranges[range]) throw new Error(`Range not found: ${range}`);
    return ranges[range];
  },
  getSheetByName: name => name === 'Scenario' ? sheet : null,
  insertSheet: () => sheet
};

const context = {
  console,
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({
      text,
      setMimeType() { return this; }
    })
  },
  SpreadsheetApp: {
    openById: () => spreadsheet,
    getActiveSpreadsheet: () => spreadsheet,
    flush: () => { calls.flush += 1; }
  }
};

vm.runInNewContext(source, context, { filename: 'Code.gs' });
const json = response => JSON.parse(response.text);
const get = parameter => json(context.doGet({ parameter }));
const post = body => json(context.doPost({ postData: { contents: JSON.stringify(body) } }));

assert.deepEqual(get({ token: 'wrong', action: 'list' }), { ok: false, error: 'Invalid token' });

const listed = get({ token: 'CHANGE_ME', action: 'list', ssid: 'sheet-id' });
assert.equal(listed.ok, true);
assert.equal(listed.spreadsheet, 'Forecast Model');
assert.deepEqual(listed.sheets, [{ name: 'Plan', rows: 20, cols: 8 }]);

const read = get({
  token: 'CHANGE_ME', action: 'read', ssid: 'sheet-id',
  ranges: 'Plan!B2:C2|Missing!A1', includeFormulas: 'true'
});
assert.equal(read.ok, true);
assert.deepEqual(read.values['Plan!B2:C2'], [[10, 20]]);
assert.deepEqual(read.formulas['Plan!B2:C2'], [['=A2*2', '=B2*2']]);
assert.deepEqual(read.values['Missing!A1'], [['']]);
assert.equal(read.skipped.length, 1);

const wroteValues = post({
  token: 'CHANGE_ME', action: 'write', ssid: 'sheet-id',
  writes: [{ range: 'Plan!B2:C2', values: [[11, 22]] }]
});
assert.equal(wroteValues.ok, true);
assert.equal(wroteValues.wrote, 1);

const wroteFormulas = post({
  token: 'CHANGE_ME', action: 'write', ssid: 'sheet-id',
  writes: [{ range: 'Plan!B2:C2', formulas: [['=1', '=2', '=3']] }]
});
assert.equal(wroteFormulas.ok, true);
assert.equal(calls.inserted, 2);

const ensured = post({
  token: 'CHANGE_ME', action: 'ensureSheet', ssid: 'sheet-id',
  sheetName: 'Scenario', clear: true, values: [['Line', 'Jan'], ['Revenue', 100]]
});
assert.equal(ensured.ok, true);
assert.equal(ensured.rows, 2);
assert.equal(calls.cleared, 1);
assert.ok(calls.flush >= 3);

console.log('PASS: Google Apps Script connection bridge contract');
