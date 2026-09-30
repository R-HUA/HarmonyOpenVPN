import { vpnExtension as vpnExt } from '@kit.NetworkKit';
import { commonEventManager } from '@kit.BasicServicesKit';
/*
 * Keep the UI process alive while VPN is connected.
 * System stops VpnExtensionAbility when the caller process exits.
 */

import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { wantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import hilog from '@ohos.hilog';
import { BUNDLE_NAME } from './Common';

const TAG = '[VpnKeepAlive]'
let generation = 0
let running = false
const onCancelled = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
  if (!running) return
  running = false
  try { backgroundTaskManager.off('continuousTaskCancel', onCancelled) } catch (e) {}
  commonEventManager.publish('ovpn.WARNING', {
    bundleName: BUNDLE_NAME, data: '后台任务已取消，请保持应用在前台；系统可能在后台终止 VPN'
  }, () => {})
}

export async function startVpnKeepAlive(context: Context): Promise<boolean> {
  if (running) {
    return true
  }
  const attempt = generation
  try {
    const wantAgentInfo: wantAgent.WantAgentInfo = {
      wants: [{
        bundleName: BUNDLE_NAME,
        abilityName: 'EntryAbility'
      }],
      operationType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    }
    const agent = await wantAgent.getWantAgent(wantAgentInfo)
    await backgroundTaskManager.startBackgroundRunning(
      context,
      backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
      agent
    )
    if (attempt !== generation) {
      await backgroundTaskManager.stopBackgroundRunning(context)
      return false
    }
    running = true
    backgroundTaskManager.on('continuousTaskCancel', onCancelled)
    return true
    hilog.info(0x0000, TAG, 'startBackgroundRunning ok')
    return true
  } catch (e) {
    const err = e as BusinessError
    hilog.error(0x0000, TAG, `startBackgroundRunning fail: ${err.code} ${err.message}`)
    return false
  }
}

export async function stopVpnKeepAlive(context: Context): Promise<void> {
  generation++
  if (!running) {
    return
  }
  try {
    await backgroundTaskManager.stopBackgroundRunning(context)
    hilog.info(0x0000, TAG, 'stopBackgroundRunning ok')
  } catch (e) {
    const err = e as BusinessError
    hilog.error(0x0000, TAG, `stopBackgroundRunning fail: ${err.code} ${err.message}`)
  } finally {
    running = false
    try { backgroundTaskManager.off('continuousTaskCancel', onCancelled) } catch (e) {}
  }
}
