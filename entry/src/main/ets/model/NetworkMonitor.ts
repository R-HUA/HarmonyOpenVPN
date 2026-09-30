import { connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { errorText } from './Diagnostics';

// Observe the physical default network, never the VPN's own virtual network.
export class NetworkMonitor {
  private observer?: connection.NetConnection;
  private stopped: boolean = false;
  private timer: number = -1;
  private revision: number = 0;
  private netId: number = -1;
  private originalNet?: connection.NetHandle;
  private binding: Promise<void> = Promise.resolve();
  private generation: number = 0;
  private bindFailures: number = 0;
  constructor(private changed: (online: boolean) => void, private log: (message: string) => void) {}

  async start(): Promise<void> {
    this.originalNet = await connection.getAppNet();
    if (this.stopped) return;
    const observer = connection.createNetConnection({ netCapabilities: { bearerTypes: [], networkCap: [
      connection.NetCap.NET_CAPABILITY_INTERNET, connection.NetCap.NET_CAPABILITY_NOT_VPN
    ] } });
    this.observer = observer;
    observer.on('netAvailable', () => this.schedule());
    observer.on('netLost', () => this.schedule());
    observer.on('netCapabilitiesChange', () => this.schedule());
    observer.on('netConnectionPropertiesChange', () => this.schedule());
    await new Promise<void>((resolve, reject) => {
      observer.register((error: BusinessError) => error ? reject(error) : resolve());
    });
    if (this.stopped) { observer.unregister(() => {}); return; }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const revision = ++this.revision;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = -1; this.refresh(revision); }, 400);
  }

  private async refresh(revision: number): Promise<void> {
    try {
      const net = await connection.getDefaultNet();
      if (this.stopped || revision !== this.revision || net.netId === this.netId) return;
      const previous = this.netId;
      this.netId = net.netId;
      const generation = ++this.generation;
      this.log('PHYSICAL_NETWORK: ' + previous + ' -> ' + this.netId);
      // Serialize process bindings; a late completion must not undo a newer network.
      this.binding = this.binding.then(async () => {
        if (this.stopped || generation !== this.generation) return;
        const started = Date.now();
        // netId=0 releases the old network binding while offline.
        await connection.setAppNet(net);
        this.bindFailures = 0;
        this.log('PHYSICAL_DNS_BOUND: net=' + net.netId + ' elapsedMs=' + (Date.now() - started));
        if (this.stopped || generation !== this.generation) return;
        if (previous >= 0 || net.netId === 0) this.changed(net.netId !== 0);
      }).catch((e: Error) => {
        this.log('Physical network binding failed: ' + errorText(e));
        // Permit the next notification to retry binding; never resume on a stale binding.
        if (!this.stopped && generation === this.generation) {
          this.netId = 0;
          this.changed(false);
          if (++this.bindFailures <= 2) this.schedule();
        }
      });
      // First positive snapshot is the startup baseline, not a network switch.
    } catch (e) {
      if (!this.stopped) this.log('Network query failed: ' + errorText(e as Error));
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    ++this.revision;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.observer?.unregister(() => {});
  }

  async release(): Promise<void> {
    await this.binding;
    if (this.originalNet) {
      try { await connection.setAppNet(this.originalNet); }
      catch (e) { this.log('Restore process network failed: ' + errorText(e as Error)); }
    }
  }
}
