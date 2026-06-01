const Homey = require('homey');
const mqtt = require('mqtt');

const DEFAULT_TOPIC_PREFIX = 'frigate';

class FrigateApp extends Homey.App {
  async onInit() {
    this.cards = {
      trackedObjectUpdate: this.homey.flow.getTriggerCard('tracked_object_update'),
      objectDescriptionUpdated: this.homey.flow.getTriggerCard('object_description_updated'),
      faceRecognized: this.homey.flow.getTriggerCard('face_recognized'),
      licensePlateRecognized: this.homey.flow.getTriggerCard('license_plate_recognized'),
      reviewStarted: this.homey.flow.getTriggerCard('review_started'),
      reviewBecameAlert: this.homey.flow.getTriggerCard('review_became_alert'),
      reviewEnded: this.homey.flow.getTriggerCard('review_ended'),
      reviewGenaiReady: this.homey.flow.getTriggerCard('review_genai_ready'),
    };

    this.registerTriggerListeners();
    this.connectMqtt();

    this.homey.settings.on('set', (key) => {
      if (this.isMqttSetting(key)) this.reconnectMqtt();
    });
  }

  registerTriggerListeners() {
    this.cards.trackedObjectUpdate.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.update_type, state.update_type, true)
        && this.matchesTextFilter(args.camera, state.camera);
    });

    this.cards.objectDescriptionUpdated.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera);
    });

    this.cards.faceRecognized.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.name, state.name)
        && state.score >= this.numberOrDefault(args.min_score, 0);
    });

    this.cards.licensePlateRecognized.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.plate, state.plate)
        && this.matchesTextFilter(args.name, state.name)
        && state.score >= this.numberOrDefault(args.min_score, 0);
    });

    this.cards.reviewStarted.registerRunListener(async (args, state) => this.matchesReviewFilters(args, state));
    this.cards.reviewBecameAlert.registerRunListener(async (args, state) => this.matchesReviewFilters(args, state));
    this.cards.reviewEnded.registerRunListener(async (args, state) => this.matchesReviewFilters(args, state));

    this.cards.reviewGenaiReady.registerRunListener(async (args, state) => {
      return this.matchesReviewFilters(args, state)
        && state.confidence >= this.numberOrDefault(args.min_confidence, 0)
        && state.potential_threat_level >= this.numberOrDefault(args.min_threat_level, 0)
        && state.potential_threat_level <= this.numberOrDefault(args.max_threat_level, 10);
    });
  }

  connectMqtt() {
    const settings = this.getMqttSettings();

    if (!settings.host) {
      this.log('MQTT host is not configured; Frigate MQTT connection skipped.');
      return;
    }

    const url = `${settings.protocol}://${settings.host}:${settings.port}`;
    const options = {
      clientId: settings.clientId,
      clean: true,
      reconnectPeriod: 10000,
    };

    if (settings.username) options.username = settings.username;
    if (settings.password) options.password = settings.password;

    this.log(`Connecting to MQTT broker ${url}`);
    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log('Connected to MQTT broker.');
      this.subscribeFrigateTopics();
    });

    this.mqttClient.on('message', (topic, message) => this.onMqttMessage(topic, message));
    this.mqttClient.on('error', (err) => this.error(err));
    this.mqttClient.on('close', () => this.log('MQTT connection closed.'));
  }

  reconnectMqtt() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }

    this.connectMqtt();
  }

  subscribeFrigateTopics() {
    const prefix = this.getTopicPrefix();
    const topics = [
      `${prefix}/tracked_object_update`,
      `${prefix}/reviews`,
    ];

    this.mqttClient.subscribe(topics, (err) => {
      if (err) {
        this.error(err);
        return;
      }

      this.log(`Subscribed to ${topics.join(', ')}`);
    });
  }

  onMqttMessage(topic, message) {
    const prefix = this.getTopicPrefix();
    let payload;

    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      this.error(`Failed to parse MQTT payload for topic ${topic}: ${err.message}`);
      return;
    }

    if (topic === `${prefix}/tracked_object_update`) {
      this.handleTrackedObjectUpdate(payload);
      return;
    }

    if (topic === `${prefix}/reviews`) {
      this.handleReview(payload);
    }
  }

  handleTrackedObjectUpdate(payload) {
    const tokens = this.normalizeTrackedObjectTokens(payload);
    const state = { ...tokens };

    this.cards.trackedObjectUpdate.trigger(tokens, state).catch((err) => this.error(err));

    if (payload.type === 'description') {
      this.cards.objectDescriptionUpdated.trigger({
        id: tokens.id,
        camera: tokens.camera,
        description: tokens.description,
        raw_json: tokens.raw_json,
      }, state).catch((err) => this.error(err));
    }

    if (payload.type === 'face') {
      this.cards.faceRecognized.trigger({
        id: tokens.id,
        camera: tokens.camera,
        name: tokens.name,
        score: tokens.score,
        timestamp: tokens.timestamp,
        raw_json: tokens.raw_json,
      }, state).catch((err) => this.error(err));
    }

    if (payload.type === 'lpr') {
      this.cards.licensePlateRecognized.trigger({
        id: tokens.id,
        camera: tokens.camera,
        plate: tokens.plate,
        name: tokens.name,
        score: tokens.score,
        timestamp: tokens.timestamp,
        raw_json: tokens.raw_json,
      }, state).catch((err) => this.error(err));
    }
  }

  handleReview(payload) {
    const tokens = this.normalizeReviewTokens(payload);
    const state = { ...tokens };

    if (payload.type === 'new') {
      this.cards.reviewStarted.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (payload.type === 'update' && payload.before?.severity !== 'alert' && payload.after?.severity === 'alert') {
      this.cards.reviewBecameAlert.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (payload.type === 'end') {
      this.cards.reviewEnded.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (payload.type === 'genai' && payload.after?.data?.metadata) {
      this.cards.reviewGenaiReady.trigger(tokens, state).catch((err) => this.error(err));
    }
  }

  normalizeTrackedObjectTokens(payload) {
    return {
      id: this.stringValue(payload.id),
      update_type: this.stringValue(payload.type),
      camera: this.stringValue(payload.camera),
      timestamp: this.numberOrDefault(payload.timestamp, 0),
      description: this.stringValue(payload.description),
      name: this.stringValue(payload.name),
      score: this.numberOrDefault(payload.score, 0),
      plate: this.stringValue(payload.plate),
      model: this.stringValue(payload.model),
      sub_label: this.stringValue(payload.sub_label),
      attribute: this.stringValue(payload.attribute),
      raw_json: JSON.stringify(payload),
    };
  }

  normalizeReviewTokens(payload) {
    const review = payload.after || payload.before || {};
    const data = review.data || {};
    const metadata = data.metadata || {};

    return {
      review_id: this.stringValue(review.id),
      review_type: this.stringValue(payload.type),
      camera: this.stringValue(review.camera),
      severity: this.stringValue(review.severity),
      start_time: this.numberOrDefault(review.start_time, 0),
      end_time: this.numberOrDefault(review.end_time, 0),
      objects: this.joinValues(data.objects),
      verified_objects: this.joinValues(data.verified_objects),
      sub_labels: this.joinValues(data.sub_labels),
      zones: this.joinValues(data.zones),
      audio: this.joinValues(data.audio),
      detection_ids: this.joinValues(data.detections),
      thumb_path: this.buildFrigateUrl(review.thumb_path),
      thumb_time: this.numberOrDefault(data.thumb_time, 0),
      title: this.stringValue(metadata.title),
      scene: this.stringValue(metadata.scene),
      short_summary: this.stringValue(metadata.shortSummary),
      confidence: this.numberOrDefault(metadata.confidence, 0),
      potential_threat_level: this.numberOrDefault(metadata.potential_threat_level, 0),
      other_concerns: this.stringValue(metadata.other_concerns),
      time: this.stringValue(metadata.time),
      raw_json: JSON.stringify(payload),
    };
  }

  matchesReviewFilters(args, state) {
    return this.matchesTextFilter(args.severity, state.severity, true)
      && this.matchesTextFilter(args.camera, state.camera)
      && this.matchesContainsFilter(args.object, state.objects)
      && this.matchesContainsFilter(args.zone, state.zones);
  }

  matchesTextFilter(filterValue, actualValue, allowAny = false) {
    if (!filterValue || (allowAny && filterValue === 'any')) return true;
    return this.stringValue(actualValue).toLowerCase() === this.stringValue(filterValue).toLowerCase();
  }

  matchesContainsFilter(filterValue, actualValue) {
    if (!filterValue) return true;
    return this.stringValue(actualValue).toLowerCase().split(',').map((value) => value.trim()).includes(this.stringValue(filterValue).toLowerCase());
  }

  getMqttSettings() {
    const protocol = this.homey.settings.get('mqttProtocol') || 'mqtt';
    const host = this.homey.settings.get('mqttHost') || '';
    const defaultPort = protocol === 'mqtts' ? 8883 : 1883;

    return {
      protocol,
      host,
      port: this.homey.settings.get('mqttPort') || defaultPort,
      username: this.homey.settings.get('mqttUsername') || '',
      password: this.homey.settings.get('mqttPassword') || '',
      clientId: this.homey.settings.get('mqttClientId') || `homey-frigate-${Math.random().toString(16).slice(2)}`,
    };
  }

  getTopicPrefix() {
    return (this.homey.settings.get('topicPrefix') || DEFAULT_TOPIC_PREFIX).replace(/^\/+|\/+$/g, '');
  }

  isMqttSetting(key) {
    return [
      'mqttProtocol',
      'mqttHost',
      'mqttPort',
      'mqttUsername',
      'mqttPassword',
      'mqttClientId',
      'topicPrefix',
    ].includes(key);
  }

  buildFrigateUrl(value) {
    const path = this.stringValue(value);
    const baseUrl = this.stringValue(this.homey.settings.get('frigateBaseUrl')).replace(/\/$/, '');

    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    if (!baseUrl) return path;

    return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  joinValues(value) {
    if (!Array.isArray(value)) return '';
    return value.filter((item) => item !== null && item !== undefined).join(', ');
  }

  stringValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  numberOrDefault(value, defaultValue) {
    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
  }
}

module.exports = FrigateApp;
