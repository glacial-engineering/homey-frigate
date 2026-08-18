'use strict';

const Homey = require('homey');
const http = require('http');
const https = require('https');

const DEFAULT_RTSP_PORT = 8554;

class FrigateCameraDevice extends Homey.Device {
  async onInit() {
    this.log('FrigateCameraDevice initialized:', this.getName());

    await this.ensureCapabilities();

    this.log('Setting up camera image for', this.getName());

    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      this.log('Camera image stream requested for', this.getName());
      try {
        const buffer = await this.fetchSnapshot();
        this.log('Snapshot fetched, buffer size:', buffer?.length || 0);
        stream.end(buffer);
      } catch (err) {
        this.error('Failed to fetch snapshot:', err.message);
        stream.destroy(err);
      }
    });

    await this.setCameraImage('main', 'Snapshot', image);

    this.log('Setting up live stream for', this.getName());

    const video = await this.homey.videos.createVideoRTSP();
    video.registerVideoUrlListener(async () => {
      const url = this.getRtspUrl();
      this.log('Video URL requested, returning:', url);
      return { url };
    });

    await this.setCameraVideo('main', 'Live', video);

    const data = this.getData();
    this.homey.app.registerCameraDevice(data.cameraName || data.id, this);
  }

  async onDeleted() {
    const data = this.getData();
    this.homey.app.unregisterCameraDevice(data.cameraName || data.id, this);
  }

  async ensureCapabilities() {
    const caps = ['alarm_motion', 'alarm_detection', 'alarm_alert', 'frigate_current_objects', 'frigate_current_zones'];
    for (const cap of caps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
      if (cap.startsWith('alarm_')) {
        await this.setCapabilityValue(cap, false);
      } else {
        await this.setCapabilityValue(cap, '');
      }
    }
  }

  async setFrigateState(state) {
    const promises = [
      this.setCapabilityValue('alarm_motion', state.motion),
      this.setCapabilityValue('alarm_detection', state.detection),
      this.setCapabilityValue('alarm_alert', state.alert),
      this.setCapabilityValue('frigate_current_objects', state.objects),
      this.setCapabilityValue('frigate_current_zones', state.zones),
    ];
    await Promise.all(promises);
  }

  getRtspUrl() {
    const baseUrl = this.homey.settings.get('frigateBaseUrl');
    const streamName = this.getSetting('streamName');
    const port = this.homey.settings.get('frigateRtspPort') || DEFAULT_RTSP_PORT;

    if (!baseUrl || !streamName) {
      throw new Error('Frigate base URL or live stream not configured. Set the stream name in this device\'s settings.');
    }

    const { hostname } = new URL(baseUrl);
    return `rtsp://${hostname}:${port}/${encodeURIComponent(streamName)}`;
  }

  async fetchSnapshot() {
    const data = this.getData();
    const baseUrl = this.homey.settings.get('frigateBaseUrl');
    const cameraName = data.cameraName || data.id;

    if (!baseUrl || !cameraName) {
      throw new Error('Frigate base URL or camera name not configured.');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/${encodeURIComponent(cameraName)}/latest.jpg`;
    this.log('Fetching snapshot from:', url);
    return this.fetchImage(url);
  }

  async fetchImage(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const request = transport.get(parsedUrl, {
        timeout: 10000,
      }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }
}

module.exports = FrigateCameraDevice;
