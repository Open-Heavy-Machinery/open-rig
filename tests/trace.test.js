/* SPDX-License-Identifier: Apache-2.0 */
/* Tests of src/trace.js. Run in a browser: tests/index.html; CI runs it in headless Chrome. */
(function (root) {
  'use strict';
  var T = root.RigTrace;
  var results = [];

  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, message: String(e && e.message || e) }); }
  }
  function eq(actual, expected, what) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  }
  function near(actual, expected, what) {
    if (!(Math.abs(actual - expected) < 1e-9)) { throw new Error((what || 'value') + ': expected ' + expected + ', got ' + actual); }
  }

  var GOOD = 't_s,rpm,state,flag\n0.010,0.0,IDLE,0\n0.020,10.0,IDLE,1\n0.030,20.0,RUN,1\n';

  test('parses a trace written by open-tick', function () {
    var p = T.parseCsv(GOOD);
    eq(p.error, null, 'error');
    eq(p.names, ['t_s', 'rpm', 'state', 'flag'], 'names');
    eq(p.rows.length, 3, 'rows');
  });
  test('accepts CRLF line endings and a byte-order mark', function () {
    var p = T.parseCsv('﻿' + GOOD.replace(/\n/g, '\r\n'));
    eq(p.error, null, 'error');
    eq(p.names[0], 't_s', 'first name');
    eq(p.rows.length, 3, 'rows');
  });
  test('rejects a row with the wrong number of values and names the line', function () {
    var p = T.parseCsv('t_s,rpm\n0.0,1\n0.1\n');
    eq(p.error.line, 3, 'line');
  });
  test('rejects quotes, empty files, empty and repeated names', function () {
    eq(T.parseCsv('t_s,a\n0,"1"\n').error.line, 2, 'quotes');
    eq(!!T.parseCsv('').error, true, 'empty');
    eq(T.parseCsv('t_s,,b\n').error.line, 1, 'empty name');
    eq(T.parseCsv('t_s,a,a\n').error.line, 1, 'repeated name');
  });
  test('infers real, text and empty columns; empty cells of a real column are gaps', function () {
    var t = T.toTable(T.parseCsv('t_s,a,s,e\n0,1,X,\n1,,Y,\n2,3,X,\n'));
    eq(t.columns.map(function (c) { return c.kind; }), ['real', 'real', 'text', 'empty'], 'kinds');
    eq(isNaN(t.columns[1].values[1]), true, 'gap');
    eq(t.columns[1].values[2], 3, 'value');
  });
  test('nan and inf, as a C library prints them, are gaps and do not make a column text', function () {
    var t = T.toTable(T.parseCsv('t_s,a\n0,1\n1,nan\n2,-nan\n3,inf\n4,-inf\n5,2\n'));
    eq(t.columns[1].kind, 'real', 'kind');
    eq(Array.prototype.map.call(t.columns[1].values, function (v) { return isNaN(v); }), [false, true, true, true, true, false], 'gaps');
  });
  test('a column with one non-number is text', function () {
    var t = T.toTable(T.parseCsv('t_s,a\n0,1\n1,none\n'));
    eq(t.columns[1].kind, 'text', 'kind');
  });
  test('finds the time column, and rejects one that goes backwards', function () {
    var ok = T.load(GOOD);
    eq(ok.timeName, 't_s', 'time name');
    var bad = T.load('t_s,a\n0,1\n2,1\n1,1\n');
    eq(/decreases in row 3/.test(bad.error), true, 'message: ' + bad.error);
  });
  test('without t_s the first numeric column is the time', function () {
    eq(T.load('time,a\n0,1\n1,2\n').timeName, 'time', 'time name');
  });
  test('interpolates, and returns NaN outside the trace or at a gap', function () {
    var times = new Float64Array([0, 1, 2]);
    var v = new Float64Array([0, 10, NaN]);
    near(T.valueAt(times, v, 0.5), 5, 'middle');
    near(T.valueAt(times, v, 1), 10, 'sample');
    eq(isNaN(T.valueAt(times, v, 1.5)), true, 'gap');
    eq(isNaN(T.valueAt(times, v, -0.1)), true, 'before');
    eq(isNaN(T.valueAt(times, v, 2.1)), true, 'after');
  });
  test('indexAt gives the last sample at or before t', function () {
    var times = new Float64Array([0, 1, 2]);
    eq(T.indexAt(times, -1), -1, 'before');
    eq(T.indexAt(times, 1), 1, 'on a sample');
    eq(T.indexAt(times, 1.9), 1, 'between');
    eq(T.indexAt(times, 5), 2, 'after');
  });
  test('groups columns by the unit their name ends in', function () {
    eq(T.unitOf('rpm'), 'rpm', 'rpm');
    eq(T.unitOf('brake_nm'), 'nm', 'nm');
    eq(T.unitOf('pump_bar'), 'bar', 'bar');
    eq(T.unitOf('controlling_sa'), null, 'unknown');
    var l = T.load('t_s,rpm,brake_nm,load_nm,mode,key_on,sa\n0,1,2,3,A,0,5\n1,2,3,4,B,1,6\n');
    var layout = T.defaultLayout(l.table, l.timeName);
    eq(layout.panels.map(function (p) { return p.unit; }), ['rpm', 'N·m', ''], 'panel units');
    eq(layout.panels[1].columns, ['brake_nm', 'load_nm'], 'N·m columns');
    eq(layout.states, ['mode', 'key_on'], 'state strips');
  });
  test('a layout drops unknown columns and says so; text cannot go in a panel', function () {
    var l = T.load(GOOD);
    var r = T.applyLayout(l.table, { panels: [{ title: 'Speed', columns: ['rpm', 'nope', 'state'] }], states: ['state', 'missing'] }, l.timeName);
    eq(r.layout.panels[0].columns, ['rpm'], 'kept');
    eq(r.layout.states, ['state'], 'states');
    eq(r.warnings.length, 3, 'warnings: ' + r.warnings.join(' | '));
  });
  test('compares two traces on their shared columns, with an offset', function () {
    var a = T.load('t_s,x,only_a\n0,0,1\n1,10,1\n2,20,1\n');
    var b = T.load('t_s,x\n0,0\n1,12\n2,20\n');
    var d = T.compare(a, b, ['x', 'only_a'], 0);
    eq(d.length, 1, 'shared columns');
    near(d[0].max, 2, 'max');
    near(d[0].at, 1, 'at');
    var c = T.load('t_s,x\n1,0\n2,10\n3,20\n');
    var shifted = T.compare(a, c, ['x'], -1);
    near(shifted[0].max, 0, 'max with offset -1 s');
    eq(shifted[0].samples, 3, 'samples');
  });
  test('compare ignores samples outside the other trace', function () {
    var a = T.load('t_s,x\n0,0\n1,1\n2,2\n3,3\n');
    var b = T.load('t_s,x\n1,1\n2,2\n');
    var d = T.compare(a, b, ['x'], 0);
    eq(d[0].samples, 2, 'samples');
    near(d[0].max, 0, 'max');
  });

  root.RIG_TEST_RESULTS = results;
  if (typeof document !== 'undefined') {
    var failed = results.filter(function (r) { return !r.ok; });
    var out = document.getElementById('out');
    out.textContent = (failed.length === 0 ? 'PASS' : 'FAIL') + ': ' + (results.length - failed.length) + ' of ' + results.length + ' tests\n' +
      results.map(function (r) { return (r.ok ? '  ok    ' : '  FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.message); }).join('\n');
  }
}(typeof window !== 'undefined' ? window : globalThis));
