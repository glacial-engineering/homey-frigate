'use strict';

const Homey = require('homey');
const http = require('http');
const https = require('https');

class FrigateCameraDevice extends Homey.Device {
  async onInit() {
    this.log('FrigateCameraDevice initialized:', this.getName());

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

    await this.setCameraImage('snapshot', 'Snapshot', image);
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
