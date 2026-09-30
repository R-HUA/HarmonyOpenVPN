import { asset } from '@kit.AssetStoreKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
export interface SavedCredentials { username: string; password: string; privateKeyPassword: string; receiveCompression?: boolean }
async function alias(profile: string): Promise<Uint8Array> {
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: new util.TextEncoder().encodeInto('ovpn.credentials.v1:' + profile) });
  return (await md.digest()).data;
}
export async function loadCredentials(profile: string): Promise<SavedCredentials | undefined> {
  const query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, await alias(profile));
  query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  try {
    const rows = await asset.query(query);
    if (!rows.length) return undefined;
    const bytes = rows[0].get(asset.Tag.SECRET) as Uint8Array;
    return JSON.parse(util.TextDecoder.create('utf-8').decodeToString(bytes)) as SavedCredentials;
  } catch (e) { if ((e as BusinessError).code === 24000002) return undefined; throw e; }
}
export async function saveCredentials(profile: string, value: SavedCredentials): Promise<void> {
  const attributes: asset.AssetMap = new Map();
  attributes.set(asset.Tag.ALIAS, await alias(profile));
  attributes.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(JSON.stringify(value)));
  attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
  attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
  attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
  await asset.add(attributes);
}
export async function forgetCredentials(profile: string): Promise<void> {
  const query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, await alias(profile));
  try { await asset.remove(query); } catch (e) { if ((e as BusinessError).code !== 24000002) throw e; }
}
