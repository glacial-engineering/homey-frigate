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

    let token = response.body?.access_token || response.body?.token;

    if (!token) {
      const setCookie = response.headers['set-cookie'];
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

  async fetchImage(url) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const attempt = async () => {
        try {
          const headers = await this.getFrigateAuthHeaders();
          this.log('Snapshot request headers:', JSON.stringify(headers));

          const request = transport.get(parsedUrl, {
            timeout: 10000,
            headers,
          }, (response) => {
            this.log('Snapshot response status:', response.statusCode);

            if (response.statusCode === 401 && this.frigateToken) {
              this.log('Snapshot got 401, clearing token and retrying');
              this.frigateToken = null;
              attempt().then(resolve).catch(reject);
              return;
            }

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
        } catch (err) {
          reject(err);
        }
      };

      attempt();
    });
  }
}

module.exports = FrigateCameraDevice;
