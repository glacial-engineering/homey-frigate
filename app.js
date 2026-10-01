const Homey = require('homey');
const mqtt = require('mqtt');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

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
      eventNewLabel: this.homey.flow.getTriggerCard('event_new_label'),
      eventNewSubLabel: this.homey.flow.getTriggerCard('event_new_sub_label'),
      reviewContainsAll: this.homey.flow.getTriggerCard('review_contains_all'),
      doorbellPress: this.homey.flow.getTriggerCard('doorbell_press'),
      doorbellUnanswered: this.homey.flow.getTriggerCard('doorbell_unanswered'),
      stateClassificationChanged: this.homey.flow.getTriggerCard('state_classification_changed'),
      objectDetectionChanged: this.homey.flow.getTriggerCard('object_detection_changed'),
      createRecordingExport: this.homey.flow.getActionCard('create_recording_export'),
    };

    this.alarmCards = {
      alarm_detection: {
        true: this.homey.flow.getDeviceTriggerCard('frigate_detection_on'),
        false: this.homey.flow.getDeviceTriggerCard('frigate_detection_off'),
      },
      alarm_alert: {
        true: this.homey.flow.getDeviceTriggerCard('frigate_alert_on'),
        false: this.homey.flow.getDeviceTriggerCard('frigate_alert_off'),
      },
    };

    this.classificationStates = {};
    this.cameraDevices = new Map();
    this.zoneDevices = new Map();
    this.zoneDetections = new Map();
    this.zoneAlerts = new Map();
    this.objectZones = new Map();
    this.reviews = new Map();
    this.motionStates = new Map();
    this.alarmValues = new Map();
    this.objectCounts = new Map();

    this.registerTriggerListeners();
    this.registerActionListeners();
    this.registerConditionListeners();
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

    this.cards.eventNewLabel.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.new_label, state.new_label);
    });

    this.cards.eventNewSubLabel.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.new_sub_label, state.new_sub_label);
    });

    this.cards.reviewContainsAll.registerRunListener(async (args, state) => {
      if (!this.matchesTextFilter(args.camera, state.camera)) return false;

      const requiredLabels = this.parseCommaList(args.labels);
      const requiredSubLabels = this.parseCommaList(args.sub_labels);

      if (requiredLabels.length === 0 && requiredSubLabels.length === 0) return false;

      const afterObjects = state.after_objects || [];
      const afterSubLabels = state.after_sub_labels || [];
      const beforeObjects = state.before_objects || [];
      const beforeSubLabels = state.before_sub_labels || [];

      const allLabelsPresent = requiredLabels.every((l) => afterObjects.includes(l));
      const allSubLabelsPresent = requiredSubLabels.every((l) => afterSubLabels.includes(l));

      if (!allLabelsPresent || !allSubLabelsPresent) return false;

      if (state.review_type === 'new') return true;

      const labelsNewlyAdded = requiredLabels.some((l) => !beforeObjects.includes(l));
      const subLabelsNewlyAdded = requiredSubLabels.some((l) => !beforeSubLabels.includes(l));

      return labelsNewlyAdded || subLabelsNewlyAdded;
    });

    this.cards.stateClassificationChanged.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.model, state.model)
        && this.matchesTextFilter(args.state, state.state);
    });

    this.cards.objectDetectionChanged.registerRunListener(async (args, state) => {
      return this.matchesTextFilter(args.camera, state.camera)
        && this.matchesTextFilter(args.zone, state.zone)
        && this.matchesTextFilter(args.object, state.object)
        && (!args.state || args.state === 'any' || (args.state === 'true') === state.state);
    });
  }

  registerActionListeners() {
    this.cards.createRecordingExport.registerRunListener(async (args) => {
      return this.createRecordingExport(args.camera, args.seconds, args.name_prefix);
    });
  }

  registerConditionListeners() {
    this.homey.flow.getConditionCard('frigate_current_objects_contains').registerRunListener(async (args) => {
      const value = args.device.getCapabilityValue('frigate_current_objects') || '';
      return this.matchesContainsFilter(args.object, value);
    });

    this.homey.flow.getConditionCard('frigate_current_zones_contains').registerRunListener(async (args) => {
      const value = args.device.getCapabilityValue('frigate_current_zones') || '';
      return this.matchesContainsFilter(args.zone, value);
    });
  }

  async createRecordingExport(camera, seconds, namePrefix) {
    const baseUrl = this.stringValue(this.homey.settings.get('frigateBaseUrl')).replace(/\/$/, '');

    if (!baseUrl) {
      throw new Error('Frigate base URL is not configured in the app settings.');
    }

    const endTime = Date.now() / 1000;
    const startTime = endTime - this.numberOrDefault(seconds, 0);
    const url = `${baseUrl}/api/export/${encodeURIComponent(camera)}/start/${startTime}/end/${endTime}`;

    // Frigate's own default name is "<camera> <start> <end>" (server-local
    // time). Replicate that format here so a custom prefix swaps in for the
    // camera name but the timestamps still match what Frigate would produce.
    //
    // Format in the home's timezone, not the app runtime's: the SDK v3 sandbox
    // runs the clock in UTC, so Date's local-time getters would emit UTC here.
    const timezone = await this.homey.clock.getTimezone();
    const prefix = this.stringValue(namePrefix).trim() || camera;
    const name = `${prefix} ${this.formatExportTimestamp(startTime, timezone)} ${this.formatExportTimestamp(endTime, timezone)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playback: 'realtime', name }),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Frigate export request failed (${response.status}): ${body.message || response.statusText}`);
    }

    const exportId = this.stringValue(body.export_id);
    const exportDetails = await this.waitForExport(baseUrl, exportId, 10000);
    // The export may still be generating its thumbnail when we give up
    // waiting; fall back to the camera's live snapshot so both thumb
    // tokens always have something to show.
    const thumbUrl = exportDetails.thumb_path
      ? this.buildFrigateMediaUrl(exportDetails.thumb_path)
      : `${baseUrl}/api/${encodeURIComponent(camera)}/latest.jpg`;

    return {
      export_id: exportId,
      message: this.stringValue(body.message),
      video_path: this.buildFrigateMediaUrl(exportDetails.video_path),
      thumb_path: thumbUrl,
      thumb_image: await this.buildImageToken(thumbUrl),
    };
  }

  // Homey's Image#setUrl requires an https:// URL reachable from any
  // network; frigateBaseUrl is typically a plain-HTTP LAN address, so
  // stream the bytes through the app instead (same approach the camera
  // device uses for snapshots).
  async buildImageToken(url) {
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch thumbnail (${response.status})`);
      await pipeline(Readable.fromWeb(response.body), stream);
    });
    return image;
  }

  async waitForExport(baseUrl, exportId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2000;
    let lastDetails = {};

    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/exports/${encodeURIComponent(exportId)}`);

      if (response.ok) {
        lastDetails = await response.json().catch(() => ({}));
        if (lastDetails.video_path && lastDetails.thumb_path) return lastDetails;
      }

      await this.sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
    }

    // Give up waiting but still return whatever the export API last
    // reported (video_path is usually available well before thumb_path),
    // so callers can fall back rather than fail the whole action.
    this.log(`Timed out after ${timeoutMs / 1000}s waiting for Frigate export ${exportId} to fully complete; using last known state.`);
    return lastDetails;
  }

  sleep(ms) {
    return new Promise((resolve) => this.homey.setTimeout(resolve, ms));
  }

  formatExportTimestamp(epochSeconds, timezone) {
    const date = new Date(epochSeconds * 1000);
    // The runtime clock is UTC, so derive the wall-clock fields from the
    // home's IANA timezone rather than Date's local-time getters.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(date).map((p) => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
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
      `${prefix}/events`,
      `${prefix}/tracked_object_update`,
      `${prefix}/reviews`,
      `${prefix}/doorbell/press`,
      `${prefix}/doorbell/press_unanswered`,
      `${prefix}/+/classification/+`,
      `${prefix}/+/motion`,
      `${prefix}/+/+`,
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

    // Doorbell topics carry a plain "ON"/"OFF" string, not JSON. Handle them
    // before the JSON.parse below, and only act on the leading "ON" edge so the
    // trailing "OFF" reset pulse does not fire the trigger a second time.
    if (topic === `${prefix}/doorbell/press` || topic === `${prefix}/doorbell/press_unanswered`) {
      this.handleDoorbell(topic, message.toString().trim());
      return;
    }

    // Classification topics are frigate/<camera>/classification/<model> with a
    // plain state-name payload (e.g. "open"), not JSON. Match before JSON.parse.
    const classificationMatch = topic.match(new RegExp(`^${this.escapeRegExp(prefix)}/([^/]+)/classification/([^/]+)$`));
    if (classificationMatch) {
      this.handleStateClassification(classificationMatch[1], classificationMatch[2], message.toString().trim());
      return;
    }

    const motionMatch = topic.match(new RegExp(`^${this.escapeRegExp(prefix)}/([^/]+)/motion$`));
    if (motionMatch) {
      this.handleMotion(motionMatch[1], message.toString().trim());
      return;
    }

    // Frigate's native per-camera/per-zone object count topics, e.g.
    // frigate/doorbell/package or frigate/porch/package, carry a plain
    // integer count (not JSON). Any other two-segment topic under the
    // prefix is handled above with an explicit match, so this is a safe
    // catch-all; non-numeric payloads are ignored.
    const objectCountMatch = topic.match(new RegExp(`^${this.escapeRegExp(prefix)}/([^/]+)/([^/]+)$`));
    if (objectCountMatch && /^\d+$/.test(message.toString().trim())) {
      this.handleObjectCount(objectCountMatch[1], objectCountMatch[2], message.toString().trim());
      return;
    }

    let payload;

    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      this.error(`Failed to parse MQTT payload for topic ${topic}: ${err.message}`);
      return;
    }

    if (topic === `${prefix}/events`) {
      this.handleEvent(payload);
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

    const isNewAlert = payload.type === 'new' && payload.after?.severity === 'alert';
    const isEscalatedAlert = payload.type === 'update' && payload.before?.severity !== 'alert' && payload.after?.severity === 'alert';

    if (isNewAlert || isEscalatedAlert) {
      this.cards.reviewBecameAlert.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (payload.type === 'end') {
      this.cards.reviewEnded.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (payload.type === 'genai' && payload.after?.data?.metadata) {
      this.cards.reviewGenaiReady.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (['new', 'update', 'end'].includes(payload.type)) {
      const reviewState = {
        ...state,
        before_objects: this.arrayValue(payload.before?.data?.objects),
        after_objects: this.arrayValue(payload.after?.data?.objects),
        before_sub_labels: this.arrayValue(payload.before?.data?.sub_labels),
        after_sub_labels: this.arrayValue(payload.after?.data?.sub_labels),
      };
      this.cards.reviewContainsAll.trigger(tokens, reviewState).catch((err) => this.error(err));
      this.trackAndApplyReview(payload);
    }
  }

  handleEvent(payload) {
    this.updateObjectZones(payload);

    const tokens = this.normalizeEventTokens(payload);
    const state = { ...tokens };

    if (tokens.new_label) {
      this.cards.eventNewLabel.trigger(tokens, state).catch((err) => this.error(err));
    }

    if (tokens.new_sub_label) {
      this.cards.eventNewSubLabel.trigger(tokens, state).catch((err) => this.error(err));
    }
  }

  handleDoorbell(topic, value) {
    if (value.toUpperCase() !== 'ON') return; // ignore the OFF reset pulse

    const tokens = { pressed_at: Date.now() };
    const card = topic.endsWith('/press_unanswered')
      ? this.cards.doorbellUnanswered
      : this.cards.doorbellPress;

    card.trigger(tokens, {}).catch((err) => this.error(err));
  }

  handleStateClassification(camera, model, state) {
    if (!state) return;

    const key = `${camera}/${model}`;
    const previousState = this.classificationStates[key] || '';
    this.classificationStates[key] = state;

    const tokens = {
      camera,
      model,
      state,
      previous_state: previousState,
    };

    this.cards.stateClassificationChanged.trigger(tokens, tokens).catch((err) => this.error(err));
  }

  escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  normalizeEventTokens(payload) {
    const before = payload.before || {};
    const after = payload.after || {};
    const eventType = this.stringValue(payload.type);

    const currentLabel = this.stringValue(after.label);
    const currentSubLabel = this.extractSubLabel(after.sub_label);
    const currentZones = this.joinValues(after.current_zones);
    const currentAttributes = this.joinValues((after.current_attributes || []).map((a) => a.label));

    const newLabel = this.computeNewValue(eventType, before.label, after.label);
    const newSubLabel = this.computeNewSubLabel(eventType, before.sub_label, after.sub_label);
    const newZones = this.computeNewArray(eventType, before.current_zones, after.current_zones);
    const newAttributes = this.computeNewAttributes(eventType, before.current_attributes, after.current_attributes);

    return {
      event_id: this.stringValue(after.id),
      event_type: eventType,
      camera: this.stringValue(after.camera),
      current_label: currentLabel,
      new_label: newLabel,
      current_sub_label: currentSubLabel,
      new_sub_label: newSubLabel,
      current_top_score: this.numberOrDefault(after.top_score, 0),
      current_zones: currentZones,
      new_zones: newZones,
      current_attributes: currentAttributes,
      new_attributes: newAttributes,
      raw_json: JSON.stringify(payload),
    };
  }

  computeNewValue(eventType, beforeValue, afterValue) {
    if (eventType === 'new') return this.stringValue(afterValue);
    const before = this.stringValue(beforeValue);
    const after = this.stringValue(afterValue);
    return after && after !== before ? after : '';
  }

  computeNewSubLabel(eventType, beforeValue, afterValue) {
    if (eventType === 'new') return this.extractSubLabel(afterValue);
    const before = this.extractSubLabel(beforeValue);
    const after = this.extractSubLabel(afterValue);
    return after && after !== before ? after : '';
  }

  computeNewArray(eventType, beforeValue, afterValue) {
    const afterArr = Array.isArray(afterValue) ? afterValue : [];
    if (eventType === 'new') return this.joinValues(afterArr);
    const beforeArr = Array.isArray(beforeValue) ? beforeValue : [];
    const beforeSet = new Set(beforeArr);
    const added = afterArr.filter((item) => !beforeSet.has(item));
    return this.joinValues(added);
  }

  computeNewAttributes(eventType, beforeValue, afterValue) {
    const afterArr = Array.isArray(afterValue) ? afterValue : [];
    if (eventType === 'new') return this.joinValues(afterArr.map((a) => a.label));
    const beforeArr = Array.isArray(beforeValue) ? beforeValue : [];
    const beforeSet = new Set(beforeArr.map((a) => a.label));
    const added = afterArr.filter((a) => !beforeSet.has(a.label));
    return this.joinValues(added.map((a) => a.label));
  }

  extractSubLabel(value) {
    if (Array.isArray(value) && value.length > 0) return this.stringValue(value[0]);
    return this.stringValue(value);
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

  // Export video/thumb paths are container filesystem paths under
  // /media/frigate/... (e.g. /media/frigate/exports/x.mp4), served by
  // Frigate's web server with that prefix stripped (e.g. /exports/x.mp4).
  buildFrigateMediaUrl(value) {
    const path = this.stringValue(value).replace(/^\/media\/frigate/, '');
    return this.buildFrigateUrl(path);
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

  parseCommaList(value) {
    if (!value) return [];
    return this.stringValue(value).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  }

  arrayValue(value) {
    if (Array.isArray(value)) return value.map((v) => this.stringValue(v).toLowerCase());
    return [];
  }

  registerCameraDevice(cameraName, device) {
    if (!this.cameraDevices.has(cameraName)) this.cameraDevices.set(cameraName, new Set());
    this.cameraDevices.get(cameraName).add(device);
    device.setFrigateState(this.computeCameraState(cameraName)).catch((err) => this.error(err));
  }

  unregisterCameraDevice(cameraName, device) {
    this.cameraDevices.get(cameraName)?.delete(device);
  }

  handleMotion(cameraName, value) {
    const isMotion = value.toUpperCase() === 'ON';
    this.motionStates.set(cameraName, isMotion);
    this.pushCameraState(cameraName);
  }

  handleObjectCount(scope, object, countStr) {
    const key = `${scope}/${object}`;
    const wasActive = (this.objectCounts.get(key) || 0) > 0;
    const count = parseInt(countStr, 10);
    this.objectCounts.set(key, count);

    const isActive = count > 0;
    if (wasActive === isActive) return; // only fire on the 0<->nonzero edge

    const isZone = this.zoneDevices.has(this.normalizeZoneName(scope));
    const tokens = {
      camera: isZone ? '' : scope,
      zone: isZone ? scope : '',
      object,
      state: isActive,
    };

    this.cards.objectDetectionChanged.trigger(tokens, tokens).catch((err) => this.error(err));
  }

  trackAndApplyReview(payload) {
    const before = payload.before || {};
    const after = payload.after || {};
    const id = after.id || before.id;
    if (!id) return;

    if (payload.type === 'end') {
      this.reviews.delete(id);
    } else {
      this.reviews.set(id, {
        id,
        camera: after.camera || before.camera || '',
        severity: after.severity || before.severity || '',
        objects: this.arrayValue(after.data?.objects || before.data?.objects),
        zones: this.zoneList(after.data?.zones || before.data?.zones),
      });
    }

    const camera = after.camera || before.camera;
    if (camera) this.pushCameraState(camera);

    const affectedZones = new Set([
      ...this.zoneList(before.data?.zones),
      ...this.zoneList(after.data?.zones),
    ]);
    for (const zone of affectedZones) {
      this.pushZoneState(zone);
    }
  }

  computeCameraState(cameraName) {
    const motion = !!this.motionStates.get(cameraName);
    const objects = new Set();
    const zones = new Set();
    let detection = false;
    let alert = false;

    for (const review of this.reviews.values()) {
      if (review.camera !== cameraName) continue;
      detection = true;
      if (review.severity === 'alert') alert = true;
      review.objects.forEach((o) => objects.add(o));
      review.zones.forEach((z) => zones.add(z));
    }

    return {
      motion,
      detection,
      alert,
      objects: [...objects].join(', '),
      zones: [...zones].join(', '),
    };
  }

  pushCameraState(cameraName) {
    const devices = this.cameraDevices.get(cameraName);
    if (!devices) return;

    const state = this.computeCameraState(cameraName);
    for (const device of devices) {
      device.setFrigateState(state).catch((err) => this.error(err));
      this.handleAlarmChange(device, 'alarm_detection', state.detection).catch((err) => this.error(err));
      this.handleAlarmChange(device, 'alarm_alert', state.alert).catch((err) => this.error(err));
    }
  }

  registerZoneDevice(zoneName, device) {
    const key = this.normalizeZoneName(zoneName);
    if (!this.zoneDevices.has(key)) this.zoneDevices.set(key, new Set());
    this.zoneDevices.get(key).add(device);
    device.setZoneState(this.computeZoneState(key)).catch((err) => this.error(err));
  }

  unregisterZoneDevice(zoneName, device) {
    const key = this.normalizeZoneName(zoneName);
    this.zoneDevices.get(key)?.delete(device);
  }

  computeZoneState(zoneName) {
    const key = this.normalizeZoneName(zoneName);
    return {
      detection: (this.zoneDetections.get(key)?.size || 0) > 0,
      alert: (this.zoneAlerts.get(key)?.size || 0) > 0,
    };
  }

  pushZoneState(zoneName) {
    const key = this.normalizeZoneName(zoneName);
    const devices = this.zoneDevices.get(key);
    if (!devices) return;

    const state = this.computeZoneState(key);
    for (const device of devices) {
      device.setZoneState(state).catch((err) => this.error(err));
      this.handleAlarmChange(device, 'alarm_detection', state.detection).catch((err) => this.error(err));
      this.handleAlarmChange(device, 'alarm_alert', state.alert).catch((err) => this.error(err));
    }
  }

  async handleAlarmChange(device, capability, value) {
    const card = this.alarmCards[capability]?.[value ? 'true' : 'false'];
    if (!card) return;

    // Only fire on real transitions; state is recomputed on every MQTT message.
    const key = `${device.driver.id}:${device.getData().id}:${capability}`;
    if (this.alarmValues.get(key) === value) return;
    this.alarmValues.set(key, value);

    await card.trigger(device);
  }

  normalizeZoneName(value) {
    return this.stringValue(value).toLowerCase().replace(/\s+/g, '_');
  }

  zoneList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => this.normalizeZoneName(v));
  }

  updateObjectZones(payload) {
    const before = payload.before || {};
    const after = payload.after || {};
    const id = after.id || before.id;
    if (!id) return;

    const beforeZones = this.objectZones.get(id) || new Set();
    const isEnded = payload.type === 'end' || after.end_time != null;
    const afterZones = isEnded ? new Set() : new Set(this.zoneList(after.current_zones));
    const afterLabel = this.stringValue(after.label || before.label).toLowerCase();
    const isAlert = this.isAlertLabel(afterLabel);

    const affectedZones = new Set([...beforeZones, ...afterZones]);

    for (const zone of affectedZones) {
      const inAfter = afterZones.has(zone);
      const inBefore = beforeZones.has(zone);

      if (inAfter) {
        if (!inBefore) this.addObjectToZone(zone, id);
        this.setZoneAlert(zone, id, isAlert);
      } else if (inBefore) {
        this.removeObjectFromZone(zone, id);
      }

      this.pushZoneState(zone);
    }

    if (afterZones.size === 0) {
      this.objectZones.delete(id);
    } else {
      this.objectZones.set(id, afterZones);
    }
  }

  isAlertLabel(label) {
    return ['person', 'car'].includes(this.stringValue(label).toLowerCase());
  }

  addObjectToZone(zone, id) {
    if (!this.zoneDetections.has(zone)) this.zoneDetections.set(zone, new Set());
    this.zoneDetections.get(zone).add(id);
  }

  removeObjectFromZone(zone, id) {
    this.zoneDetections.get(zone)?.delete(id);
    this.zoneAlerts.get(zone)?.delete(id);
    if (this.zoneDetections.get(zone)?.size === 0) this.zoneDetections.delete(zone);
    if (this.zoneAlerts.get(zone)?.size === 0) this.zoneAlerts.delete(zone);
  }

  setZoneAlert(zone, id, isAlert) {
    if (!this.zoneAlerts.has(zone)) this.zoneAlerts.set(zone, new Set());
    const alertSet = this.zoneAlerts.get(zone);
    if (isAlert) {
      alertSet.add(id);
    } else {
      alertSet.delete(id);
    }
    if (alertSet.size === 0) this.zoneAlerts.delete(zone);
  }
}

module.exports = FrigateApp;
