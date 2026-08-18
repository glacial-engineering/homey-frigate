'use strict';

const Homey = require('homey');
const http = require('http');
const https = require('https');

class FrigateZoneDriver extends Homey.Driver {
  async onPairListDevices() {
    const baseUrl = this.homey.settings.get('frigateBaseUrl');

    if (!baseUrl) {
      throw new Error('Frigate base URL is not configured in app settings.');
    }

    const config = await this.fetchJson(`${baseUrl.replace(/\/$/, '')}/api/config`);
    const cameras = config?.cameras || {};
    const found = new Map();

    for (const camera of Object.values(cameras)) {
      for (const zone of Object.keys(camera?.zones || {})) {
        const id = zone.toLowerCase().replace(/\s+/g, '_');
        if (!found.has(id)) found.set(id, zone);
      }
    }

    return Array.from(found.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, zone]) => ({ name: zone, data: { id, zoneName: zone } }));
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

module.exports = FrigateZoneDriver;
