# Frigate for Homey

Athom Homey app that subscribes to Frigate MQTT messages and exposes trigger Flow cards for events, tracked object metadata updates, and review updates.

<img width="650" height="650" alt="image" src="https://github.com/user-attachments/assets/c2dad3d9-44d2-4721-818c-2f5c054b3b49" />

## Features

- MQTT connection configured from app settings
- Subscribes to `frigate/events`
- Subscribes to `frigate/tracked_object_update`
- Subscribes to `frigate/reviews`
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

## Development

```bash
npm install
homey app run --remote
homey app validate --level debug
```
