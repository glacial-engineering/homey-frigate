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

  async getFrigateAuthHeaders() {
    if (this.frigateToken) {
      return { authorization: `Bearer ${this.frigateToken}` };
    }

    const username = this.homey.settings.get('frigateUsername') || '';
    const password = this.homey.settings.get('frigatePassword') || '';

    if (!username && !password) return {};

    await this.loginFrigate(username, password);
    return { authorization: `Bearer ${this.frigateToken}` };
  }

  async loginFrigate(username, password) {
    const baseUrl = this.homey.settings.get('frigateBaseUrl') || '';
    const normalizedUrl = baseUrl.replace(/\/$/, '');
    const loginUrl = `${normalizedUrl}/api/login`;

    this.log('Logging in to Frigate at:', loginUrl);

    const response = await this.postJson(loginUrl, { user: username, password });

    this.log('Frigate login response status:', response.statusCode);
    this.log('Frigate login response headers:', JSON.stringify(response.headers));
    this.log('Frigate login response body:', JSON.stringify(response.body));

    if (response.statusCode >= 400) {
      throw new Error(`Frigate login failed with HTTP ${response.statusCode}: ${response.text?.slice(0, 200) || ''}`);
    }

    // Frigate may return token in body or as cookie
    let token = response.body?.access_token || response.body?.token;

    if (!token) {
      const setCookie = response.headers['set-cookie'];
      this.log('Frigate login set-cookie header:', JSON.stringify(setCookie));
      if (setCookie) {
        const match = Array.isArray(setCookie)
          ? setCookie.join('; ').match(/token=([^;]+)/)
          : String(setCookie).match(/token=([^;]+)/);
        if (match) token = match[1];
      }
    }

    if (!token) {
      throw new Error('Frigate login succeeded but no token was returned. Check credentials and Frigate version.');
    }

    this.frigateToken = token;
    this.log('Frigate login successful, JWT token obtained');
  }

  async postJson(url, payload) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(payload));

      const request = transport.request(parsedUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
        timeout: 10000,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(responseBody);
          } catch {
            json = null;
          }
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: json,
            text: responseBody,
          });
        });
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
      request.write(body);
      request.end();
    });
  }

  async fetchJson(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const attempt = async () => {
        try {
          const headers = await this.getFrigateAuthHeaders();

          const request = transport.get(parsedUrl, {
            timeout: 10000,
            headers,
          }, (response) => {
            if (response.statusCode === 401 && this.frigateToken) {
              this.frigateToken = null;
              attempt().then(resolve).catch(reject);
              return;
            }

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
        } catch (err) {
          reject(err);
        }
      };

      attempt();
    });
  }
}

module.exports = FrigateCameraDriver;
