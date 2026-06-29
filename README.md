# Frigate for Homey

Athom Homey app that subscribes to Frigate MQTT messages and exposes trigger Flow cards for events, tracked object metadata updates, and review updates.

<img width="650" height="650" alt="image" src="https://github.com/user-attachments/assets/c2dad3d9-44d2-4721-818c-2f5c054b3b49" />

## Features

- MQTT connection configured from app settings
- Subscribes to `frigate/events`
- Subscribes to `frigate/tracked_object_update`
- Subscribes to `frigate/reviews`
- Subscribes to `frigate/doorbell/press` and `frigate/doorbell/press_unanswered` (custom doorbell topics — see [Doorbell](#doorbell))
- Trigger cards for event labels and sub-labels, object descriptions, face recognition, license plates, review starts, review alert escalation, review ends, GenAI review summaries, and review label matching

## Settings

- MQTT protocol, host, port, and client ID
- Frigate topic prefix, default `frigate`
- Frigate base URL, used to turn relative thumbnail paths into full URLs

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

## Development

```bash
npm install
homey app run --remote
homey app validate --level debug
```
