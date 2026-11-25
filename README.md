# LearnHarness · Windows 与 Android

在 Android 手机和平板上使用 LearnHarness。移动端可以独立运行，也可以通过公司 VPN 连接 Windows 电脑，继续同一份学习会话和进度。

[LearnHarness 原始 GitHub 仓库](https://github.com/amosblomqvist/learnharness)

## 下载

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 Windows 安装包](https://github.com/wuyin1985/learnharness/releases/download/pc-android-0.7.0-file-pairing.1/LearnHarness-Shared-PC-0.7.0-x64-setup.exe) |
| Android 9 及以上 | [下载 Android 通用 APK](https://github.com/wuyin1985/learnharness/releases/download/pc-android-0.7.0-file-pairing.1/LearnHarness-0.7.0-universal.apk) |

各版本的安装包和更新说明见 [GitHub Releases](https://github.com/wuyin1985/learnharness/releases)。

## 在 Android 上独立学习

安装 APK 后打开 LearnHarness，在「Set up models」中配置模型提供商，即可开始学习。学习记录保存在 Android 设备上。使用远程模型时，设备需要能访问模型服务。详见 [Android 使用指南](https://github.com/wuyin1985/learnharness/blob/android/standalone/docs/android.md)。

## 在 Android 上继续 Windows 的学习进度

首次使用需要在 Windows 上配置共享服务，并确认 Android 设备能通过公司 VPN 访问该电脑。学习记录保存在 Windows 电脑上，共享期间请保持电脑和 LearnHarness 运行。详见 [Windows 共享配置指南](https://github.com/wuyin1985/learnharness/blob/android/standalone/docs/shared-pc.md)。

1. 在 Windows 打开 LearnHarness，按 `Alt` 显示菜单，选择「LearnHarness → Save Phone Connection File…」，导出 `.lhconnect` 文件。
2. 将文件传到 Android 设备，并连接公司 VPN。
3. 在 Android LearnHarness 的会话侧栏选择「PC connection」，导入文件。App 自动登录并打开 Windows 上的会话。

连接文件含一次性登录授权，自导出起 5 分钟内有效。文件过期或已使用时，请在 Windows 上重新导出。在 Android 端选择「PC connection → Use this device」可回到设备上的学习记录。

[Windows 与 Android 源代码](https://github.com/wuyin1985/learnharness/tree/android/standalone) · [AGPL-3.0 许可证](LICENSE)
