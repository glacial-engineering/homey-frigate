'use strict';

const Homey = require('homey');
const http = require('http');
const https = require('https');

class FrigateCameraDriver extends Homey.Driver {
  async onPair(session) {
    session.setHandler('list_devices', async () => {
      const baseUrl = this.homey.settings.get('frigateBaseUrl');

      if (!baseUrl) {
        throw new Error('Frigate base URL is not configured in app settings. Configure it first in the app settings.');
      }

      const cameras = await this.discoverCameras(baseUrl);

      if (cameras.length === 0) {
        throw new Error('No cameras found. Check that the Frigate base URL is correct and Frigate is running.');
      }

      return cameras.map((camera) => ({
        name: camera,
        data: { id: camera, cameraName: camera },
      }));
    });
  }

  async discoverCameras(baseUrl) {
    const normalizedUrl = baseUrl.replace(/\/$/, '');
    const configUrl = `${normalizedUrl}/api/config`;

    this.log('Fetching camera list from:', configUrl);

    let response;
    try {
      response = await this.fetchJson(configUrl);
    } catch (err) {
      this.error('Failed to fetch Frigate config:', err.message);
      throw new Error(`Could not reach Frigate at ${configUrl}. Error: ${err.message}`);
    }

    this.log('Frigate config response keys:', Object.keys(response || {}).join(', '));

    const cameras = response?.cameras;

    if (!cameras || typeof cameras !== 'object') {
      this.error('No cameras field in Frigate config. Response:', JSON.stringify(response).slice(0, 500));
      return [];
    }

    const cameraNames = Object.keys(cameras);
    this.log('Found cameras:', cameraNames.join(', '));
    return cameraNames;
  }

  async fetchJson(url) {
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

        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }
}

module.exports = FrigateCameraDriver;
