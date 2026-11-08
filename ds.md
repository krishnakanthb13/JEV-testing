# Jev Test Console — Code Audit

Audited files: `README.md`, `app.js`, `index.html`, `manifest.webmanifest`, `proxy.js`, `serve.js`, `start.bat`, `stop.bat`, `stop.js`, `styles.css`, `sw.js`, `.gitignore`.

Overall the code is well-structured, but several real bugs and integrity issues exist, especially around concurrent requests, storage, and the local proxy/server.

## Critical

- **`app.js:run()` allows concurrent runs, which corrupt the UI**
  - It increments `runToken` but does not abort the previous in-flight request or clear its timer. A stale response can overwrite the current run’s results, and the old `setInterval` keeps updating `responseMeta`.
  - **Fix**: abort any existing `runtime.abort` at the start of `run()`; in `finally` and before `renderResponse`, check `if (token !== runToken) return;`.

- **`recordHistory` stores full request bodies including base64 image assets**
  - `buildRequestBody()` includes `assets` with the full image; `recordHistory` saves that. A few image runs can blow through `localStorage` quota.
  - **Fix**: strip `assets` (and maybe very large `state` values) before saving history, or store only a reference/thumbnail.

## High

- **No `localStorage` quota handling**
  - `saveSettings`, `saveHistory`, `savePresets`, `recordHistory`, and `savePresetFromForm` can throw `QuotaExceededError`, leaving the app in a broken state.
  - **Fix**: wrap writes in `try/catch` and surface a clear message.

- **`fetchModels` does not send the API key**
  - `GET /inference/v1/models` is fetched without the `Authorization` header; it will 401 if the upstream requires auth.
  - **Fix**: pass `Authorization: Bearer ${settings.apiKey}`.

- **Box questions are not validated for attached images**
  - `validateForm` allows a `box` question with no image, causing a later API error.
  - **Fix**: require `runtime.asset` when any question is type `box`.

## Medium

- **`serve.js` can crash on malformed URLs**
  - `decodeURIComponent(new URL(...))` throws on invalid percent-encoding and returns an unhandled 500.
  - **Fix**: wrap in `try/catch` and return 400.

- **`sw.js` may call `event.respondWith(undefined)`**
  - If a network request fails and the cache has no match, the `network` promise resolves to `undefined` (`cached` is `undefined`), passing that to `respondWith`.
  - **Fix**: return a real fallback Response or re-throw.

- **Proxy/server have no `'error'` event handlers**
  - If the port is already in use, the process throws instead of printing a helpful message.
  - **Fix**: `server.on('error', ...)` and `server.on('clientError', ...)`.

- **PID files are not cleaned on uncaught exceptions**
  - `process.on('exit', ...)` does not fire for uncaught exceptions, so stale `.pid` files can remain.
  - **Fix**: also listen for `uncaughtException` and `unhandledRejection`, or write the pid after a successful listen.

- **Proxy has no upstream timeout**
  - `fetch(upstream, ...)` can hang forever. Add an `AbortSignal` timeout.

- **`pct()` returns `NaN` for non-numeric input**
  - e.g. `style.width = "NaN%"`. **Fix**: default to `0`.

- **Box overlay can render negative width/height**
  - If `left > right` or `top > bottom`, the computed width/height is negative. **Fix**: `Math.max(0, ...)`.

## Low / Quality

- **No Content Security Policy**
  - Add a CSP meta tag or header to reduce XSS surface.

- **`attachImage` does not enforce the documented 16 MiB / 280–1568 px limits**
  - Large images cause huge requests and localStorage blow-up.

- **API key is in `localStorage`**
  - Consider `sessionStorage` or the Web Credentials API, though this is a deliberate trade-off.

- **`applySettingsToForm` does not validate `endpointId` against the available options**
  - A stale/corrupted setting can leave the select blank.

- **History deletion uses only `ts`**
  - Two runs in the same millisecond could collide. Use a UUID or `ts + random`.

- **Choice answer can display `"undefined"`**
  - `answerHtml` does `String(answer.choice)` without guarding.

- **`start.bat` health probes assume anything responding 200 on `/health` is the proxy**
  - Could be another service. Add a quick sanity check or use a unique probe path.

- **No `noscript` or JS-failure fallback**
  - Minor for a PWA, but a friendly message would help.

## Recommended solid improvements

1. **Add a small validation module** for question IDs, model names, endpoint URLs, and image constraints, then reuse it in `validateForm` and `applyBodyToForm`.
2. **Centralize request lifecycle state** (idle / loading / cancelling) so the UI, cancel button, and history recording stay consistent.
3. **Strip large/binary data from history/presets** by default; store only the request shape and small metadata.
4. **Add `server.on('error', ...)` and upstream timeouts** to `proxy.js` and `serve.js`.
5. **Fix the service worker to always return a valid `Response`** and add an offline fallback page.
6. **Add a CSP** and consider subresource integrity for a shipped PWA.
7. **Cross-platform `stop.js`** would help non-Windows users; currently it only works on Windows.

## Implementation checklist

All items below were implemented and verified with the test harnesses in the session scratchpad.

- [x] Abort/guard concurrent runs in `app.js` (abort previous request, token guard before render, guarded retry path)
- [x] Strip image assets before recording history
- [x] Handle `localStorage` quota errors (write helper, history trimming, user messages)
- [x] Send auth header when fetching models
- [x] Require an image for Box questions
- [x] Guard `pct()` against non-numeric input
- [x] Clamp Box overlay dimensions
- [x] Guard missing `answer.choice`
- [x] Enforce image size/resolution limits (16 MiB, 280–1568 px, decode errors)
- [x] Update model note when an image is removed
- [x] Validate and persist stale `endpointId` / `imagesHeader` in `applySettingsToForm`
- [x] Add timestamp-safe history identity (uniquified `ts`)
- [x] Harden `serve.js` URL decoding and server errors
- [x] Harden `proxy.js` with upstream timeout, body limit, method restriction, and server errors
- [x] Guarantee a valid service-worker fallback response and only cache successful responses
- [x] Add CSP and a `noscript` fallback
- [x] Improve `start.bat` health probes to verify this app/proxy
- [x] Make `stop.js` cross-platform (Linux via `/proc`, macOS via `ps`)
- [ ] API key storage remains in `localStorage` as a documented trade-off.

## Test results

- `app.js` logic and concurrency: 17 passed, 0 failed
- `serve.js` integration: 8 passed, 0 failed
- `proxy.js` integration: 6 passed, 0 failed
- `sw.js` behavior: 8 passed, 0 failed
- `stop.js` behavior: 5 passed, 0 failed
- `start.bat` health-check expressions: 4 passed, 0 failed
- `node --check` on all JavaScript files: passed
