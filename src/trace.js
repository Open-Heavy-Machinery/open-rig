/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Reading open-tick traces. Pure functions, no DOM: the page (viewer.js) and
 * the tests (tests/) both use them. The format is documented in open-tick,
 * docs/trace-format.md: a header line of column names, then one row per step,
 * comma-separated, no quotes; an empty cell means "no value in this row".
 * Also the oracle's verdict files (open-tick docs/verdict-format.md): parseVerdicts.
 */
(function (root) {
  'use strict';

  /* what a C library prints for NaN and infinity; read as a gap (trace-format.md) */
  var NOT_FINITE = /^[+-]?(nan|inf|infinity)$/i;

  var UNITS = { rpm: 'rpm', nm: 'N·m', pct: '%', bar: 'bar', kpa: 'kPa', c: '°C', frac: 'fraction' };

  /** Splits the text into a header and rows of strings. Never throws. */
  function parseCsv(text) {
    var src = String(text).replace(/^﻿/, '');
    var lines = src.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
    lines = lines.map(function (l) { return l.replace(/\r$/, ''); });
    if (lines.length === 0) { return fail(1, 'the file is empty'); }
    var names = lines[0].split(',');
    var seen = {};
    for (var i = 0; i < names.length; i++) {
      if (names[i] === '') { return fail(1, 'column ' + (i + 1) + ' has no name'); }
      if (seen[names[i]]) { return fail(1, 'the column "' + names[i] + '" appears twice'); }
      seen[names[i]] = true;
    }
    var rows = [];
    for (var n = 1; n < lines.length; n++) {
      var line = lines[n];
      if (line.indexOf('"') >= 0) {
        return fail(n + 1, 'quotes are not part of the trace format');
      }
      var cells = line.split(',');
      if (cells.length !== names.length) {
        return fail(n + 1, 'has ' + cells.length + ' values, the header has ' + names.length);
      }
      rows.push(cells);
    }
    return { names: names, rows: rows, error: null };
  }

  function fail(line, message) {
    return { names: [], rows: [], error: { line: line, message: message } };
  }

  /**
   * Turns parsed rows into columns. A column is "real" when every non-empty
   * cell is a number, "text" when any is not, and "empty" when it has no
   * value at all. Empty cells of a real column become NaN.
   */
  function toTable(parsed) {
    var columns = [];
    for (var c = 0; c < parsed.names.length; c++) {
      var raw = new Array(parsed.rows.length);
      var allNumbers = true;
      var anyValue = false;
      for (var r = 0; r < parsed.rows.length; r++) {
        var s = parsed.rows[r][c];
        raw[r] = s;
        if (s !== '') {
          anyValue = true;
          if (!isFinite(Number(s)) && !NOT_FINITE.test(s)) { allNumbers = false; }
        }
      }
      var col = { name: parsed.names[c], kind: 'empty' };
      if (anyValue && allNumbers) {
        col.kind = 'real';
        col.values = new Float64Array(raw.length);
        for (var k = 0; k < raw.length; k++) { col.values[k] = (raw[k] === '' || NOT_FINITE.test(raw[k])) ? NaN : Number(raw[k]); }
      } else if (anyValue) {
        col.kind = 'text';
        col.values = raw;
      }
      columns.push(col);
    }
    return { columns: columns, length: parsed.rows.length };
  }

  function column(table, name) {
    for (var i = 0; i < table.columns.length; i++) {
      if (table.columns[i].name === name) { return table.columns[i]; }
    }
    return null;
  }

  /** The time column: the hint if given, else "t_s", else the first real column. */
  function timeColumn(table, hint) {
    var col = (hint && column(table, hint)) || column(table, 't_s');
    if (!col) {
      for (var i = 0; i < table.columns.length; i++) {
        if (table.columns[i].kind === 'real') { col = table.columns[i]; break; }
      }
    }
    if (!col || col.kind !== 'real') { return { error: 'no numeric time column (the format expects "t_s")' }; }
    for (var j = 0; j < col.values.length; j++) {
      if (isNaN(col.values[j])) { return { error: 'the time column "' + col.name + '" has an empty cell in row ' + (j + 1) }; }
      if (j > 0 && col.values[j] < col.values[j - 1]) {
        return { error: 'the time column "' + col.name + '" decreases in row ' + (j + 1) };
      }
    }
    return { name: col.name, values: col.values };
  }

  /** Linear interpolation of a real column at time t; NaN outside the trace or at a gap. */
  function valueAt(times, values, t) {
    var n = times.length;
    if (n === 0 || t < times[0] || t > times[n - 1]) { return NaN; }
    var lo = 0;
    var hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= t) { lo = mid; } else { hi = mid; }
    }
    var t0 = times[lo];
    var t1 = times[hi];
    var v0 = values[lo];
    var v1 = values[hi];
    if (t === t0) { return v0; }
    if (t === t1) { return v1; }
    if (isNaN(v0) || isNaN(v1)) { return NaN; }
    return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }

  /** Index of the last sample at or before t, or -1. */
  function indexAt(times, t) {
    var n = times.length;
    if (n === 0 || t < times[0]) { return -1; }
    var lo = 0;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) { lo = mid; } else { hi = mid - 1; }
    }
    return lo;
  }

  function unitOf(name) {
    var m = /(?:^|_)([a-z]+)$/.exec(name);
    return m && UNITS[m[1]] ? m[1] : null;
  }

  function isFlag(col) {
    if (col.kind !== 'real') { return false; }
    for (var i = 0; i < col.values.length; i++) {
      var v = col.values[i];
      if (!isNaN(v) && v !== 0 && v !== 1) { return false; }
    }
    return true;
  }

  /**
   * Panels when there is no layout: real columns grouped by the unit their
   * name ends in (rpm, _nm, _pct, _bar, _kpa, _c, _frac), the rest in "other".
   * Columns with only 0 and 1 and every text column become state strips.
   */
  function defaultLayout(table, timeName) {
    var groups = {};
    var order = [];
    var states = [];
    table.columns.forEach(function (col) {
      if (col.name === timeName || col.kind === 'empty') { return; }
      if (col.kind === 'text' || isFlag(col)) { states.push(col.name); return; }
      var u = unitOf(col.name) || 'other';
      if (!groups[u]) { groups[u] = []; order.push(u); }
      groups[u].push(col.name);
    });
    return {
      time: timeName,
      panels: order.map(function (u) {
        return { title: u === 'other' ? 'Other signals' : UNITS[u], unit: u === 'other' ? '' : UNITS[u], columns: groups[u] };
      }),
      states: states
    };
  }

  /**
   * Checks a layout against a table. Returns the layout with unknown columns
   * removed and a list of warnings that name them.
   */
  function applyLayout(table, layout, timeName) {
    var warnings = [];
    function known(name, where) {
      var col = column(table, name);
      if (!col || col.kind === 'empty') {
        warnings.push('the layout names "' + name + '" in ' + where + ', which is not in the trace');
        return false;
      }
      return true;
    }
    var out = { time: layout.time || timeName, panels: [], states: [] };
    (layout.panels || []).forEach(function (p, i) {
      var cols = (p.columns || []).filter(function (n) {
        if (!known(n, 'panel ' + (i + 1))) { return false; }
        if (column(table, n).kind !== 'real') {
          warnings.push('"' + n + '" is text and cannot go in a panel; put it in "states"');
          return false;
        }
        return true;
      });
      if (cols.length > 0) { out.panels.push({ title: p.title || '', unit: p.unit || '', columns: cols }); }
    });
    (layout.states || []).forEach(function (n) { if (known(n, 'states')) { out.states.push(n); } });
    return { layout: out, warnings: warnings };
  }

  /**
   * Difference of two traces on the columns they share. B is sampled at A's
   * times, shifted by offsetB seconds, where B has a value. Returns, for each
   * shared real column, the largest absolute difference, when it happens and
   * the root mean square over the compared samples.
   */
  function compare(a, b, names, offsetB) {
    var shift = offsetB || 0;
    var timesB = new Float64Array(b.times.length);
    for (var i = 0; i < timesB.length; i++) { timesB[i] = b.times[i] + shift; }
    var out = [];
    names.forEach(function (name) {
      var ca = column(a.table, name);
      var cb = column(b.table, name);
      if (!ca || !cb || ca.kind !== 'real' || cb.kind !== 'real') { return; }
      var max = 0;
      var at = NaN;
      var sum = 0;
      var n = 0;
      for (var k = 0; k < a.times.length; k++) {
        if (isNaN(ca.values[k])) { continue; }
        var vb = valueAt(timesB, cb.values, a.times[k]);
        if (isNaN(vb)) { continue; }
        var d = Math.abs(ca.values[k] - vb);
        if (d > max || n === 0) { max = d; at = a.times[k]; }
        sum += d * d;
        n++;
      }
      if (n > 0) { out.push({ name: name, max: max, at: at, rms: Math.sqrt(sum / n), samples: n }); }
    });
    return out;
  }

  /** Reads text into { table, times, timeName } or { error }. */
  function load(text, timeHint) {
    var parsed = parseCsv(text);
    if (parsed.error) { return { error: 'line ' + parsed.error.line + ': ' + parsed.error.message }; }
    var table = toTable(parsed);
    if (table.length === 0) { return { error: 'the trace has a header and no rows' }; }
    var t = timeColumn(table, timeHint);
    if (t.error) { return { error: t.error }; }
    return { table: table, times: t.values, timeName: t.name };
  }

  /* ------------------------------------------------------------ verdict files */

  /*
   * The oracle's verdicts, as open-tick writes them (open-tick docs/verdict-format.md, since v0.2.1):
   * a header, then one row per criterion. Columns are found by name; `text` is the last column and
   * takes the rest of the line, so it may contain commas. Times are seconds on the trace's axis.
   */
  var VERDICT_COLUMNS = ['id', 'verdict', 'status', 'from_s', 'until_s', 'event', 'event_s', 'reaction', 'reaction_ms', 'fail_s', 'text'];
  var STATUSES = { ok: true, violated: true, not_evaluated: true, not_covered: true };
  var REACTIONS = { '': true, measured: true, not_measured: true, not_holding: true };

  function seconds(field, what, line, required) {
    if (field === '') {
      if (required) { throw { line: line, message: what + ' is empty' }; }
      return null;
    }
    var v = Number(field);
    if (!isFinite(v)) { throw { line: line, message: what + ' is not a number: "' + field + '"' }; }
    return v;
  }

  /** Reads a verdict file into { criteria: [...], error: null } or { criteria: [], error: { line, message } }. Never throws. */
  function parseVerdicts(text) {
    var lines = String(text).replace(/^\uFEFF/, '').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
    lines = lines.map(function (l) { return l.replace(/\r$/, ''); });
    if (lines.length === 0) { return { criteria: [], error: { line: 1, message: 'the file is empty' } }; }
    var names = lines[0].split(',');
    if (names[names.length - 1] !== 'text') {
      return { criteria: [], error: { line: 1, message: 'not a verdict file: the last column must be "text"' } };
    }
    var at = {};
    names.forEach(function (n, i) { at[n] = i; });
    for (var k = 0; k < VERDICT_COLUMNS.length; k++) {
      if (at[VERDICT_COLUMNS[k]] === undefined) {
        return { criteria: [], error: { line: 1, message: 'not a verdict file: no column "' + VERDICT_COLUMNS[k] + '"' } };
      }
    }
    var fixed = names.length - 1; /* fields before text */
    var criteria = [];
    try {
      for (var i = 1; i < lines.length; i++) {
        var line = i + 1;
        var parts = lines[i].split(',');
        if (parts.length < names.length) { throw { line: line, message: 'expected ' + names.length + ' fields' }; }
        var f = parts.slice(0, fixed);
        f.push(parts.slice(fixed).join(','));
        var get = function (n) { return f[at[n]]; };
        var c = {
          id: get('id'), verdict: get('verdict'), status: get('status'),
          from: seconds(get('from_s'), 'from_s', line, true), until: seconds(get('until_s'), 'until_s', line, true),
          event: get('event'), eventT: seconds(get('event_s'), 'event_s', line, false),
          reaction: get('reaction'), reactionMs: seconds(get('reaction_ms'), 'reaction_ms', line, false),
          failT: seconds(get('fail_s'), 'fail_s', line, false), text: get('text')
        };
        if (c.id === '') { throw { line: line, message: 'empty id' }; }
        if (c.verdict !== 'PASS' && c.verdict !== 'FAIL') { throw { line: line, message: 'verdict must be PASS or FAIL, not "' + c.verdict + '"' }; }
        if (!STATUSES[c.status]) { throw { line: line, message: 'unknown status "' + c.status + '"' }; }
        if (!REACTIONS[c.reaction]) { throw { line: line, message: 'unknown reaction "' + c.reaction + '"' }; }
        if ((c.verdict === 'PASS') !== (c.status === 'ok')) { throw { line: line, message: 'verdict ' + c.verdict + ' with status ' + c.status }; }
        if (c.until < c.from) { throw { line: line, message: 'until_s is before from_s' }; }
        /* where the reaction ended, on the trace's axis */
        c.reactionEnd = (c.reaction === 'measured' && c.eventT !== null && c.reactionMs !== null) ? c.eventT + c.reactionMs / 1000 : null;
        criteria.push(c);
      }
    } catch (e) {
      return { criteria: [], error: { line: e.line, message: e.message } };
    }
    if (criteria.length === 0) { return { criteria: [], error: { line: 1, message: 'the file has a header and no criteria' } }; }
    return { criteria: criteria, error: null };
  }

  var api = {
    parseCsv: parseCsv, toTable: toTable, column: column, timeColumn: timeColumn, valueAt: valueAt,
    indexAt: indexAt, unitOf: unitOf, isFlag: isFlag, defaultLayout: defaultLayout,
    applyLayout: applyLayout, compare: compare, load: load, parseVerdicts: parseVerdicts, UNITS: UNITS
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.RigTrace = api;
}(typeof window !== 'undefined' ? window : globalThis));
