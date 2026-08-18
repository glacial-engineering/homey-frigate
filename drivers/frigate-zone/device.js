'use strict';

const Homey = require('homey');

class FrigateZoneDevice extends Homey.Device {
  async onInit() {
    this.log('FrigateZoneDevice initialized:', this.getName());

    await this.ensureCapabilities();

    const data = this.getData();
    this.homey.app.registerZoneDevice(data.zoneName || data.id, this);
  }

  async onDeleted() {
    const data = this.getData();
    this.homey.app.unregisterZoneDevice(data.zoneName || data.id, this);
  }

  async ensureCapabilities() {
    const caps = ['alarm_detection', 'alarm_alert'];
    for (const cap of caps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
      await this.setCapabilityValue(cap, false);
    }
  }

  async setZoneState(state) {
    await this.setCapabilityValue('alarm_detection', state.detection);
    await this.setCapabilityValue('alarm_alert', state.alert);
  }
}

module.exports = FrigateZoneDevice;
