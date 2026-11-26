/* SPDX-License-Identifier: Apache-2.0 */
/* Tests of src/framelog.js, src/dbc.js and src/j1939.js. Run after trace.test.js, in tests/index.html; CI runs it in headless Chrome. */
(function (root) {
  'use strict';
  var F = root.RigFrames;
  var D = root.RigDbc;
  var J = root.RigJ1939;
  var results = root.RIG_TEST_RESULTS || [];

  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, message: String(e && e.message || e) }); }
  }
  function eq(actual, expected, what) {
    var a = JSON.stringify(actual, function (k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; });
    var e = JSON.stringify(expected, function (k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; });
    if (a !== e) { throw new Error((what || 'value') + ': expected ' + e + ', got ' + a); }
  }
  function near(actual, expected, what) {
    if (!(Math.abs(actual - expected) < 1e-9)) { throw new Error((what || 'value') + ': expected ' + expected + ', got ' + actual); }
  }
  function bytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) { out[i] = parseInt(hex.substr(2 * i, 2), 16); }
    return out;
  }

  /* ---------------------------------------------------------------- frame log */

  var META = '# otk-frame-log 1; step_ns=10000000; bus_clock=sim; bus_clock_err_ns=0; source=test\n';
  var HEAD = 't_s,t_bus_s,dir,link,id,flags,len,data,fault\n';
  var LOG = META + HEAD +
    '0.020000000,0.320000000,to_dut,engine,0CF00400,x,8,F07D7D000000FFFF,\n' +
    '0.010000000,0.010000000,from_dut,mc,0C000027,x,8,F0FFFFFFFFFFFFE0,corrupt\n' +
    '0.020000000,,to_dut,,123,,2,0A0B,drop\n' +
    '0.010000000,0.010000000,to_dut,,7FF,fb,12,000102030405060708090A0B,\n';

  test('reads a frame log: metadata, rows, both times exact', function () {
    var p = F.parseFrameLog(LOG);
    eq(p.error, null, 'error');
    eq([p.meta.version, p.meta.stepNs, p.meta.busClock, p.meta.busClockErrNs, p.meta.source], [1, 10000000, 'sim', 0, 'test'], 'meta');
    eq(p.frames.length, 4, 'frames');
    var f = p.frames[0];
    eq([f.dir, f.link, f.id, f.ext, f.len, f.fault, f.lost], ['to_dut', 'engine', 0x0CF00400, true, 8, '', false], 'first frame');
    eq(F.latencyMs(f), 300, 'latency of a 300 ms delay, exact');
    eq(p.frames[2].tBus, null, 'no bus time');
    eq(p.frames[2].lost, true, 'a drop is lost');
    eq([p.frames[3].fd, p.frames[3].brs, p.frames[3].len, p.frames[3].data[11]], [true, true, 12, 11], 'CAN FD frame');
  });
  test('sorts by t_s, keeping the file order for ties', function () {
    var p = F.parseFrameLog(LOG);
    eq(p.sorted.map(function (f) { return f.index; }), [1, 3, 0, 2], 'order');
    eq(F.indexAtTime(p.sorted, 0.015), 1, 'last frame at or before 15 ms');
    eq(F.indexAtTime(p.sorted, 0.0), -1, 'none before the first');
  });
  test('refuses an unknown version and a bad metadata line', function () {
    eq(F.parseFrameLog(META.replace('log 1', 'log 2') + HEAD).error.line, 1, 'version 2');
    eq(F.parseFrameLog('t_s,rpm\n0.0,1\n').error.line, 1, 'a trace is not a frame log');
    eq(F.parseFrameLog(META.replace('bus_clock=sim', 'bus_clock=wall') + HEAD).error.line, 1, 'unknown clock');
    eq(F.parseFrameLog(META.replace('step_ns=10000000', 'step_ns=0') + HEAD).error.line, 1, 'step 0');
  });
  test('refuses bad rows and names the line', function () {
    var bad = function (row) { return F.parseFrameLog(META + HEAD + row + '\n').error; };
    eq(bad('0.01,,to_dut,,123,,0,,').line, 3, 'time without nine decimals');
    eq(bad('0.010000000,,sideways,,123,,0,,').line, 3, 'dir');
    eq(bad('0.010000000,,to_dut,,123,,0,,lost').line, 3, 'fault');
    eq(bad('0.010000000,,to_dut,,1234,,0,,').line, 3, '11-bit id with 4 digits');
    eq(bad('0.010000000,,to_dut,,123,,2,0A,').line, 3, 'data shorter than len');
    eq(bad('0.010000000,,to_dut,,123,,9,000000000000000000,').line, 3, 'classic frame of 9 bytes');
    eq(bad('0.010000000,,to_dut,,123,,0').line, 3, 'short row');
    eq(F.parseFrameLog(META + 't_s,dir\n').error.line, 2, 'missing columns');
  });

  /* ---------------------------------------------------------------- DBC */

  var DBC = [
    'VERSION ""', '', 'NS_ :', '\tCM_', '\tBA_DEF_', '', 'BS_:', '', 'BU_: A B', '',
    'BO_ 2364540158 EEC1: 8 A',
    ' SG_ EngineSpeed : 24|16@1+ (0.125,0) [0|8031.875] "rpm" B',
    ' SG_ Torque : 16|8@1+ (1,-125) [-125|125] "%" B',
    ' SG_ Mode : 0|4@1+ (1,0) [0|15] "" B', '',
    'BO_ 256 MOTO: 8 A',
    ' SG_ Big : 7|16@0+ (1,0) [0|65535] "" B',
    ' SG_ Neg : 23|8@0- (1,0) [-128|127] "" B',
    ' SG_ Wide : 32|32@1+ (1,0) [0|4294967295] "" B', '',
    'BO_ 512 MUX: 8 A',
    ' SG_ Sel M : 0|8@1+ (1,0) [0|255] "" B',
    ' SG_ Plain : 8|8@1+ (1,0) [0|255] "" B', '',
    'CM_ "the database";',
    'CM_ BO_ 2364540158 "Electronic Engine',
    'Controller 1";',
    'BA_DEF_ "ProtocolType" STRING ;',
    'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
    'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
    'BA_ "ProtocolType" "J1939";',
    'BA_ "GenMsgCycleTime" BO_ 2364540158 10;',
    'VAL_ 2364540158 Mode 0 "Low idle" 15 "Not available" ;',
    'EV_ Foo: 0 [0|1] "" 0 1 DUMMY_NODE_VECTOR0 Vector__XXX;'
  ].join('\n');

  test('reads a DBC: messages, signals, comments, attributes, value tables', function () {
    var db = D.parseDbc(DBC);
    eq(db.error, null, 'error');
    eq(db.messages.map(function (m) { return m.name; }), ['EEC1', 'MOTO', 'MUX'], 'messages');
    var m = db.messages[0];
    eq([m.extended, m.id, m.length, m.sender, m.cycleMs], [true, 0x0CF004FE, 8, 'A', 10], 'EEC1');
    eq(m.comment, 'Electronic Engine\nController 1', 'a comment over two lines');
    eq(db.comment, 'the database', 'database comment');
    eq(db.j1939, true, 'ProtocolType J1939');
    eq(m.signals[2].choices, { 0: 'Low idle', 15: 'Not available' }, 'value table');
    eq(db.messages[1].cycleMs, null, 'default cycle 0 is no period');
  });
  test('warns, not fails, on multiplexing and unsupported sections', function () {
    var db = D.parseDbc(DBC);
    eq(db.messages[2].signals.map(function (s) { return s.name; }), ['Plain'], 'multiplexer skipped');
    eq(db.warnings.length, 2, 'two warnings: ' + db.warnings.join('; '));
  });
  test('refuses a file with no messages, or a broken signal', function () {
    eq(D.parseDbc('VERSION ""\n').error.line, 1, 'no messages');
    eq(D.parseDbc('BO_ 1 A: 8 X\n SG_ broken\n').error.line, 2, 'broken signal');
  });
  test('decodes Intel and Motorola, signed and unsigned, 32 bits exactly', function () {
    var db = D.parseDbc(DBC);
    var eec1 = D.decodeSignals(db.messages[0], bytes('F0A271DF2E27FFFF'));
    eq(eec1.map(function (s) { return [s.name, s.value]; }), [['EngineSpeed', 1499.875], ['Torque', -12], ['Mode', 0]], 'EEC1 as open-crank sends it');
    eq(eec1[2].choice, 'Low idle', 'value table text');
    var moto = D.decodeSignals(db.messages[1], bytes('1234FF00DDCCBBAA'));
    eq(moto[0].raw, 0x1234n, 'Motorola 16 bits from bit 7');
    eq(moto[1].raw, -1n, 'Motorola signed 8 bits, 0xFF = -1');
    eq(moto[2].raw, 0xAABBCCDDn, 'Intel 32 bits');
  });

  /* ---------------------------------------------------------------- J1939 */

  test('splits an identifier: priority, PGN, source, destination', function () {
    eq(J.parts(0x0C000027), { priority: 3, pgn: 0, source: 0x27, dest: 0x00, pdu1: true }, 'TSC1 to the engine');
    eq(J.parts(0x18FECA00), { priority: 6, pgn: 0xFECA, source: 0, dest: 0xFF, pdu1: false }, 'DM1');
    eq(J.parts(0x18ECFF00).pgn, 0xEC00, 'TP.CM: PDU1, destination stripped');
  });
  test('matches a frame with its DBC message by PGN, preferring the same source', function () {
    var db = D.parseDbc(DBC);
    var m = J.messageFor(db, { id: 0x0CF00400, ext: true });
    eq(m && m.name, 'EEC1', 'EEC1 from another source address');
    eq(J.messageFor(db, { id: 0x18FECA00, ext: true }), null, 'no DM1 in this DBC');
    eq(J.messageFor(db, { id: 256, ext: false }).name, 'MOTO', 'an 11-bit frame by identifier');
  });
  test('the TSC1 checksum is J1939-71\'s, as open-crank computes it', function () {
    /* frames from open-crank's tests/dbc_vectors.c */
    eq(J.tsc1Checksum(0x0C000027, bytes('F5E02E7DFFFFFFB0'), 0), 11, 'counter 0');
    eq(J.tsc1Checksum(0x0C000027, bytes('C4911A00FFFFFF07'), 7), 0, 'counter 7');
    eq(J.tsc1Checksum(0x0C000027, bytes('E5A041FAFFFFFFEF'), 15), 14, 'counter 15');
  });
  test('decodes a DM1: lamps, codes and the failure mode text', function () {
    var d = J.decodeDm1(bytes('10FF640001017FFF'));
    eq([d.redStop, d.amberWarning, d.mil, d.protect], ['on', 'off', 'off', 'off'], 'lamps');
    eq(d.dtcs, [{ spn: 100, fmi: 1, fmiText: 'below normal, most severe', oc: 1 }], 'one code');
    eq(J.decodeDm1(bytes('00FF00000000FFFF')).dtcs, [], 'no active code');
  });

  function frameRows(rows) {
    return F.parseFrameLog(META + HEAD + rows.join('\n') + '\n');
  }
  /* open-crank's DM1 with two codes: SPN 100 FMI 1 and SPN 524287 FMI 16, as a BAM */
  var BAM = [
    '1.000000000,1.000000000,to_dut,engine,18ECFF00,x,8,200A0002FFCAFE00,',
    '1.050000000,1.050000000,to_dut,engine,18EBFF00,x,8,0114FF64000101FF,',
    '1.100000000,1.100000000,to_dut,engine,18EBFF00,x,8,02FFF07EFFFFFFFF,'
  ];
  test('reassembles a BAM and decodes the DM1 it carries', function () {
    var p = frameRows(BAM);
    eq(p.error, null, 'log');
    var a = J.analyse(p.sorted);
    var info = a.bam[2];
    eq([info.complete, info.pgn, info.size, info.packets, info.frames], [true, 0xFECA, 10, 2, [0, 1, 2]], 'transfer');
    eq(info.dm1.dtcs.map(function (d) { return [d.spn, d.fmi]; }), [[100, 1], [524287, 16]], 'codes');
    eq([info.dm1.redStop, info.dm1.amberWarning], ['on', 'on'], 'lamps');
  });
  test('reports an incomplete BAM: a packet out of order, T1, a lost packet', function () {
    eq(J.analyse(frameRows([BAM[0], BAM[2]]).sorted).bam[0].why, 'packet 2 arrived where 1 was due', 'out of order');
    var late = BAM[2].replace('1.100000000,1.100000000', '1.900000000,1.900000000');
    eq(J.analyse(frameRows([BAM[0], BAM[1], late]).sorted).bam[0].why, 'more than 750 ms (T1) between two packets', 'T1');
    var lost = BAM[1].replace('1.050000000,1.050000000,', '1.050000000,,').replace(/,$/, ',drop');
    var r = J.analyse(frameRows([BAM[0], lost, BAM[2]]).sorted);
    eq([r.bam[0].complete, r.bam[0].why], [false, 'packet 2 arrived where 1 was due'], 'a dropped packet never arrived');
  });
  test('TSC1 integrity: checksum, and a counter that moves by one', function () {
    var rows = [
      '0.010000000,0.010000000,from_dut,mc,0C000027,x,8,F5E02E7DFFFFFFB0,',  /* counter 0, checksum 11 */
      '0.020000000,0.020000000,from_dut,mc,0C000027,x,8,F5E02E7DFFFFFFB0,',  /* repeated counter */
      '0.030000000,0.030000000,from_dut,mc,0C000027,x,8,F5E02E7DFFFFFF41,corrupt' /* counter 1, wrong checksum */
    ];
    var t = J.analyse(frameRows(rows).sorted).tsc1;
    eq([t[0].checksumOk, t[0].step, t[0].intact], [true, null, true], 'first');
    eq([t[1].checksumOk, t[1].step, t[1].intact], [true, 0, false], 'repeated counter');
    eq([t[2].counter, t[2].checksumOk, t[2].step, t[2].intact], [1, false, 1, false], 'corrupted');
  });

  root.RIG_TEST_RESULTS = results;
  if (typeof document !== 'undefined') {
    var failed = results.filter(function (r) { return !r.ok; });
    var out = document.getElementById('out');
    out.textContent = (failed.length === 0 ? 'PASS' : 'FAIL') + ': ' + (results.length - failed.length) + ' of ' + results.length + ' tests\n' +
      results.map(function (r) { return (r.ok ? '  ok    ' : '  FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.message); }).join('\n');
  }
}(typeof window !== 'undefined' ? window : globalThis));
