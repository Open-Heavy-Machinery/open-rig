/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Reading open-tick frame logs (open-tick docs/frame-log-format.md, version 1).
 * Pure functions, no DOM.
 *
 * A frame log has a metadata line ("# otk-frame-log 1; step_ns=...; bus_clock=...;
 * bus_clock_err_ns=...; source=..."), a header, and one row per CAN frame with two
 * times: t_s (logical: the step; it places the frame on the time axis) and t_bus_s
 * (measured on the bus by the clock the metadata names; empty when not measured or
 * never on the bus). Rows are in the order each frame's fate became known; this
 * reader also gives them sorted by t_s (stable).
 */
(function (root) {
  'use strict';

  var COLUMNS = ['t_s', 't_bus_s', 'dir', 'link', 'id', 'flags', 'len', 'data', 'fault'];
  var DIRS = { to_dut: true, from_dut: true };
  var FAULTS = { '': true, drop: true, drop_one_in: true, bus_off: true, overflow: true, corrupt: true };
  var LOST = { drop: true, drop_one_in: true, bus_off: true, overflow: true };
  var CLOCKS = { none: true, sim: true, kernel: true, host: true, bridge: true };
  var TIME = /^\d+\.\d{9}$/;

  function fail(line, message) { return { meta: null, frames: [], sorted: [], error: { line: line, message: message } }; }

  /* Seconds with nine decimals, as integer nanoseconds (exact) and as a number. */
  function time(text) {
    var dot = text.indexOf('.');
    return { ns: BigInt(text.slice(0, dot)) * 1000000000n + BigInt(text.slice(dot + 1)), s: Number(text) };
  }

  function parseMeta(line) {
    var m = /^# otk-frame-log (\d+)(;.*)?$/.exec(line);
    if (!m) { return { error: 'the first line is not "# otk-frame-log <version>; ..."' }; }
    var version = Number(m[1]);
    if (version !== 1) { return { error: 'frame log version ' + version + ' is not one this reader knows (1)' }; }
    var meta = { version: version, keys: {} };
    (m[2] || '').split(';').forEach(function (kv) {
      kv = kv.trim();
      if (kv === '') { return; }
      var eq = kv.indexOf('=');
      if (eq > 0) { meta.keys[kv.slice(0, eq)] = kv.slice(eq + 1); }
    });
    var k = meta.keys;
    if (!/^\d+$/.test(k.step_ns || '') || Number(k.step_ns) <= 0) { return { error: 'step_ns is missing or not a positive integer' }; }
    if (!CLOCKS[k.bus_clock]) { return { error: 'bus_clock "' + (k.bus_clock || '') + '" is not sim, kernel, host, bridge or none' }; }
    if (k.bus_clock_err_ns === undefined || !/^(\d+)?$/.test(k.bus_clock_err_ns)) { return { error: 'bus_clock_err_ns is missing or not an integer' }; }
    meta.stepNs = Number(k.step_ns);
    meta.busClock = k.bus_clock;
    meta.busClockErrNs = k.bus_clock_err_ns === '' ? null : Number(k.bus_clock_err_ns);
    meta.source = k.source || '';
    return { meta: meta };
  }

  /** Reads a frame log. Never throws: an error names the line. */
  function parseFrameLog(text) {
    var lines = String(text).replace(/^﻿/, '').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
    lines = lines.map(function (l) { return l.replace(/\r$/, ''); });
    if (lines.length < 2) { return fail(1, 'a frame log needs a metadata line and a header'); }
    var pm = parseMeta(lines[0]);
    if (pm.error) { return fail(1, pm.error); }
    var names = lines[1].split(',');
    var at = {};
    names.forEach(function (n, i) { at[n] = i; });
    for (var c = 0; c < COLUMNS.length; c++) {
      if (at[COLUMNS[c]] === undefined) { return fail(2, 'the header has no column "' + COLUMNS[c] + '"'); }
    }
    var frames = [];
    for (var n = 2; n < lines.length; n++) {
      var lineNo = n + 1;
      var f = lines[n].split(',');
      if (lines[n].indexOf('"') >= 0) { return fail(lineNo, 'quotes are not part of the format'); }
      if (f.length !== names.length) { return fail(lineNo, 'has ' + f.length + ' values, the header has ' + names.length); }
      var get = function (k) { return f[at[k]]; };
      if (!TIME.test(get('t_s'))) { return fail(lineNo, 't_s "' + get('t_s') + '" is not seconds with nine decimals'); }
      if (get('t_bus_s') !== '' && !TIME.test(get('t_bus_s'))) { return fail(lineNo, 't_bus_s "' + get('t_bus_s') + '" is not seconds with nine decimals'); }
      if (!DIRS[get('dir')]) { return fail(lineNo, 'dir "' + get('dir') + '" is not to_dut or from_dut'); }
      if (!FAULTS[get('fault')]) { return fail(lineNo, 'unknown fault "' + get('fault') + '"'); }
      var flags = get('flags');
      if (!/^x?f?b?$/.test(flags)) { return fail(lineNo, 'flags "' + flags + '" are not x, f, b in that order'); }
      var ext = flags.indexOf('x') >= 0;
      var idText = get('id');
      if (!(ext ? /^[0-9A-F]{8}$/ : /^[0-9A-F]{3}$/).test(idText)) { return fail(lineNo, 'id "' + idText + '" is not ' + (ext ? '8' : '3') + ' upper-case hex digits'); }
      var id = parseInt(idText, 16);
      if (id > (ext ? 0x1FFFFFFF : 0x7FF)) { return fail(lineNo, 'id ' + idText + ' is out of range'); }
      if (!/^\d+$/.test(get('len'))) { return fail(lineNo, 'len "' + get('len') + '" is not a number'); }
      var len = Number(get('len'));
      if (len > 64 || (flags.indexOf('f') < 0 && len > 8)) { return fail(lineNo, 'len ' + len + ' is too long for the frame'); }
      var hex = get('data');
      if (hex.length !== 2 * len || !/^[0-9A-F]*$/.test(hex)) { return fail(lineNo, 'data is not ' + len + ' bytes of upper-case hex'); }
      var data = new Uint8Array(len);
      for (var b = 0; b < len; b++) { data[b] = parseInt(hex.substr(2 * b, 2), 16); }
      var t = time(get('t_s'));
      var tb = get('t_bus_s') === '' ? null : time(get('t_bus_s'));
      frames.push({
        index: frames.length, line: lineNo, t: t.s, tNs: t.ns, tBus: tb ? tb.s : null, tBusNs: tb ? tb.ns : null,
        dir: get('dir'), link: get('link'), id: id, ext: ext, fd: flags.indexOf('f') >= 0, brs: flags.indexOf('b') >= 0,
        len: len, data: data, hex: hex, fault: get('fault'), lost: !!LOST[get('fault')]
      });
    }
    var sorted = frames.slice().sort(function (a, b) { return a.tNs < b.tNs ? -1 : a.tNs > b.tNs ? 1 : a.index - b.index; });
    return { meta: pm.meta, frames: frames, sorted: sorted, error: null };
  }

  /** t_bus_s − t_s in milliseconds, exact (from the integers), or null. */
  function latencyMs(frame) {
    if (frame.tBusNs === null) { return null; }
    return Number(frame.tBusNs - frame.tNs) / 1e6;
  }

  /** Index of the last frame in `sorted` whose t is at or before `t` (−1 if none). */
  function indexAtTime(sorted, t) {
    var lo = 0, hi = sorted.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (sorted[mid].t <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  var api = { parseFrameLog: parseFrameLog, latencyMs: latencyMs, indexAtTime: indexAtTime, COLUMNS: COLUMNS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.RigFrames = api;
}(typeof window !== 'undefined' ? window : globalThis));
