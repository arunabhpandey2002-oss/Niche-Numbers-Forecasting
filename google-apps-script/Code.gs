/**
 * Niche Numbers 2.0 — Google Sheets connector
 *
 * One deployment can read and write any spreadsheet that the Google account
 * deploying this script can access. Replace CHANGE_ME before deployment.
 *
 * P3: read supports includeFormulas (GET query or POST body) and returns a
 * parallel `formulas` map keyed like `values` (rows of cells from getFormulas).
 */

const TOKEN = 'CHANGE_ME';
const DEFAULT_SHEET_ID = '';

function openSpreadsheet_(spreadsheetId) {
  if (spreadsheetId) return SpreadsheetApp.openById(spreadsheetId);
  if (DEFAULT_SHEET_ID) return SpreadsheetApp.openById(DEFAULT_SHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function truthy_(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function readRanges_(spreadsheet, ranges, includeFormulas) {
  const values = {};
  const formulas = includeFormulas ? {} : null;
  (ranges || []).forEach(function (range) {
    const rng = spreadsheet.getRange(range);
    values[range] = rng.getValues();
    if (includeFormulas) formulas[range] = rng.getFormulas();
  });
  if (includeFormulas) return { values: values, formulas: formulas };
  return { values: values };
}

function doGet(event) {
  try {
    const params = event.parameter || {};
    if (params.token !== TOKEN) return json_({ ok: false, error: 'Invalid token' });

    const spreadsheet = openSpreadsheet_(params.ssid);
    const action = params.action || 'read';

    if (action === 'list') {
      return json_({
        ok: true,
        spreadsheet: spreadsheet.getName(),
        sheets: spreadsheet.getSheets().map(function (sheet) {
          return {
            name: sheet.getName(),
            rows: sheet.getLastRow(),
            cols: sheet.getLastColumn()
          };
        })
      });
    }

    if (action === 'read') {
      const ranges = String(params.ranges || '')
        .split('|')
        .map(function (range) { return range.trim(); })
        .filter(Boolean);
      const includeFormulas = truthy_(params.includeFormulas);
      const packed = readRanges_(spreadsheet, ranges, includeFormulas);
      const out = {
        ok: true,
        spreadsheet: spreadsheet.getName(),
        values: packed.values
      };
      if (includeFormulas) out.formulas = packed.formulas;
      return json_(out);
    }

    return json_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}

function doPost(event) {
  try {
    const body = JSON.parse(event.postData.contents || '{}');
    if (body.token !== TOKEN) return json_({ ok: false, error: 'Invalid token' });

    const spreadsheet = openSpreadsheet_(body.ssid);

    if (body.action === 'read') {
      const includeFormulas = truthy_(body.includeFormulas);
      const packed = readRanges_(spreadsheet, body.ranges || [], includeFormulas);
      const out = {
        ok: true,
        spreadsheet: spreadsheet.getName(),
        values: packed.values
      };
      if (includeFormulas) out.formulas = packed.formulas;
      return json_(out);
    }

    if (body.action === 'write') {
      const writes = body.writes || [];
      writes.forEach(function (write) {
        if (!write.range || !Array.isArray(write.values)) {
          throw new Error('Every write needs a range and a two-dimensional values array.');
        }
        spreadsheet.getRange(write.range).setValues(write.values);
      });
      SpreadsheetApp.flush();
      return json_({
        ok: true,
        spreadsheet: spreadsheet.getName(),
        wrote: writes.length
      });
    }

    /* Create or clear a tab, then optionally write a full grid (promote scenario dump). */
    if (body.action === 'ensureSheet') {
      const name = String(body.sheetName || 'Scenario').replace(/[:\\/?*\[\]]/g, '').slice(0, 80) || 'Scenario';
      let sheet = spreadsheet.getSheetByName(name);
      if (!sheet) sheet = spreadsheet.insertSheet(name);
      if (body.clear) sheet.clear();
      const values = body.values || [];
      if (values.length) {
        const cols = values.reduce(function (m, row) { return Math.max(m, (row || []).length); }, 0);
        if (cols < 1) throw new Error('ensureSheet values need at least one column');
        const padded = values.map(function (row) {
          const r = (row || []).slice();
          while (r.length < cols) r.push('');
          return r;
        });
        sheet.getRange(1, 1, padded.length, cols).setValues(padded);
      }
      SpreadsheetApp.flush();
      return json_({
        ok: true,
        spreadsheet: spreadsheet.getName(),
        sheet: sheet.getName(),
        rows: values.length
      });
    }

    return json_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}
