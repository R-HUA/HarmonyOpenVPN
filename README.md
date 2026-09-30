# HarmonyOpenVPN

HarmonyOS 原生 OpenVPN 客户端，基于 [jseparator/ovpn-ohos](https://github.com/jseparator/ovpn-ohos) 和 OpenVPN 3 Core。当前版本 **1.1.7**，面向 **HarmonyOS API 26 / arm64-v8a**。本项目为社区移植，不是 OpenVPN 官方客户端。

## 功能

- 导入 `.ovpn` 配置及配套证书、私钥文件，支持 TCP、UDP、IPv4、IPv6、默认路由、分流路由和普通 DNS。
- 用户名、密码、私钥口令及静态 challenge 输入；通过系统 Asset Store 保存凭据，可取消保存并清除。
- 显示连接状态和错误详情，提供自动刷新的日志页；日志滚动保存并过滤凭据、令牌和密钥内容。
- 支持 Wi-Fi 与蜂窝网络切换后自动重连，新连接使用当前物理网络解析服务器域名，并对切换期间的 DNS 失败进行有限快速重试。
- 支持 AES-CBC 数据通道；可选择兼容旧服务器压缩，仅接收解压，默认禁用。
- 保留原应用图标，界面操作图标使用 Lucide。

导入外置文件时需同时选择配置及引用的文件。外置引用仅接受文件名，单文件及合并后的配置最大为 1 MB。

## 构建

安装 Git、DevEco CLI 和包含 API 26 SDK 的 command-line-tools。Windows PowerShell 示例：

```powershell
git clone https://github.com/R-HUA/HarmonyOpenVPN.git
cd HarmonyOpenVPN
$env:DEVECO_CLI_CLT_PATH = 'C:\Program Files\command-line-tools'
./scripts/build.ps1 -Clean
```

将 `DEVECO_CLI_CLT_PATH` 改为自己的工具链安装目录。脚本按 `dependencies.lock.json` 下载固定提交的原生依赖，执行桌面回归测试并调用 CLT 编译。首次构建需要访问 GitHub 和相应包仓库。

未签名产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`。真机安装需自行配置开发者签名；仓库不包含签名证书、私钥、账号或设备配置。

## 测试

`scripts/build.ps1` 执行配置解析、生命周期、凭据与日志、原生配置契约、网络切换及重试策略测试。系统接口使用模拟实现，桌面测试不能代替设备上的 VPN 流量验证。

`tests/cbc_selftest.cpp` 使用公开固定测试向量检查 AES-128/192/256-CBC 加解密。应用启动时也执行该自检，其结果通过 `OvpnCryptoTest` 日志标签输出。

## 功能边界

暂不支持 URL 配置下载、动态 challenge、SAML/WebAuth、External PKI、系统证书选择器、代理/PAC、Split DNS、DoH/DoT、自定义 DNS 端口、按应用分流、系统 Always-on 和 Kill Switch。

后台连接受系统任务限制。网络切换恢复时间取决于网络、DNS 和服务器状态。压缩兼容选项仅用于需要旧协议的服务器，推荐在服务器端停用压缩。导入的内嵌证书和私钥保存在应用私有目录，尚未实现硬件密钥托管。

## 来源与许可证

上游和依赖的仓库、固定提交及版本见 [dependencies.lock.json](dependencies.lock.json)。构建保留依赖的许可证和版权声明：

- [OpenVPN 3](https://github.com/jseparator/openvpn3)：MPL-2.0 / AGPL-3.0 双许可。
- [Mbed TLS](https://github.com/Mbed-TLS/mbedtls)：Apache-2.0 / GPL-2.0-or-later 双许可。
- Asio、jsoncpp、fmt、LZ4：以各固定依赖中的许可证为准。
- Lucide：见 [图标许可证](docs/licenses/Lucide-LICENSE.txt)。

原应用源码沿用其已有文件声明；本项目未对上游未明确许可的文件重新指定许可证。
