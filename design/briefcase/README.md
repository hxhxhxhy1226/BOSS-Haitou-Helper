# 雾蓝陶瓷公文包图标

选用方案 07，并针对插件场景完成精修：略微正面的视角、较宽的银色提手开口、干净的雾蓝箱体和单个锁扣。16/32px 采用加粗提手与较大锁扣的模型，不直接缩放大图。

`render.html` 是独立的 WebGL 源文件，没有外部资源或脚本依赖。普通浏览器打开即可渲染两个尺寸模型；它不进入扩展运行包。

导出流程：用 Edge 无界面模式的 `--dump-dom` 保存完成渲染后的页面，再执行：

```sh
python design/briefcase/export.py artifacts/briefcase-final/render-output.html
```

导出脚本使用 Pillow，将透明图像写入 `extension/icons/icon16.png`、`icon32.png`、`icon48.png` 和 `icon128.png`，并生成本目录的 `icon512.png` 与本地预览图。预览排版使用 Windows 微软雅黑字体。

正式 PNG 不含灰色背景、地面阴影、细小铆钉或接缝。常规构建只复制已经导出的 PNG，不要求使用者安装绘图依赖。
