# open-rig

A viewer for [open-tick](https://github.com/Open-Heavy-Machinery/open-tick) traces: open one or two CSV files, plot them on a shared time axis and compare them. Part of [Open Heavy Machinery](https://open-heavy-machinery.github.io).

**Status: pre-alpha. v0.1 is a static page.** Everything marked *(planned)* does not exist yet.

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
- Links can name the files: `index.html?a=examples/hoist_step.csv&layout=examples/hoist_step.layout.json` (`a`, `b` and `layout`; same-origin, or a server that allows it).

## What it reads

The CSV that open-tick writes; the format is in [open-tick's `docs/trace-format.md`](https://github.com/Open-Heavy-Machinery/open-tick/blob/main/docs/trace-format.md). open-rig knows nothing else about the machine: it depends on that format, never on an application.

The header carries names, not types or units, so:

- a column is a number column if every non-empty cell is a number, and a text column otherwise; empty cells are gaps;
- without a layout, number columns are grouped into panels by the unit their name ends in (`rpm`, `_nm`, `_pct`, `_bar`, `_kpa`, `_c`, `_frac`), and text columns and 0/1 columns are drawn as state strips.

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
- It is a viewer, not a judge: the comparison table shows differences, and does not say whether they are acceptable.

## Examples

[`examples/`](examples) has traces written by open-tick and open-crank, so the page works out of the box:

| File | What it is |
|---|---|
| `flywheel.csv` | open-tick's `otk-flywheel` example with `examples/flywheel/step.csv` |
| `flywheel-heavier-load.csv` | the same, with a load of 1.2 N·m instead of 0.3 and no loss of the speed frames |
| `hoist_step.csv` | open-crank's `scenarios/hoist_step.csv`, from `open-crank-run` |

## Tests

```bash
google-chrome --headless=new --no-sandbox --virtual-time-budget=3000 --dump-dom tests/index.html | grep -E "PASS|FAIL"
```

`src/trace.js` has no DOM and is what the tests cover. CI runs them, and loads the page with an example to check that it draws.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
