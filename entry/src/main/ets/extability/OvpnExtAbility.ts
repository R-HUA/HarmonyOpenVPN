/*
* Copyright (c) 2024 Huawei Device Co., Ltd.
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { commonEventManager, BusinessError } from '@kit.BasicServicesKit';
import { Want, bundleManager } from '@kit.AbilityKit';
import { vpnExtension as vpnExt, VpnExtensionAbility } from '@kit.NetworkKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import vpn_client from 'libvpn_client.so';

import { LogRedactor, errorText } from '../model/Diagnostics';
import { NetworkMonitor } from '../model/NetworkMonitor';
import { HandoverRetry } from '../model/HandoverRetry';
interface NativeCounters { coreCounters?: Record<string, number> }
interface ConnectionOptions { profileName: string; username: string; password: string; privateKeyPassword: string; response: string }
interface NativeEvent { name: string; info: string }
export default class OvpnExtAbility extends VpnExtensionAbility {
  private redactor: LogRedactor = new LogRedactor([]);
  private logWork: Promise<void> = Promise.resolve();
  private logPath: string = '';
  private pendingWant?: Want;
  private subscriber?: commonEventManager.CommonEventSubscriber;
  private profileName: string = '';
  private state: string = 'idle';
  private info: string = '';
  private connectedAt: number = 0;
  private connection?: vpnExt.VpnConnection;
  private bundleName: string = '';
  private started: boolean = false;
  private destroying: boolean = false;
  private tunFd: number = -1;
  private tunConfig: string = '';
  private tunWork: Promise<number> = Promise.resolve(-1);
  private shutdown?: Promise<void>;
  private lastStatsLog: number = 0;
  private networkMonitor?: NetworkMonitor;
  private handoverRetry: HandoverRetry = new HandoverRetry(() => {
    if (!this.destroying) vpn_client.networkChanged(true);
  }, (message: string) => this.log(message));

  async onCreate(want: Want) {
    this.logPath = this.context.filesDir + '/ovpn.log';
    this.log('Extension created');
    this.connection = vpnExt.createVpnConnection(this.context);
    const bundle = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    this.bundleName = bundle.name;
    commonEventManager.createSubscriber({ events: ['ovpn.STATUS_REQUEST'], publisherBundleName: this.bundleName },
      (error: BusinessError, subscriber: commonEventManager.CommonEventSubscriber) => {
        if (error) return;
        if (this.destroying) return;
        this.subscriber = subscriber;
        commonEventManager.subscribe(subscriber, () => {
          this.publish('ovpn.STATE', JSON.stringify({ profileName: this.profileName, state: this.state,
            info: this.info, connectedAt: this.connectedAt }));
        });
      });
    await this.begin(this.pendingWant ?? want);
    this.pendingWant = undefined;
  }
  onRequest(want: Want, startId: number) {
    if (this.bundleName.length > 0) this.begin(want);
    else this.pendingWant = want;
  }
  private publish(event: string, data: string = '') {
    commonEventManager.publish(event, { bundleName: this.bundleName, data }, () => {});
  }
  private async begin(want: Want) {
    if (this.started || this.destroying) return;
    const options = want.parameters?.cfg as string;
    // Never recover credentials from disk. API 26 authorization observer re-sends the in-memory request.
    if (!options) return;
    this.started = true;
    const parsed = JSON.parse(options) as ConnectionOptions;
    this.profileName = parsed.profileName;
    this.redactor = new LogRedactor([parsed.username ?? '', parsed.password ?? '', parsed.privateKeyPassword ?? '', parsed.response ?? '']);
    try {
      await this.connection!.protectProcessNet();
      this.log('VPN process protected (including resolver)');
    } catch (e) {
      this.fail('VPN 进程网络保护失败：' + errorText(e as Error));
      return;
    }
    if (this.destroying) return;
    this.log('Starting OpenVPN core');
    this.state = 'connecting';
    const error = vpn_client.startVpn(options,
      async (fd: number): Promise<void> => {
        if (this.destroying || !this.connection) throw new Error('VPN is stopping');
        try { await this.connection.protect(fd); this.log('Socket protected'); }
        catch (e) { this.log('Socket protect failed: ' + errorText(e as Error)); throw e; }
      },
      (json: string): Promise<number> => {
        this.tunWork = this.tunWork.then(() => this.createTun(json));
        return this.tunWork;
      },
      (json: string) => {
        if (this.destroying) return;
        const event = JSON.parse(json) as NativeEvent;
        this.log(event.name + ': ' + event.info);
        if (event.name === 'LOG') return;
        if (event.name === 'CONNECTED') {
          this.handoverRetry.finish();
          this.state = 'connected'; this.info = event.info; this.connectedAt = Date.now();
          this.publish('ovpn.CONNECTED', json);
        } else if (event.name === 'RECONNECTING' || event.name === 'CONNECTING') {
          this.state = 'connecting'; this.publish('ovpn.RECONNECTING');
        }
      }, '',
      (json: string) => {
        if (this.destroying) return;
        const counters = JSON.parse(json) as NativeCounters;
        this.handoverRetry.observe(counters.coreCounters?.['RESOLVE_ERROR'] ?? 0);
        this.publish('ovpn.STATS', json);
        if (Date.now() - this.lastStatsLog >= 10000) {
          this.lastStatsLog = Date.now();
          this.log('DATA_COUNTERS: ' + json);
        }
      },
      (reason: string) => {
        if (!this.destroying) {
          this.fail(reason);
        }
      });
    if (error) this.fail(error);
    else {
      this.networkMonitor = new NetworkMonitor((online: boolean) => {
        if (this.destroying) return;
        if (online) this.handoverRetry.arm();
        else this.handoverRetry.finish();
        this.state = 'connecting';
        this.publish('ovpn.RECONNECTING');
        this.log(online ? 'Network restored/changed: reconnecting core' : 'Network unavailable: pausing core');
        vpn_client.networkChanged(online);
      }, (message: string) => this.log(message));
      this.networkMonitor.start().catch((e: Error) => this.log('Network observer failed: ' + errorText(e)));
    }
  }
  private fail(reason: string) {
    const safe = this.redactor.clean(reason).trim() || 'VPN 已中断，请查看连接日志';
    this.log('FAILED: ' + safe);
    this.publish('ovpn.ERROR', safe);
    this.destroy().then(() => {
      vpnExt.stopVpnExtensionAbility({ bundleName: this.bundleName, abilityName: 'OvpnExtAbility' }).catch(() => {});
    }).catch(() => {});
  }
  private async createTun(json: string): Promise<number> {
    if (this.destroying || !this.connection) return -1;
    if (this.tunFd >= 0 && this.tunConfig === json) {
      this.log('Reusing unchanged system VPN, fd=' + this.tunFd);
      return this.tunFd;
    }
    let stage = 'prepare';
    try {
      if (this.tunFd >= 0) {
        stage = 'destroy previous VPN';
        this.log('Replacing system VPN after configuration change');
        await this.connection.destroy();
        await this.closeFd();
        await this.connection.protectProcessNet();
      }
      if (this.destroying) return -1;
      stage = 'create';
      this.log('System VPN config: ' + json);
      const fd = await this.connection.create(JSON.parse(json) as vpnExt.VpnConfig);
      if (fd < 0) throw new Error('Platform returned invalid TUN descriptor');
      this.log('System VPN created, fd=' + fd);
      this.tunFd = fd;
      this.tunConfig = json;
      if (this.destroying) { await this.connection.destroy(); await this.closeFd(); return -1; }
      return fd;
    } catch (e) {
      this.log('System VPN ' + stage + ' failed: ' + errorText(e as Error));
      this.fail('系统 VPN 操作失败（' + stage + '）：' + errorText(e as Error));
      return -1;
    }
  }
  private log(message: string) {
    const line = new Date().toISOString() + ' ' + this.redactor.clean(message) + '\n';
    this.logWork = this.logWork.then(async () => {
      try {
        try { if ((await fs.stat(this.logPath)).size > 256 * 1024) await fs.truncate(this.logPath); } catch (e) {}
        const file = await fs.open(this.logPath, fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY);
        try { await fs.write(file.fd, line); } finally { await fs.close(file); }
      } catch (e) { console.error('Unable to persist VPN diagnostic log'); }
    });
  }
  private async closeFd() {
    const fd = this.tunFd;
    this.tunFd = -1;
    this.tunConfig = '';
    if (fd >= 0) { try { await fs.close(fd); } catch (e) {} }
  }
  private destroy(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.log('Stopping VPN');
    this.destroying = true;
    this.handoverRetry.finish();
    this.networkMonitor?.stop();
    this.state = 'idle';
    if (this.subscriber) { try { commonEventManager.unsubscribe(this.subscriber); } catch (e) {} }
    this.shutdown = this.cleanup();
    return this.shutdown;
  }
  private async cleanup() {
    try {
      await vpn_client.stopVpn();
      await this.tunWork;
    } finally {
      try { await this.connection?.destroy(); } catch (e) {}
      await this.closeFd();
      await this.networkMonitor?.release();
      this.log('VPN stopped');
      await this.logWork;
      this.publish('ovpn.DESTROY');
    }
  }
  onDestroy() { this.destroy(); }
  onConnect(want: Want) { return null; }
  onDisconnect(want: Want) {}
}
