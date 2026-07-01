# AGENTS.md

Notes for agents working on this repo, especially around the Frigate Camera
driver's pairing flow and Homey's video/camera SDK. These were all learned the
hard way against a real Homey Pro — verify claims against real behavior before
trusting SDK docs, which are frequently incomplete or wrong for edge cases.

## Testing loop

- `homey app install` is the reliable way to push a build to your configured
  Homey Pro and test manually. It's fast and doesn't disturb already-paired
  devices.
- `homey app run` (local Docker) and `homey app run --remote` were
  **unreliable in the environment this was developed in**: the debug socket
  the CLI opens back to the development machine was not reachable from Homey
  Pro's network, so the session timed out after ~10s and **uninstalled the
  app**, wiping whatever `homey app install` had just deployed. If this
  happens to you, run `homey app install` again afterward, and consider
  `homey app run`'s networking requirements before relying on it for
  iteration.
- `homey app run --remote` *does* still stream driver/device background logs
  (`onInit`, MQTT connect, `this.log(...)` calls) via a different channel that
  survives even when the debug socket fails — useful for capturing runtime
  logs (e.g. what RTSP URL got requested) as long as you don't need it to
  survive more than a short capture window before it tears itself down.
- Pairing-view (webview) JS execution is **not** visible in any log stream.
  The only way to debug a custom pair/repair HTML view is to add visible
  on-page error output (see below) and read it off the phone/browser screen.

## Custom pairing view HTML — what actually works

- Every working pairing view file in this repo (`pair/start.html`,
  `pair/select_camera.html`, `pair/select_stream.html`) uses `Homey` as an
  **ambient global**, calling `Homey.emit(...)` etc. directly in a plain
  `<script>` block — **not** the `onHomeyReady(Homey)` + `Homey.ready()`
  pattern documented for settings pages and widgets. Copying the settings-page
  pattern into a pairing view made a previously-working view (the "Discover
  cameras" button) stop working; reverting to a plain inline script/`onclick`
  fixed it immediately. Don't reintroduce `onHomeyReady` here without
  re-verifying on real hardware.
- `select_stream.html` intermittently failed to execute its script at all
  (static HTML rendered, `<script>` never ran, no error surfaced) with no
  code change that reliably explained it. Wrapping the whole script body in
  `try { ... } catch (syncErr) { ... }` and writing the error into the DOM
  eventually got it working; the exact root cause was never conclusively
  identified (possibly a webview timing quirk). If you touch this file and it
  stops working again, don't assume the JS is wrong — add the same
  `window.onerror` + `try/catch` + `insertAdjacentHTML` debug scaffolding
  from git history before changing logic.
- `Homey.getViewStoreValue(viewId, key)` requires an explicit `viewId` (no
  "current view" shortcut). It was tried once for passing the selected camera
  between `select_camera.html` → `select_stream.html` and abandoned in favor
  of routing everything through `session.setHandler`/`Homey.emit` on the
  driver instead (simpler, one less API surface to get wrong). The one place
  `setViewStoreValue` is still used is the documented hand-off into the
  built-in `add_devices` template (`Homey.setViewStoreValue('add_devices',
  'devices', [...])`), which is the only supported way to feed it a device
  list from a custom view.

## Repair flow: not used, on purpose

- `driver.js` has **no `onRepair`**, and there is no `pair/repair_*.html`
  file. A custom-HTML repair view was built and never got its script to run
  (same generic Homey error every time: `unknown_error_getting_file`,
  appearing ~2-5s into the repair session, before any of our code/log lines
  fired). Every real-world example of Homey's `repair` array found during
  research only used built-in system templates (e.g. `login_oauth2`) — none
  used a fully custom view — so it's unclear custom repair views are actually
  supported at all.
- Instead, the go2rtc stream name is a plain **device setting**
  (`streamName`, declared in `driver.compose.json`'s `settings` array). Users
  change the live-view stream via the device's own Advanced Settings screen.
  `device.js` reads it with `this.getSetting('streamName')`. If you're
  tempted to reintroduce a repair flow for this, prove a custom repair view
  can execute its script at all on real hardware first — don't invest in the
  UX before that.

## Frigate stream naming

- Never assume a go2rtc stream name equals the Frigate camera name. Query
  `/api/config` and read `cameras.<name>.live.streams` (a label → go2rtc name
  map, e.g. `{"Main Stream": "cam1_main", ...}`) — this is what
  `driver.js#discoverCameras` returns per camera, and what the pairing flow
  presents to the user to pick from.
- Codec matters for live view: Homey's video player wants H.264. Check with
  `ffprobe -select_streams v:0 -show_entries stream=codec_name rtsp://<host>:8554/<stream>`
  against the actual restream before assuming a "camera unavailable" report
  is an app bug — it may just be an HEVC/H.265 source stream, which several
  players (Homey's own video pipeline on some platforms, desktop Firefox)
  don't handle even though the snapshot image and the URL construction are
  both correct.
