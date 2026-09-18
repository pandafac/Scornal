# Scornal · 成绩留声机

一个**只保存在本机**的个人成绩追踪 PWA。记录每次考试成绩，自动生成趋势图与学科分析，支持自定义头像与相框，可安装到手机桌面并离线使用。

- 无账号、无登录、无后端服务器
- 所有数据存在浏览器本地（localStorage / IndexedDB），不上传、不追踪
- 纯原生 HTML / CSS / JavaScript（ES Modules），零运行时依赖
- 图表为手绘 SVG，字体走系统回退，不请求任何三方资源

## 线上地址

部署到 Netlify 后，在此处填写你的站点地址：

```
https://<your-site-name>.netlify.app
```

## 技术栈

| 项目 | 说明 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript，浏览器直接加载 ES Modules |
| 构建 | **无需构建**，仓库根目录即可直接作为静态站点发布 |
| 离线 | Service Worker（`sw.js`）预缓存 61 个 app shell 资源 |
| 存储 | localStorage（成绩数据）+ IndexedDB（自定义头像图片） |
| 图表 | 手写 SVG，无图表库 |

## 目录结构

```
.
├── index.html                # 单页入口，包含全部视图结构
├── manifest.webmanifest      # PWA 清单
├── sw.js                     # Service Worker，离线缓存
├── netlify.toml              # Netlify 发布配置 + 缓存/安全响应头
├── robots.txt
├── icons/                    # PWA 图标 192 / 512
├── src/
│   ├── main.js               # 应用主逻辑（视图、成绩、图表、备份）
│   ├── avatar-system.js      # 头像系统入口
│   ├── avatar-cropper.js     # 本地相册裁剪
│   ├── avatar-storage.js     # IndexedDB 头像存储
│   ├── avatar-frames.js      # 动态相框渲染
│   ├── avatar-image.js       # 头像图片处理
│   ├── compliance-config.js  # 隐私与合规文案配置
│   ├── styles.css            # 主样式（莫兰迪水彩风）
│   ├── identity-extra.css    # 头像/身份相关补充样式
│   └── assets/               # 头像、相框、页面插画、头像目录 JSON
└── docs/                     # 产品记录与交接说明（不参与线上运行）
```

## 本地预览

本项目不需要打包，任意静态服务器即可。

```bash
# Python
python -m http.server 5173

# Node
npx serve -l 5173 .
```

然后访问 `http://127.0.0.1:5173`。

> 注意：Service Worker 在 `localhost` / `127.0.0.1` 下会主动注销并清理缓存，方便调试；只有在 HTTPS 线上环境才会真正注册离线缓存。

## 部署

见 [`部署指南.md`](./部署指南.md)，包含 GitHub 上传与 Netlify 接入的完整步骤。

## 隐私说明

本应用不收集任何数据。成绩、头像、设置全部存放在你自己的浏览器里，清除浏览器数据即等于删除全部内容。建议定期使用应用内的「备份 / 导出」功能保存 JSON 文件到本地。
