# Frigate for Homey

Athom Homey app that subscribes to Frigate MQTT messages and exposes trigger Flow cards for events, tracked object metadata updates, and review updates. It also adds a Frigate Camera device (Homey `camera` class) with a live snapshot and RTSP live view.

<img width="650" height="650" alt="image" src="https://github.com/user-attachments/assets/c2dad3d9-44d2-4721-818c-2f5c054b3b49" />

## Features

- MQTT connection configured from app settings
- Subscribes to `frigate/events`
- Subscribes to `frigate/tracked_object_update`
- Subscribes to `frigate/reviews`
- Subscribes to `frigate/doorbell/press` and `frigate/doorbell/press_unanswered` (custom doorbell topics — see [Doorbell](#doorbell))
- Subscribes to `frigate/+/classification/+` (state classification models — see [State classification](#state-classification))
- Trigger cards for event labels and sub-labels, object descriptions, face recognition, license plates, review starts, review alert escalation, review ends, GenAI review summaries, review label matching, and state classification changes
- Frigate Camera device with snapshot image and RTSP live view (see [Camera device](#camera-device))

## Settings

- MQTT protocol, host, port, and client ID
- Frigate topic prefix, default `frigate`
- Frigate base URL, used to turn relative thumbnail paths into full URLs and to fetch snapshots/discover cameras
- go2rtc RTSP restream port, default `8554` (Frigate's live-view restream port, separate from the base URL's HTTP API port)

## Camera device

Pairing discovers cameras from Frigate's `/api/config`, then asks you to pick which of that camera's `live.streams` entries (as configured in Frigate, e.g. "Main Stream", "Sub Stream", "Two-Way Stream") backs the Homey live view — the exact go2rtc stream name is never guessed, since it commonly doesn't match the camera's own name (e.g. `cam1_main` for a camera named `front`).

- **Snapshot**: fetched from `<frigateBaseUrl>/api/<camera>/latest.jpg`.
- **Live view**: RTSP pulled from `rtsp://<frigateBaseUrl host>:<frigateRtspPort>/<go2rtc stream name>`. Homey proxies this to WebRTC for the mobile/web app automatically.
- **Changing the stream later**: open the device's Advanced Settings and edit the "Live stream (go2rtc name)" text field. There is no repair flow for this — see [AGENTS.md](AGENTS.md) for why.
- **Codec caveat**: Homey's video player needs H.264. If Frigate/go2rtc reports the stream as HEVC/H.265 (check with `ffprobe` against the RTSP restream, or look at the camera's own encoder settings), live view can fail in some players (e.g. desktop Firefox) even though it works fine in the Homey mobile app. Snapshot images are unaffected either way.

## Flow Cards

### Events

- New label on event — fires when an event's label changes or appears for the first time
- New sub-label on event — fires when an event's sub-label changes or appears for the first time

### Tracked object updates

- Tracked object metadata updated
- Object description updated
- Face recognized
- License plate recognized

### Reviews

- Review started
- Review became alert — fires when a review starts as an alert or escalates to alert
- Review ended
- Review AI summary ready
- A review contains all — fires once when a review's objects and sub-labels contain all specified items, and at least one was newly added

### Doorbell

- Doorbell pressed — fires the instant the doorbell button is pushed
- Doorbell rang unanswered — fires when the doorbell rings out without being answered

> **Note:** Frigate core does **not** publish a doorbell button-press event — it uses ONVIF only for PTZ. These two cards are driven by topics you publish yourself (e.g. from a small bridge that listens to your doorbell's native event API and republishes to MQTT). This app only subscribes; it does not produce these topics.

Expected topics and payloads (both default-prefixed with the configured topic prefix, `frigate`):

| Topic | Fires card | Payload |
| --- | --- | --- |
| `frigate/doorbell/press` | Doorbell pressed | `ON` (an `OFF` reset may follow and is ignored) |
| `frigate/doorbell/press_unanswered` | Doorbell rang unanswered | `ON` (an `OFF` reset may follow and is ignored) |

Only the `ON` edge fires a trigger, so each press produces exactly one Flow run. Both cards expose a `pressed_at` token (epoch milliseconds).

### State classification

- State classification changed — fires when a Frigate state classification model publishes a new detected state for a camera

Frigate publishes to `frigate/<camera_name>/classification/<model_name>` whenever a state classification model's detected state changes (it only publishes on change, not on every frame). For example, a "Delivery" model on the `doorbell` camera publishes to `frigate/doorbell/classification/Delivery` with a plain-text payload such as `delivery` or `no_delivery`.

The card exposes optional `camera`, `model name`, and `state` filters (leave any blank to match anything), plus `camera`, `model`, `state`, and `previous_state` tokens.

## Development

```bash
npm install
homey app validate --level debug
homey app install
```

See [AGENTS.md](AGENTS.md) for pairing-view pitfalls and why `homey app run` is unreliable in this environment — use `homey app install` for iterating.
