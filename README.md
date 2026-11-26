# open-rig

A viewer for [open-tick](https://github.com/Open-Heavy-Machinery/open-tick) traces: open one or two CSV files, plot them on a shared time axis and compare them, see where each acceptance criterion passed or failed, and see the CAN frames of the run, decoded. Part of [Open Heavy Machinery](https://open-heavy-machinery.github.io).

**Status: pre-alpha. v0.2 draws the acceptance oracle's verdicts over the trace; v0.3 shows the bus: a frame log next to the trace, decoded with a DBC (J1939 included).** It is still a static page. Everything marked *(planned)* does not exist yet.

It runs in the browser. No file is uploaded and nothing is installed: one HTML page, plain JavaScript, no external scripts or fonts.

## Use it

Serve the folder and open it:

```bash
python3 -m http.server 8000      # then open http://localhost:8000
```

Choose or drop a trace as **A**, and optionally another as **B** (drawn dashed). The examples need the page to be served as above; opening `index.html` straight from the disk works for files you choose by hand.

- **Wheel** zooms, **drag** pans, **double-click** resets. With the plots focused: arrow keys, `+`, `-`, `0`.
- Click a signal in a legend to hide it. Hovering shows each signal's value at that time.
- With A and B loaded, a table gives, for every column they share, the largest difference, when it happens and the rms. *B time offset* shifts B in time, for a board trace that starts later than the simulator's.
- With a **verdict file** loaded next to trace A, a list of criteria and a strip of their windows appear above the plots. Choose a criterion to zoom to it and draw it over every plot (see [Verdicts](#verdicts)).
- With a **frame log** (and optionally a **DBC**), a bus panel appears under the criteria: one lane per message, source and direction, on the same axis and cursor as the plots. Choose a frame to decode it (see [The bus](#the-bus)).
- Links can name the files: `index.html?a=examples/hoist_step.csv&layout=examples/hoist_step.layout.json` (`a`, `b`, `layout`, `verdicts`, `frames` and `dbc`; same-origin, or a server that allows it). `criterion=F1` selects a criterion once loaded, `frame=2837` the frame on that line of the frame log, and `latency=1` shows the latency strip.

## What it reads

The CSV that open-tick writes; the format is in [open-tick's `docs/trace-format.md`](https://github.com/Open-Heavy-Machinery/open-tick/blob/main/docs/trace-format.md). open-rig knows nothing else about the machine: it depends on that format, never on an application.

The header carries names, not types or units, so:

- a column is a number column if every non-empty cell is a number, and a text column otherwise; empty cells are gaps;
- without a layout, number columns are grouped into panels by the unit their name ends in (`rpm`, `_nm`, `_pct`, `_bar`, `_kpa`, `_c`, `_frac`), and text columns and 0/1 columns are drawn as state strips.

### Verdicts

open-tick's acceptance oracle can write its verdicts as a file, one row per criterion. The format is in [open-tick's `docs/verdict-format.md`](https://github.com/Open-Heavy-Machinery/open-tick/blob/main/docs/verdict-format.md) (since open-tick v0.2.1), and open-rig reads it by column name. Load it as **Verdicts**, or drop a file whose name ends in `verdicts.csv`:

- each criterion's window is shaded, green if it passed and red if it failed;
- ▼ marks the event a reaction is timed from, ● where the reaction ended (`event_s + reaction_ms`), ✕ the first violation;
- the list says, for each criterion, its window and what happened: the reaction time, "not holding", the first violation, or a window the run did not reach or did not cover.

The verdicts' times are on trace A's time axis. open-rig draws them as the oracle wrote them, and does not grade anything itself.

### The bus

open-tick writes a **frame log** (since open-tick v0.3.1; `--frames` in open-crank's runners): every CAN frame of a run, one row each. The format is in [open-tick's `docs/frame-log-format.md`](https://github.com/Open-Heavy-Machinery/open-tick/blob/main/docs/frame-log-format.md). Load it as **Frames**, or drop a file whose name ends in `frames.csv`. It works with a trace or on its own.

Each frame has two times. **`t_s` places it on the axis**: the step in which it crossed the simulated machine's side, the same axis as the trace and the verdicts. **`t_bus_s`** is when it was on the bus, measured by the clock the file names (`sim`, `kernel`, `host`, `bridge`). It is shown as a measurement, never used to move the frame: in the frame's table, and in a strip of `t_bus − t_s` you can turn on.

In the bus panel:

- one lane per message (or identifier), source address and direction, with a tick per frame;
- ▯ a frame the link lost before it reached its receiver (`drop`, `drop_one_in`, `bus_off`, `overflow`);
- red: a corrupted frame, or a TSC1 that is not intact;
- a red line under a lane: more than twice the message's period (the DBC's `GenMsgCycleTime`) without a frame;
- shade: a step in which a link fault touched the lane.

Choose a frame and a table below the panel decodes it: both times, direction, link and fault, identifier and data, and every signal of its DBC message with its value, raw value and meaning (value tables; "not available" for a J1939 all-ones value; a value outside the DBC's range). *Previous* and *next* walk the lane.

A **DBC** (Vector's CAN dictionary format, also read by cantools and SavvyCAN) names the frames and their signals. Load it as **Bus dictionary**, or drop a `.dbc`. The application owns it, as it owns its layout: [`examples/open-crank.dbc`](examples/open-crank.dbc) is open-crank's. open-rig reads messages, signals (Intel and Motorola, signed and unsigned), value tables, comments and the attributes `ProtocolType`, `VFrameFormat` and `GenMsgCycleTime`. Multiplexed signals and other sections are skipped with a warning.

When the DBC says `ProtocolType "J1939"`, a small J1939 layer (`src/j1939.js`) adds what a DBC cannot say:

- frames are matched with messages by PGN (and source address), with priority, source and destination shown;
- BAM transfers (TP.CM and TP.DT) are reassembled, and an incomplete one says why (a packet out of order, more than 750 ms between packets);
- DM1 is read: the four lamps and every trouble code, with SPN, FMI and the FMI's J1939-73 text;
- each TSC1's checksum (SPN 4207) and counter (SPN 4206) are checked, as open-crank's `tsc1_intact` does.

Without a DBC, lanes are by identifier and frames are shown raw. open-rig knows no machine: everything J1939 comes from the DBC's attribute, and plain CAN works the same way.

### Layouts

A **layout** is a small JSON file that says which columns go in which panel. It belongs to the application, next to its scenarios, not to open-rig. [`examples/hoist_step.layout.json`](examples/hoist_step.layout.json) is open-crank's:

```json
{
  "version": 1,
  "time": "t_s",
  "panels": [
    { "title": "Engine speed", "unit": "rpm", "columns": ["rpm", "ecu_target_rpm"] }
  ],
  "states": ["ecu_state", "mc_state"]
}
```

A column the layout names that the trace does not have is reported and skipped.

## What it does not do

- **It does not show the machine move.** No model in the family has kinematics yet (open-crank is an engine and a hydraulic pump). Kinematic views *(planned)* come when a machine that has them exists.
- **No live view yet.** *(planned)* A WebSocket view, fed by a small bridge from a running simulator. The bus view reads recorded frame logs only.
- **No J1939 transport beyond BAM.** RTS/CTS transfers are not reassembled, and SPNs are shown by number, not by name.
- It is a viewer, not a judge: the comparison table shows differences, and does not say whether they are acceptable. The verdicts it draws are the oracle's, not open-rig's.

## Examples

[`examples/`](examples) has traces written by open-tick and open-crank, so the page works out of the box:

| File | What it is |
|---|---|
| `flywheel.csv` | open-tick's `otk-flywheel` example with `examples/flywheel/step.csv` |
| `flywheel-heavier-load.csv` | the same, with a load of 1.2 N·m instead of 0.3 and no loss of the speed frames |
| `hoist_step.csv` | open-crank's `scenarios/hoist_step.csv`, from `open-crank-run` |
| `flywheel.verdicts.csv` | the oracle's verdicts for `flywheel.csv`: open-tick's `examples/flywheel/step.verdicts.csv` at open-tick `b75c484`, byte for byte (3 of 3 PASS) |
| `flywheel-strict.verdicts.csv` | the same run graded with F1 tightened from 200 ms to 100 ms (`fault.speed_lost=1+100ms`): the controller needs 110 ms, so F1 fails, not holding at 4.10 s |
| `hoist_step.frames.csv`, `hoist_step.verdicts.csv` | the frames and verdicts of that run: `open-crank-accept-loop scenarios/hoist_step.csv --frames … --verdicts …` at open-crank `5aa1232` (8 of 8 PASS) |
| `speed_command_corrupt.csv`, `.frames.csv`, `.verdicts.csv` | open-crank's `scenarios/speed_command_corrupt.csv` at open-crank `5aa1232`: the trace from `open-crank-run`, the frames and verdicts from `open-crank-accept-loop` (8 of 8 PASS). From 8 s to 14 s the `mc` link flips byte 3 (`fault.link.mc.corrupt=3`) of every frame from the controller: 600 TSC1 with a wrong checksum, which the engine refuses |
| `engine_dtc_red_and_amber.csv`, `.frames.csv`, `.verdicts.csv` | open-crank's `scenarios/engine_dtc_red_and_amber.csv` at open-crank `bc8ea3b`: the trace and the frames from one run of `open-crank-run --trace … --frames …`, the verdicts from `open-crank-accept-loop --verdicts …` (6 of 6 PASS). From 8 s the engine has two faults, so its DM1 carries two codes, is 10 bytes long and travels as a BAM: a TP.CM and two TP.DT, 50 ms apart, once a second. Choose a TP.DT (for example `frame=2874`) to see the DM1 reassembled: red stop and amber warning lamps on, SPN 100 FMI 1 and SPN 110 FMI 16. The last TP.CM, at 14.00 s, is the run's last step: its packets were never sent, so it is shown as incomplete |
| `open-crank.dbc` | open-crank's bus dictionary, `open-crank.dbc` at open-crank `5aa1232`, byte for byte |

The trace (`open-crank-run`) and the frames (`open-crank-accept-loop`) come from two runners on the same in-memory loop and scenario. They are the same run: the requested speed of every TSC1 in the frame log equals the trace's `mc_request_rpm` at the same `t_s` (2351 of 2351 in `hoist_step`, 1649 of 1649 intact TSC1 in `speed_command_corrupt`). `hoist_step.csv` is byte-identical to the one at that commit. `engine_dtc_red_and_amber` needs no such check: since open-crank `bc8ea3b` (#41), `open-crank-run --frames` writes the trace and the frames in the same run (`source=open-crank-run` in the frame log's header).

## Tests

```bash
google-chrome --headless=new --no-sandbox --virtual-time-budget=3000 --dump-dom tests/index.html | grep -E "PASS|FAIL"
```

`src/trace.js`, `src/framelog.js`, `src/dbc.js` and `src/j1939.js` have no DOM, and are what the tests cover: the trace, verdict and frame log readers, the DBC reader and decoder (Intel and Motorola, signed, 32 bits), and the J1939 layer (identifiers, PGN matching, BAM reassembly and its failures, DM1, the TSC1 checksum and counter, checked against open-crank's own frames). CI runs them, and loads the page five times to check that it draws: the hoist step with its layout; the flywheel with a verdict file in which one criterion fails; a corrupted TSC1 chosen on the bus and decoded with open-crank's DBC; a DM1 reassembled from a BAM, with its two trouble codes; and a frame log on its own.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
