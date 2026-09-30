import { util } from '@kit.ArkTS';
import { ProfileAsset, inlineProfile, safeProfileName } from '../model/Profile';
import vpn_client from 'libvpn_client.so';
import { picker, fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { showToast, getSafeAreaInsets } from '../components/Common';

interface Evaluation { error: boolean; message: string }

@Entry
@Component
struct ImportProfile {
  @State importing: boolean = false;
  @State topAvoid: number = 0;
  @State bottomAvoid: number = 0;

  getDir(): string {
    return this.getUIContext().getHostContext()?.filesDir + '/ovpn'
  }

  async aboutToAppear() {
    const insets = await getSafeAreaInsets(this.getUIContext())
    this.topAvoid = insets.top
    this.bottomAvoid = insets.bottom
  }

  async browseAndImport() {
    if (this.importing) {
      return
    }
    this.importing = true
    try {
      const dp = new picker.DocumentViewPicker();
      const uris = await dp.select({ fileSuffixFilters: ['VPN files|.ovpn,.crt,.pem,.key,.txt'], maxSelectNumber: 30 })
      if (!uris || !uris.length) {
        this.importing = false
        return
      }
      const dir = this.getDir()
      try {
        await fs.mkdir(dir)
      } catch (e) {
      }
      const assets: ProfileAsset[] = []
      for (const uri of uris) {
        const fUri = new fileUri.FileUri(uri)
        const name = safeProfileName(fUri.name)
        if (assets.some((asset: ProfileAsset) => asset.name === name)) throw new Error('选择了同名文件：' + name)
        const file = await fs.open(uri, fs.OpenMode.READ_ONLY)
        try {
          const stat = await fs.stat(file.fd)
          if (stat.size > 1024 * 1024) throw new Error('单个文件不能超过 1 MB')
          const bytes = new Uint8Array(stat.size)
          let offset = 0
          while (offset < stat.size) {
            const chunk = new ArrayBuffer(stat.size - offset)
            const count = await fs.read(file.fd, chunk, { offset })
            if (count <= 0) throw new Error('文件读取不完整')
            bytes.set(new Uint8Array(chunk, 0, count), offset)
            offset += count
          }
          const decoder = util.TextDecoder.create('utf-8', { fatal: true })
          assets.push({ name, text: decoder.decodeToString(bytes) })
        } finally { await fs.close(file) }
      }
      const profiles: ProfileAsset[] = []
      for (const asset of assets) {
        if (!asset.name.toLowerCase().endsWith('.ovpn')) continue
        const cfg = inlineProfile(asset.text, assets)
        const evaluation = JSON.parse(vpn_client.evaluateProfile(cfg)) as Evaluation
        if (evaluation.error) throw new Error(evaluation.message)
        profiles.push({ name: asset.name, text: cfg })
      }
      if (!profiles.length) throw new Error('请至少选择一个 .ovpn 配置文件')
      for (const profile of profiles) {
        const fullPath = dir + '/' + profile.name
        if (await fs.access(fullPath)) throw new Error('已有同名配置，请先重命名或删除：' + profile.name)
      }
      for (const profile of profiles) {
        const file = await fs.open(dir + '/' + profile.name, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY)
        try { await fs.write(file.fd, profile.text) } finally { await fs.close(file) }
      }
      showToast(this.getUIContext(), 'Profile imported', 1500);
      setTimeout(() => {
        // Pass dirty flag so Index.onPageShow knows to reload profiles.
        this.getUIContext().getRouter().back({ url: 'pages/Index', params: { profilesDirty: true } })
      }, 400)
    } catch (e) {
      showToast(this.getUIContext(), (e as Error).message || JSON.stringify(e), 4000);
    } finally {
      this.importing = false
    }
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

        Text($r('app.string.import_profile'))
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
      }
      .width('100%')
      .height(56)
      .padding({ left: 12, right: 16 })
      .backgroundColor($r('app.color.top_bar_bg'))

      Row() {
        Column() {
          Text($r('app.string.import_file_tab'))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.ovpn_orange'))
          Divider()
            .strokeWidth(2)
            .color($r('app.color.ovpn_orange'))
            .margin({ top: 10 })
        }
        .padding({ left: 20, right: 20, top: 14 })
      }
      .width('100%')
      .backgroundColor($r('app.color.card_bg'))

      Column({ space: 20 }) {
        Text('选择 .ovpn 配置；如引用外置证书或私钥，请同时选择对应文件。文件将保存在应用私有目录。')
          .fontSize(15)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })

        Button(this.importing ? '...' : $r('app.string.browse'))
          .backgroundColor($r('app.color.ovpn_orange'))
          .fontColor(Color.White)
          .fontSize(16)
          .width('70%')
          .enabled(!this.importing)
          .onClick(() => this.browseAndImport())
      }
      .width('100%')
      .layoutWeight(1)
      .justifyContent(FlexAlign.Center)
      .backgroundColor($r('app.color.page_bg'))

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
