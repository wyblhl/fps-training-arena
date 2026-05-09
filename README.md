# 仓库突击训练 FPS

一个可部署的 Three.js 第一人称射击小游戏。项目是纯前端 Vite 应用，构建后生成静态文件，可以部署到 Vercel、Netlify、Cloudflare Pages、GitHub Pages 或任意静态服务器。

## 本地运行

```bash
npm install
npm run serve
```

打开：

```text
http://127.0.0.1:5174
```

## 构建发布

```bash
npm run build
```

产物目录：

```text
dist
```

## 部署参数

Vercel / Netlify / Cloudflare Pages 通用配置：

```text
Build command: npm run build
Output directory: dist
Node version: 20+
```

项目已包含：

- `vercel.json`
- `netlify.toml`
- `vite.config.js`

## 操作

- 桌面端：WASD 移动，鼠标控制视角，左键射击，R 换弹
- 移动端：左下摇杆移动，右下按钮开火，触屏辅助瞄准
- 采用波次挑战：红色普通兵、紫色高速兵、金色重装 Boss
- 命中标记、敌人血条、连击奖励和波次完成奖励会实时反馈
- 页面内可选择低画质、均衡、高画质
- 低帧率持续出现时会自动降级画质
- 页面右下角可以一键开启或关闭音效

## 发布前检查

```bash
npm run build
npm run preview
```

在桌面和手机浏览器分别检查：

- 首屏能进入游戏
- 枪械、敌人、掩体、拾取物正常显示
- 射击、受伤、拾取、重新开始可用
- 低画质模式在低端设备上更流畅
