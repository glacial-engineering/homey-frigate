# Frigate for Homey

Athom Homey app that subscribes to Frigate MQTT messages and exposes trigger Flow cards for tracked object metadata updates and review updates.

<img width="650" height="650" alt="image" src="https://github.com/user-attachments/assets/c2dad3d9-44d2-4721-818c-2f5c054b3b49" />

## Features

- MQTT connection configured from app settings
- Subscribes to `frigate/tracked_object_update`
- Subscribes to `frigate/reviews`
- Trigger cards for object descriptions, face recognition, license plates, review starts, review alert escalation, review ends, and GenAI review summaries

## Settings

- MQTT protocol, host, port, username, password, and client ID
- Frigate topic prefix, default `frigate`
- Frigate base URL, used to turn relative thumbnail paths into full URLs

## Flow Cards

### Tracked object updates

- Tracked object metadata updated
- Object description updated
- Face recognized
- License plate recognized

### Reviews

- Review started
- Review became alert
- Review ended
- Review AI summary ready

## Development

```bash
npm install
homey app run --remote
homey app validate --level debug
```
