/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Reading a DBC file (the CAN dictionary format of Vector's CANdb++, read by
 * cantools and SavvyCAN), and decoding frames with it. Pure functions, no DOM.
 *
 * Supported: BO_ (messages), SG_ (signals: Intel @1 and Motorola @0, signed
 * and unsigned, factor, offset, min, max, unit), VAL_ (value tables), CM_
 * (comments), BA_DEF_ / BA_DEF_DEF_ / BA_ for ProtocolType, VFrameFormat and
 * GenMsgCycleTime. Not supported, and reported as warnings: multiplexed
 * signals (skipped), float signals (SIG_VALTYPE_, read as integers),
 * environment variables and any other section (ignored).
 *
 * Raw values are BigInt, so a 64-bit signal is exact; physical values are
 * numbers (factor * raw + offset).
 */
(function (root) {
  'use strict';

  var KNOWN = {
    VERSION: 1, NS_: 1, BS_: 1, BU_: 1, BO_: 1, SG_: 1, CM_: 1, BA_DEF_: 1, BA_DEF_DEF_: 1, BA_: 1, VAL_: 1,
    VAL_TABLE_: 1, BO_TX_BU_: 1, BA_DEF_REL_: 1, BA_REL_: 1, BA_DEF_DEF_REL_: 1, SIG_GROUP_: 1, SGTYPE_: 1
  };

  /* Splits the file into statements: a keyword and what follows it, up to the
   * next line that starts with a keyword. Quoted strings may span lines. */
  function statements(text) {
    var out = [];
    var src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var cur = null;
    var inQuote = false;
    lines.forEach(function (line, i) {
      if (!inQuote && /^\s*[A-Z][A-Z0-9_]*(\s|:|$)/.test(line)) {
        if (cur) { out.push(cur); }
        cur = { line: i + 1, text: line.trim() };
      } else if (cur) {
        cur.text += '\n' + line;
      }
      if ((line.match(/"/g) || []).length % 2 === 1) { inQuote = !inQuote; }
    });
    if (cur) { out.push(cur); }
    return out;
  }

  function unquote(s) { return s.replace(/^"/, '').replace(/"$/, ''); }

  var SG = /^SG_\s+(\w+)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,]+)\s*,\s*([^)]+)\)\s*\[\s*([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/;

  /** Reads a DBC. Returns { messages, byId, attributes, comment, warnings, error }. */
  function parseDbc(text) {
    var db = { messages: [], byFrameId: {}, attributes: {}, attrDefaults: {}, comment: '', warnings: [], error: null };
    var current = null;
    var floatSignals = 0;
    var skippedMux = 0;
    var unknown = {};
    try {
      statements(text).forEach(function (st) {
        var kw = /^([A-Z_][A-Z0-9_]*)/.exec(st.text)[1];
        var body = st.text;
        if (kw === 'BO_') {
          var m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(body);
          if (!m) { throw { line: st.line, message: 'a BO_ line that is not "BO_ <id> <name>: <length> <sender>"' }; }
          var raw = Number(m[1]);
          current = {
            dbcId: raw, extended: raw >= 0x80000000, id: raw >= 0x80000000 ? raw - 0x80000000 : raw,
            name: m[2], length: Number(m[3]), sender: m[4], signals: [], comment: '', attributes: {}
          };
          db.messages.push(current);
          db.byFrameId[raw] = current;
        } else if (kw === 'SG_') {
          if (!current) { throw { line: st.line, message: 'a signal before any message' }; }
          var s = SG.exec(body.replace(/\s*\n\s*/g, ' '));
          if (!s) { throw { line: st.line, message: 'a signal line this reader does not understand' }; }
          if (s[2]) { skippedMux++; return; }
          var sig = {
            name: s[1], start: Number(s[3]), size: Number(s[4]), littleEndian: s[5] === '1', signed: s[6] === '-',
            factor: Number(s[7]), offset: Number(s[8]), min: Number(s[9]), max: Number(s[10]), unit: s[11],
            receivers: s[12].trim(), choices: null, comment: ''
          };
          if (!(sig.size >= 1 && sig.size <= 64) || !isFinite(sig.factor) || !isFinite(sig.offset)) {
            throw { line: st.line, message: 'signal ' + sig.name + ' has a bad size, factor or offset' };
          }
          current.signals.push(sig);
        } else if (kw === 'VAL_') {
          var v = /^VAL_\s+(\d+)\s+(\w+)\s+([\s\S]*?)\s*;\s*$/.exec(body);
          if (!v) { return; } /* VAL_ of an environment variable: ignored */
          var msg = db.byFrameId[Number(v[1])];
          var target = msg && msg.signals.filter(function (x) { return x.name === v[2]; })[0];
          if (!target) { db.warnings.push('line ' + st.line + ': VAL_ for an unknown signal ' + v[2]); return; }
          target.choices = {};
          var re = /(-?\d+)\s+"([^"]*)"/g;
          var c;
          while ((c = re.exec(v[3])) !== null) { target.choices[c[1]] = c[2]; }
        } else if (kw === 'CM_') {
          var cm = /^CM_\s+(?:(BO_)\s+(\d+)\s+|(SG_)\s+(\d+)\s+(\w+)\s+|(BU_|EV_)\s+\w+\s+)?("[\s\S]*")\s*;\s*$/.exec(body);
          if (!cm) { return; }
          var txt = unquote(cm[7]);
          if (cm[1]) { var mo = db.byFrameId[Number(cm[2])]; if (mo) { mo.comment = txt; } }
          else if (cm[3]) {
            var ms = db.byFrameId[Number(cm[4])];
            var sg = ms && ms.signals.filter(function (x) { return x.name === cm[5]; })[0];
            if (sg) { sg.comment = txt; }
          } else if (!cm[6]) { db.comment = txt; }
        } else if (kw === 'BA_DEF_DEF_') {
          var d = /^BA_DEF_DEF_\s+"(\w+)"\s+(.*?)\s*;\s*$/.exec(body);
          if (d) { db.attrDefaults[d[1]] = unquote(d[2]); }
        } else if (kw === 'BA_') {
          var a = /^BA_\s+"(\w+)"\s+(?:(BO_)\s+(\d+)\s+)?(.*?)\s*;\s*$/.exec(body);
          if (!a) { return; }
          var value = unquote(a[4]);
          if (a[2]) { var mb = db.byFrameId[Number(a[3])]; if (mb) { mb.attributes[a[1]] = value; } }
          else if (!/^(SG_|BU_|EV_)\s/.test(a[4])) { db.attributes[a[1]] = value; }
        } else if (kw === 'SIG_VALTYPE_') {
          floatSignals++;
        } else if (kw === 'EV_') {
          unknown.EV_ = true;
        } else if (!KNOWN[kw]) {
          unknown[kw] = true;
        }
      });
    } catch (e) {
      return { messages: [], byFrameId: {}, attributes: {}, attrDefaults: {}, comment: '', warnings: [], error: { line: e.line, message: e.message } };
    }
    if (skippedMux) { db.warnings.push(skippedMux + ' multiplexed signals skipped (not supported)'); }
    if (floatSignals) { db.warnings.push('float signals (SIG_VALTYPE_) are read as integers'); }
    Object.keys(unknown).forEach(function (k) { db.warnings.push('section ' + k + ' ignored'); });
    if (db.messages.length === 0) { return { messages: [], byFrameId: {}, attributes: {}, attrDefaults: {}, comment: '', warnings: [], error: { line: 1, message: 'no messages (BO_) in the file' } }; }
    db.j1939 = (db.attributes.ProtocolType || db.attrDefaults.ProtocolType) === 'J1939';
    db.messages.forEach(function (m) {
      var fmt = m.attributes.VFrameFormat !== undefined ? m.attributes.VFrameFormat : db.attrDefaults.VFrameFormat;
      m.j1939 = db.j1939 && m.extended && (fmt === undefined || fmt === '3' || fmt === 'J1939PG');
      var cyc = m.attributes.GenMsgCycleTime !== undefined ? m.attributes.GenMsgCycleTime : db.attrDefaults.GenMsgCycleTime;
      m.cycleMs = cyc !== undefined && Number(cyc) > 0 ? Number(cyc) : null;
    });
    return db;
  }

  /** The raw value of a signal (BigInt), or null if it does not fit the data. */
  function rawValue(sig, data) {
    var value = 0n;
    if (sig.littleEndian) {
      if (sig.start + sig.size > data.length * 8) { return null; }
      for (var i = sig.size - 1; i >= 0; i--) {
        var bit = sig.start + i;
        value = (value << 1n) | BigInt((data[bit >> 3] >> (bit & 7)) & 1);
      }
    } else {
      /* Motorola: start is the most significant bit, in DBC's sawtooth numbering */
      var b = sig.start;
      for (var k = 0; k < sig.size; k++) {
        if ((b >> 3) >= data.length || b < 0) { return null; }
        value = (value << 1n) | BigInt((data[b >> 3] >> (b & 7)) & 1);
        b = (b % 8 === 0) ? b + 15 : b - 1;
      }
    }
    if (sig.signed && sig.size > 0 && (value >> BigInt(sig.size - 1)) & 1n) { value -= 1n << BigInt(sig.size); }
    return value;
  }

  /** Every signal of `message` in `data`: name, raw (BigInt), value (number), unit, choice text. */
  function decodeSignals(message, data) {
    return message.signals.map(function (s) {
      var raw = rawValue(s, data);
      if (raw === null) { return { name: s.name, raw: null, value: null, unit: s.unit, choice: null, signal: s }; }
      var value = Number(raw) * s.factor + s.offset;
      var choice = s.choices && s.choices[String(raw)] !== undefined ? s.choices[String(raw)] : null;
      return { name: s.name, raw: raw, value: value, unit: s.unit, choice: choice, signal: s };
    });
  }

  var api = { parseDbc: parseDbc, rawValue: rawValue, decodeSignals: decodeSignals };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.RigDbc = api;
}(typeof window !== 'undefined' ? window : globalThis));
