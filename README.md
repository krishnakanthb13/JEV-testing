# Jev Test Console

A PWA console for testing **Jev**, TypeSafe's System One model. Jev does not generate
text: it evaluates a `state` against typed questions and returns values, probability
distributions, and confidence that code can branch on. The console lets you build that
request, run it through the OpenCode Console or TypeSafe API, and inspect the typed
answers.

- OpenCode Console model list: <https://opencode.ai/docs/console/models/>
- TypeSafe documentation: <https://docs.typesafe.ai/introduction>

## Requirements

- Node.js 18 or newer (the proxy and static server use the global `fetch`)
- A Chromium-based browser (Chrome, Edge) or Firefox/Safari for the app itself

## Quick start (Windows)

Double-click **`start.bat`**. It checks that Node is installed, starts the CORS proxy
only if `http://localhost:8787/health` does not answer, starts the static server only if
`http://localhost:8080` is not already serving, waits for the app to answer, then opens
it in your browser.

Close everything again with **`stop.bat`**, or `start.bat stop`. Each server writes its
process id to `.jev-proxy.pid` / `.jev-app.pid`, and `stop.js` stops exactly those
processes (and their child tree) and removes the pid files. Servers not started from this
folder are never touched. The pid files are git-ignored.

Manual start and stop:

```
node proxy.js     # CORS proxy on http://localhost:8787 (loopback only)
node serve.js     # static server on http://localhost:8080 (loopback only)
node stop.js      # stop both servers started from this folder
```

Then open <http://localhost:8080>, go to **Settings**, and paste an OpenCode Console or
TypeSafe API key. The key is stored in this browser's localStorage and sent only to the
endpoint you select.

> `start.bat` uses ports 8787 and 8080. To change them, edit the `PROXY_PORT` and
> `APP_PORT` variables at the top of the file and use the same ports for
> `PORT=... node proxy.js` / `PORT=... node serve.js`.

## Why the local proxy is required

Both APIs refuse direct browser (CORS) calls:

- `https://opencode.ai/inference/systemone/v1/systemone` answers the browser's `OPTIONS`
  preflight with **404 and no CORS headers**.
- `https://api.typesafe.ai/v1/systemone` answers with **`Disallowed CORS origin`** for
  this page's origin.

The browser therefore blocks the POST before it leaves the machine, and `fetch` rejects
with `TypeError: Failed to fetch`. The bundled proxy fixes this:

| Proxy route | Upstream |
|---|---|
| `http://localhost:8787/opencode/v1/systemone` | `https://opencode.ai/inference/systemone/v1/systemone` |
| `http://localhost:8787/opencode/v1/models` | `https://opencode.ai/inference/v1/models` |
| `http://localhost:8787/typesafe/v1/systemone` | `https://api.typesafe.ai/v1/systemone` |
| `http://localhost:8787/health` | `{"ok":true}` health check |

It binds to `127.0.0.1` only, forwards `authorization`, `content-type`, `accept`, and
`TypeSafe-Danger-Zone-Images` to the fixed upstreams above, and adds permissive CORS
headers so the page can read the response. Any other path returns 404, so it is not an
open proxy.

If the proxy is running and you still use a direct endpoint, the app switches to the
local proxy and retries automatically. If the proxy is not running, use **Copy as cURL**
and run the request in a terminal instead.

## Using the console

### Endpoint and model

| Endpoint option | URL | Default model | Models list |
|---|---|---|---|
| Local proxy for OpenCode Console (default) | `http://localhost:8787/opencode/v1/systemone` | `jev-1.13-free` | yes |
| Local proxy for TypeSafe API | `http://localhost:8787/typesafe/v1/systemone` | `jev-latest` | no |
| OpenCode Console direct | `https://opencode.ai/inference/systemone/v1/systemone` | `jev-1.13-free` | yes |
| TypeSafe API direct | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | no |
| Custom URL | anything you enter | current value | no |

The model is a free-text field with suggestions (`jev-1.13-free`, `jev-1.13`,
`jev-latest`, `jev-1.14`). Switching endpoint resets the model to that endpoint's default.
**List models** fetches `GET /inference/v1/models` for endpoints that publish it.

### State

- **Text** sends a plain string. **JSON** sends an object; questions can point at fields
  with backtick paths such as `` `ticket.messages[0].text` ``.
- **Attach image** loads a PNG or JPEG as a base64 asset with the fixed reference
  `img-1`. Use **Insert into state** to place `` `img-1` `` at the cursor, or reference it
  in instructions. The chip shows the pixel dimensions.
- **Samples** fill the state with the quickstart ticket, a repeat-contact message, or a
  structured JSON record.

### Questions

Every question has an ID (returned as the answer key), a type, and instructions.
Instructions may be a plain string or JSON (anything starting with `{` or `[` is sent as
parsed JSON, for structured instructions).

| Type | Request fields | Answer fields |
|---|---|---|
| `noul` | `instructions`, optional `criteria: { true, false }` | `noul` (0 to 1) |
| `choice` | `instructions`, `criteria: { option: description \| null }` | `choice`, `probabilities`, `confidence` |
| `score` | `instructions`, `criteria: [level, ...]` ordered low to high | `score` (may fall between levels), `legend`, `probabilities`, `confidence` |
| `box` | `instructions` (no criteria) | `box: { top, bottom, left, right }`, `confidence` |

Notes from the API docs:

- A `choice` question always picks one option. If the option list may not cover every
  input, add a companion `noul` asking whether anything fits.
- `noul` values near 0.5 mean the model is unsure. The console treats `>= 0.7` as yes and
  `<= 0.3` as no.
- `box` requires an attached image **and Jev 1.14 or newer**. A box always returns a
  location, so pair it with a `noul` for presence.
- Every question in a request is evaluated in parallel against the same state.

### Presets

The preset dropdown contains built-in examples (support triage, speculative fan-out,
noul checklist, JSON field paths, box) and your saved presets.

- **Save as preset** stores the current model, state, and questions in localStorage.
  Attached images are not stored in presets.
- **Delete** removes the selected saved preset.
- **Export** downloads all saved presets as `jev-presets.json`:

  ```json
  {
    "app": "jev-test-console",
    "version": 1,
    "exportedAt": "2026-11-07T12:00:00.000Z",
    "presets": [
      { "name": "Refund triage v2", "savedAt": 1794055467000, "request": { "model": "jev-1.13-free", "state": "...", "questions": {} } }
    ]
  }
  ```

- **Import** accepts that file, a bare array of presets, or a single preset object.
  Same-name presets are replaced.

### Running and reading answers

- **Run request** (or `Ctrl+Enter`) sends the request. While it is in flight you can
  cancel with **Cancel** or `Esc`; cancelled runs are not recorded.
- **Request JSON** shows the exact body that will be sent; edits there are sent as-is,
  and returning to the form re-reads the JSON.
- **cURL** and **fetch()** copy a runnable snippet of the current request. Both contain
  your API key.
- Answers render per type: a noul gauge with 0.3/0.7 thresholds, choice and score
  probability bars with confidence, and a box overlay drawn on the attached image.
- Response metadata shows HTTP status, latency, model, token counts, and an estimated
  cost when the model's price is known. The top bar keeps a session total (runs, tokens,
  estimated cost) until the page is reloaded.
- **Copy JSON** and **Download JSON** (`jev-response.json`) capture the raw response.
- **History** stores the last 25 runs in localStorage. **Open** reloads a run into the
  form; ticking **Compare** on two runs shows a table of answers side by side with
  numeric deltas and latency.

### Cost estimate

The console prices known models from the OpenCode Console table:

| Model | Input | Output |
|---|---|---|
| `jev-1.13` | $0.042 per 1M tokens | free |
| `jev-1.13-free` | free | free |

Unknown models show no cost chip. Estimates are shown per run and summed per session.

### Images

Images are off by default on the API. The **Images header** setting controls
`TypeSafe-Danger-Zone-Images`:

- **Auto** (default) sends the header when an image is attached or any `box` question exists
- **Always** sends it on every request
- **Never** omits it

The API accepts PNG or JPEG, 16 MiB per file, each side 280 to 1568 pixels.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+Enter` | Run request |
| `Esc` | Cancel the in-flight request, or close the preset name form |
| `ArrowLeft` / `ArrowRight`, `Home` / `End` | Move between tabs when the tab list is focused |

## Storage

Everything stays in this browser. Keys are namespaced per app version:

| Key | Contents |
|---|---|
| `jevconsole.settings.v1` | `{ endpointId, customEndpoint, apiKey, model, imagesHeader }` |
| `jevconsole.history.v1` | Last 25 run entries `{ ts, ms, status, ok, model, endpoint, request, response \| error }` |
| `jevconsole.presets.v1` | Saved presets `[{ name, savedAt, request }]` |

**Clear all stored data** in Settings removes all three keys. There is no server-side
storage; the API key never leaves the browser except in requests to the endpoint you
select.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell: top bar, tabs, request/response panes, settings |
| `app.js` | Request builder, answer renderers, presets, history, comparison, tooltips, service worker registration |
| `styles.css` | Layout and component styles, tooltip, responsive rules |
| `manifest.webmanifest` | PWA metadata and icons |
| `sw.js` | Service worker: offline app shell, navigations network-first, assets stale-while-revalidate |
| `icons/` | Installed-app icons (192, 512, maskable 512, Apple touch icon) |
| `serve.js` | Zero-dependency static server on port 8080 (loopback only), writes `.jev-app.pid` |
| `proxy.js` | Zero-dependency CORS proxy on port 8787 (loopback only), writes `.jev-proxy.pid` |
| `start.bat` | Windows launcher: starts proxy and app if needed, opens the browser; `start.bat stop` closes everything |
| `stop.bat` | Windows wrapper for `stop.js` |
| `stop.js` | Stops the servers tracked by the pid files and removes them |
| `.gitignore` | Ignores the `.jev-*.pid` runtime files |
| `README.md` | This file |

## PWA

The app is installable. The service worker caches the app shell for offline use; API
calls still need a network connection and the proxy. Updated files are picked up on the
next load (assets use stale-while-revalidate, navigations use network-first). If the
interface seems stale after an update, do one hard reload (`Ctrl+Shift+R`).

## Troubleshooting

**`TypeError: Failed to fetch`**
Both APIs block direct browser calls. Start the proxy (`node proxy.js` or `start.bat`) and
select a **Local proxy** endpoint. If the proxy is already running, the app switches and
retries by itself. As a last resort, use **Copy as cURL**.

**`HTTP 401` with `authentication_error`**
The API key is missing or invalid. Set it in Settings. The key must match the endpoint:
an OpenCode Console key for the OpenCode proxy, a TypeSafe key for the TypeSafe proxy.

**`HTTP 400` about images not enabled**
Set **Images header** to Always, or keep Auto and attach an image.

**Box questions fail**
Box needs Jev 1.14 or newer and an attached image. `jev-1.13` and `jev-1.13-free` do not
support box.

**Port already in use**
Another instance is running, or a different app holds the port. Stop it, or change
`PROXY_PORT`/`APP_PORT` in `start.bat` and start the servers with matching `PORT`
environment variables. The app's Local proxy endpoints assume port 8787; for another
port, add a custom endpoint URL such as `http://localhost:9000/opencode/v1/systemone`.

**Nothing loads at localhost:8080**
Start the static server with `node serve.js`. Opening `index.html` from the file system
will not register the service worker.

**Servers keep running, or ports 8787/8080 stay busy**
Run `stop.bat` (or `start.bat stop`). It stops the node processes recorded in
`.jev-proxy.pid` and `.jev-app.pid`, then deletes the files. If a port is held by a
different program, `stop.js` leaves it alone and says so. You can also press `Ctrl+C` in
a server's own console window.
