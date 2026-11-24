# open-rig

A viewer for [open-tick](https://github.com/Open-Heavy-Machinery/open-tick) traces: open one or two CSV files, plot them on a shared time axis and compare them, and see where each acceptance criterion passed or failed. Part of [Open Heavy Machinery](https://open-heavy-machinery.github.io).

**Status: pre-alpha. v0.2 draws the acceptance oracle's verdicts over the trace.** It is still a static page. Everything marked *(planned)* does not exist yet.

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
- Links can name the files: `index.html?a=examples/hoist_step.csv&layout=examples/hoist_step.layout.json` (`a`, `b`, `layout` and `verdicts`; same-origin, or a server that allows it). `criterion=F1` selects a criterion once loaded.

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
- **No live view yet.** *(planned)* A WebSocket view, fed by a small bridge from a running simulator.
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

## Tests

```bash
google-chrome --headless=new --no-sandbox --virtual-time-budget=3000 --dump-dom tests/index.html | grep -E "PASS|FAIL"
```

`src/trace.js` has no DOM and is what the tests cover: the trace reader and the verdict reader. CI runs them, and loads the page twice to check that it draws: the hoist step with its layout, and the flywheel with a verdict file in which one criterion fails.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
