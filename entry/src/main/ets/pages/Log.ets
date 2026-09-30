import fs from '@ohos.file.fs';
import { BusinessError } from '@ohos.base';
import { showToast, getSafeAreaInsets } from '../components/Common';

@Entry
@Component
struct LogTailComponent {
  @State logContent: string = 'loading...';
  @State topAvoid: number = 0;
  @State bottomAvoid: number = 0;
  private logPath: string = '';
  private isActive: boolean = true;
  private timer: number = -1;
  private scroller: Scroller = new Scroller();

  async aboutToAppear() {
    const insets = await getSafeAreaInsets(this.getUIContext())
    this.topAvoid = insets.top
    this.bottomAvoid = insets.bottom
    this.logPath = this.getUIContext().getHostContext()?.filesDir + '/ovpn.log'
    this.startLogTail();
  }

  aboutToDisappear() {
    this.stopLogTail();
  }

  async startLogTail() {
    this.isActive = true
    await this.readLog()
    if (this.isActive) this.timer = setTimeout(() => { this.startLogTail() }, 1000)
  }

  stopLogTail() {
    this.isActive = false
    if (this.timer >= 0) clearTimeout(this.timer)
    this.timer = -1
  }

  private async checkFileExists(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.logPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async readLog() {
    try {

      this.logContent = await fs.readText(this.logPath, { encoding: 'utf-8' })

      this.scroller.scrollEdge(Edge.Bottom);
    } catch (err) {
      this.logContent = '尚无连接日志。发起一次连接后，这里会自动更新。';
    }
  }

  async clearLog() {
    try {
      await fs.truncate(this.logPath)
      this.logContent = '日志已清空'
      showToast(this.getUIContext(), 'clear log success', 1000);
    } catch (e) {
      showToast(this.getUIContext(), `clearLogErr: ${JSON.stringify(e)}`, 4000);
    }
  }

  onPageShow() {
    setTimeout(() => {
      this.scroller.scrollEdge(Edge.Bottom);
    }, 1e3)
  }

  build() {
    Column() {
      Row()
        .width('100%')
        .height(this.topAvoid)
        .backgroundColor($r('app.color.top_bar_bg'))

      Row() {
        Image($r('app.media.ic_chevron_left')).width(40).height(40).objectFit(ImageFit.Contain)
          .padding({ right: 8 })
          .onClick(() => {
            this.getUIContext().getRouter().back()
          })

        Text($r('app.string.log'))
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)

        Image($r('app.media.ic_trash_2')).width(40).height(40).objectFit(ImageFit.Contain)
          .padding(8)
          .onClick(() => this.clearLog())
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 12 })
      .backgroundColor($r('app.color.top_bar_bg'))

      Scroll(this.scroller) {
        Text(this.logContent).copyOption(CopyOptions.LocalDevice)
          .fontSize(13)
          .fontFamily('monospace')
          .textAlign(TextAlign.Start)
          .width('100%')
          .padding(12)
          .fontColor('#E0E0E0')
      }
      .scrollBar(BarState.Auto)
      .layoutWeight(1)
      .width('100%')
      .backgroundColor($r('app.color.log_bg'))
      .padding(8)

      Row()
        .width('100%')
        .height(this.bottomAvoid)
        .backgroundColor($r('app.color.page_bg'))
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
