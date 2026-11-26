/* SPDX-License-Identifier: Apache-2.0 */
/**
 * A small SAE J1939 layer for the bus view: what a DBC cannot say. Pure
 * functions, no DOM. Used only when the DBC says ProtocolType "J1939".
 *
 * - The parts of a 29-bit identifier: priority, PGN (PDU1 with the
 *   destination stripped, PDU2 whole), source and destination address.
 * - Matching a frame with a DBC message by PGN (and source address when two
 *   messages share a PGN), as J1939 tools do.
 * - BAM reassembly (J1939-21: TP.CM control byte 32, then TP.DT packets), per
 *   source address, with T1 (750 ms) between packets. RTS/CTS is not handled.
 * - DM1 (J1939-73): the four lamps and the list of trouble codes, with the
 *   failure mode's standard text.
 * - TSC1 (J1939-71) byte 8: message counter (SPN 4206) and checksum (SPN 4207),
 *   and whether the counter moved by one since the last TSC1 from the same
 *   source, as open-crank's tsc1_intact observable checks it.
 */
(function (root) {
  'use strict';

  var PGN_TP_CM = 0xEC00;
  var PGN_TP_DT = 0xEB00;
  var PGN_DM1 = 0xFECA;
  var PGN_TSC1 = 0x0000;
  var TP_CM_BAM = 32;
  var T1_S = 0.75;

  var LAMPS = ['off', 'on', 'reserved', 'not available'];

  /* J1939-73 failure mode identifiers */
  var FMI = {
    0: 'above normal, most severe', 1: 'below normal, most severe', 2: 'erratic, intermittent or incorrect',
    3: 'voltage above normal or shorted high', 4: 'voltage below normal or shorted low', 5: 'current below normal or open circuit',
    6: 'current above normal or grounded circuit', 7: 'mechanical system not responding or out of adjustment',
    8: 'abnormal frequency, pulse width or period', 9: 'abnormal update rate', 10: 'abnormal rate of change',
    11: 'root cause not known', 12: 'bad intelligent device or component', 13: 'out of calibration',
    14: 'special instructions', 15: 'above normal, least severe', 16: 'above normal, moderately severe',
    17: 'below normal, least severe', 18: 'below normal, moderately severe', 19: 'received network data in error',
    20: 'data drifted high', 21: 'data drifted low', 31: 'condition exists'
  };

  /** Priority, PGN, source and destination of a 29-bit identifier. */
  function parts(id) {
    var pf = (id >> 16) & 0xFF;
    var ps = (id >> 8) & 0xFF;
    var dp = (id >> 24) & 0x01;
    var edp = (id >> 25) & 0x01;
    var pdu1 = pf < 240;
    var pgn = (edp << 17) | (dp << 16) | (pf << 8) | (pdu1 ? 0 : ps);
    return { priority: (id >> 26) & 0x07, pgn: pgn, source: id & 0xFF, dest: pdu1 ? ps : 0xFF, pdu1: pdu1 };
  }

  /** The DBC message for a frame: by PGN for J1939 messages (preferring the same source), else by identifier. */
  function messageFor(db, frame) {
    var dbcId = frame.ext ? frame.id + 0x80000000 : frame.id;
    if (db.byFrameId[dbcId]) { return db.byFrameId[dbcId]; }
    if (!db.j1939 || !frame.ext) { return null; }
    var p = parts(frame.id);
    var best = null;
    db.messages.forEach(function (m) {
      if (!m.j1939) { return; }
      var q = parts(m.id);
      if (q.pgn !== p.pgn) { return; }
      if (!best || (q.source === p.source && parts(best.id).source !== p.source)) { best = m; }
    });
    return best;
  }

  /** DM1 bytes: lamps and trouble codes. An all-zero code, or SPN and FMI "not available", is no code. */
  function decodeDm1(bytes) {
    if (bytes.length < 6) { return null; }
    var b0 = bytes[0];
    var out = {
      mil: LAMPS[(b0 >> 6) & 3], redStop: LAMPS[(b0 >> 4) & 3], amberWarning: LAMPS[(b0 >> 2) & 3], protect: LAMPS[b0 & 3],
      dtcs: []
    };
    for (var k = 2; k + 4 <= bytes.length; k += 4) {
      var spn = bytes[k] | (bytes[k + 1] << 8) | (((bytes[k + 2] >> 5) & 7) << 16);
      var fmi = bytes[k + 2] & 0x1F;
      var oc = bytes[k + 3] & 0x7F;
      var allZero = bytes[k] === 0 && bytes[k + 1] === 0 && bytes[k + 2] === 0 && bytes[k + 3] === 0;
      var notAvail = spn === 0x7FFFF && fmi === 0x1F;
      if (allZero || notAvail) { continue; }
      out.dtcs.push({ spn: spn, fmi: fmi, fmiText: FMI[fmi] || 'reserved', oc: oc });
    }
    return out;
  }

  /** TSC1 checksum (SPN 4207): data bytes 0-6, the counter and the four identifier bytes, folded to 4 bits. */
  function tsc1Checksum(id, data, counter) {
    var sum = 0;
    for (var i = 0; i < 7; i++) { sum += data[i]; }
    sum += counter & 0x0F;
    sum += (id & 0xFF) + ((id >> 8) & 0xFF) + ((id >> 16) & 0xFF) + ((id >>> 24) & 0xFF);
    return ((sum >> 4) + sum) & 0x0F;
  }

  /**
   * Goes through the frames in time order once and returns what depends on
   * more than one frame, keyed by frame index:
   *   bam[index]  = { pgn, bytes, dm1?, packets, complete, why? } on the TP.CM and every TP.DT of a transfer
   *   tsc1[index] = { counter, checksum, expected, checksumOk, step, intact }
   * Only frames that reached their receiver count (lost frames never did).
   */
  function analyse(sorted) {
    var bam = {};
    var tsc1 = {};
    var open = {};      /* per dir + source: the BAM in progress */
    var lastTsc1 = {};  /* per dir + source: last counter */
    sorted.forEach(function (f) {
      if (!f.ext || f.lost) { return; }
      var p = parts(f.id);
      var key = f.dir + ':' + p.source;
      if (p.pgn === PGN_TP_CM && f.len >= 8 && f.data[0] === TP_CM_BAM) {
        if (open[key] && !open[key].done) { open[key].info.complete = false; open[key].info.why = 'a new BAM started before this one ended'; }
        var size = f.data[1] | (f.data[2] << 8);
        var info = { pgn: f.data[5] | (f.data[6] << 8) | (f.data[7] << 16), size: size, packets: f.data[3], received: 0, complete: false, why: 'not all packets arrived', bytes: null, dm1: null, frames: [f.index] };
        open[key] = { info: info, buf: new Uint8Array(f.data[3] * 7), next: 1, lastT: f.t, done: false };
        bam[f.index] = info;
      } else if (p.pgn === PGN_TP_DT && f.len >= 1) {
        var o = open[key];
        if (!o || o.done) { return; }
        var info2 = o.info;
        bam[f.index] = info2;
        info2.frames.push(f.index);
        if (f.t - o.lastT > T1_S) { o.done = true; info2.why = 'more than 750 ms (T1) between two packets'; return; }
        if (f.data[0] !== o.next) { o.done = true; info2.why = 'packet ' + f.data[0] + ' arrived where ' + o.next + ' was due'; return; }
        for (var i = 1; i < f.len && i < 8; i++) { o.buf[(o.next - 1) * 7 + (i - 1)] = f.data[i]; }
        info2.received = o.next;
        o.next++;
        o.lastT = f.t;
        if (info2.received === info2.packets) {
          o.done = true;
          info2.complete = true;
          info2.why = null;
          info2.bytes = o.buf.slice(0, info2.size);
          if (info2.pgn === PGN_DM1) { info2.dm1 = decodeDm1(info2.bytes); }
        }
      } else if (p.pgn === PGN_TSC1 && f.len >= 8) {
        var counter = f.data[7] & 0x0F;
        var checksum = (f.data[7] >> 4) & 0x0F;
        var expected = tsc1Checksum(f.id, f.data, counter);
        var prev = lastTsc1[key];
        var step = prev === undefined ? null : (counter - prev + 16) % 16;
        tsc1[f.index] = {
          counter: counter, checksum: checksum, expected: expected, checksumOk: checksum === expected, step: step,
          intact: checksum === expected && (step === null || step === 1)
        };
        lastTsc1[key] = counter;
      }
    });
    return { bam: bam, tsc1: tsc1 };
  }

  var api = {
    parts: parts, messageFor: messageFor, decodeDm1: decodeDm1, tsc1Checksum: tsc1Checksum, analyse: analyse,
    PGN_DM1: PGN_DM1, PGN_TSC1: PGN_TSC1, PGN_TP_CM: PGN_TP_CM, PGN_TP_DT: PGN_TP_DT
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  root.RigJ1939 = api;
}(typeof window !== 'undefined' ? window : globalThis));
