<div align="center">

# scrape-cn

**专为中国大陆网站设计的数据抓取工具包**

*Web scraping toolkit built for Chinese mainland websites*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-optional-yellow.svg)](https://playwright.dev)

中国网站 ≠ 海外网站。99% 的 SPA、不可靠的 URL 参数、严格的反爬、登录墙……
<br/>这个工具包用 **9 轮实战迭代**踩出来的方案，帮你绕过这些坑。

[快速开始](#快速开始) · [3 种策略](#3-种策略) · [预设站点](#预设站点) · [API 文档](#api) · [技术原理](docs/how-it-works.md)

</div>

---

## 为什么需要 scrape-cn？

| 你遇到的问题 | 原因 | scrape-cn 的解决方案 |
|:---|:---|:---|
| `fetch` 拿到空 HTML | 中国网站几乎全是 SPA | Playwright 渲染 + 智能等待 |
| URL 参数今天能用明天失效 | category ID 随版本变化 | **搜索框交互**（模拟用户输入） |
| DOM 结构天天变 | class 名随机化、组件频繁重构 | **API 响应拦截**（直接拿 JSON） |
| 被检测为自动化工具 | Playwright 指纹被识别 | **CDP 连接真实 Chrome** |
| 详情页需要登录 | 飞书门户登录墙 | 从列表页卡片提取数据 |
| 每个站点都要写一套逻辑 | 没有统一标准 | **13 个预设** + 通用提取器 |

## 特性

- **3 层策略** — HTTP fetch → Playwright 渲染 → CDP 真实浏览器，按需选择
- **Playwright 可选** — 静态页面和公开 API 零依赖即可抓取
- **搜索框交互** — 模拟用户输入关键词 + 点击筛选器，比 URL 参数更可靠
- **API 响应拦截** — `page.on('response')` 捕获后端 API，拿到结构化 JSON
- **13 个预设** — 字节跳动、腾讯、B站、飞书门户（MiniMax/智谱/百川/零一万物）、Boss直聘等
- **声明式提取** — 用 CSS 选择器描述数据结构，不写 JS
- **actions 流水线** — 有序执行多步交互操作
- **自动翻页** — 配置 `paginate` 自动点"下一页"
- **内联数据提取** — 自动识别 `__INITIAL_STATE__`、`__NEXT_DATA__` 等 SSR 注入数据

---

## 安装

```bash
# 核心（零依赖，支持 HTTP fetch）
git clone https://github.com/cocohahaha/scrape-cn.git
cd scrape-cn

# 如果需要 Playwright（SPA 渲染、搜索框、API 拦截）
npm install playwright
npx playwright install chromium
```

> Node.js >= 18 必需（使用内置 `fetch`）

---

## 快速开始

```javascript
const { ScrapeCN } = require('scrape-cn');

// 30 秒上手 —— 一行抓取字节跳动上海产品经理岗位
const scraper = new ScrapeCN();
const jobs = await scraper.scrape('bytedance');
console.log(jobs);
await scraper.close();
```

---

## 3 种策略

### 策略 1: HTTP fetch（零依赖）

不需要 Playwright，用 Node.js 内置 `fetch` 请求页面。
适合**服务端渲染页面**、**公开 API**、**SSR 内联数据**。

```javascript
const { ScrapeCN } = require('scrape-cn');

// 抓取 HTML 并自动解析链接、JSON-LD、内联数据
const { links, jsonLD, inlineData } = await ScrapeCN.fetch('https://example.com/jobs');

// 直接调 API（不需要浏览器）
const data = await ScrapeCN.api('https://api.example.com/list?page=1', {
  transform: json => json.data.items,
});
```

### 策略 2: Playwright 渲染（SPA 页面）

搜索框交互、API 响应拦截、声明式提取——处理复杂 SPA。

```javascript
const scraper = new ScrapeCN();

// 搜索框 + 筛选器
const items = await scraper.scrape('https://jobs.bytedance.com/experienced/position', {
  search: '产品经理',
  click: ['上海'],
});

// API 响应拦截
const items = await scraper.scrape('https://careers.tencent.com/search.html', {
  api: {
    match: 'api/post/Query',
    transform: json => json.Data.Posts,
  },
});

// 声明式提取
const items = await scraper.scrape('https://example.com/list', {
  selector: '.job-card',
  fields: { title: 'h3', link: 'a @href', salary: '.price' },
});

// actions 流水线（控制操作顺序）
const items = await scraper.scrape({
  url: 'https://xxx.jobs.feishu.cn/',
  actions: [
    { click: '社会招聘' },
    { wait: 3000 },
    { search: '产品' },
  ],
});

await scraper.close();
```

### 策略 3: CDP 真实浏览器（反自动化）

连接用户本机 Chrome，反爬检测完全无效。

```javascript
const scraper = new ScrapeCN();
await scraper.connectCDP();  // 重启 Chrome + CDP 连接 (macOS)

const page = await scraper.newPage();
await page.goto('https://www.zhipin.com/');
await scraper.waitForLogin(page);  // 等待用户扫码登录

const jobs = await scraper.scrape('boss');
await scraper.close();  // 断开连接，Chrome 保持运行
```

---

## 预设站点

直接传预设名给 `scrape()`，也可以覆盖任何字段：

```javascript
scraper.scrape('bytedance')                             // 使用预设
scraper.scrape('bytedance', { search: '工程师' })        // 覆盖搜索词
scraper.scrape('tencent', { api: { ... } })              // 覆盖 API 配置
```

| 预设 | 站点 | 策略 | 说明 |
|:-----|:-----|:-----|:-----|
| `bytedance` | 字节跳动 | 搜索框 + 筛选 | 搜"产品经理"+点"上海" |
| `tencent` | 腾讯 | API 拦截 | 返回结构化 JSON |
| `bilibili` | B 站 | 搜索框 + 15s 等待 | SPA 渲染极慢 |
| `minimax` | MiniMax | 飞书门户 | 列表页卡片含 JD 摘要 |
| `zhipu` | 智谱 AI | 飞书门户 | |
| `baichuan` | 百川智能 | 飞书门户 | |
| `lingyiwanwu` | 零一万物 | 飞书门户 | |
| `boss` | Boss 直聘 | 需 CDP | `connectCDP()` + 手动登录 |
| `alibaba` | 阿里巴巴 | 自动提取 | |
| `stepfun` | 阶跃星辰 | 自动提取 | |
| `moonshot` | 月之暗面 | 自动提取 | |
| `mihoyo` | 米哈游 | 自动提取 | |
| `netease` | 网易 | 自动提取 | |

添加自定义预设：

```javascript
const { presets } = require('scrape-cn');

presets.myCompany = {
  name: '我的公司',
  url: 'https://careers.mycompany.com',
  wait: 5000,
  search: { text: '产品' },
  extract: async (page) => { /* ... */ },
};
```

---

## API

### `ScrapeCN.fetch(url, options?)` · 静态方法，零依赖

| 参数 | 说明 |
|:-----|:-----|
| `headers` | 自定义请求头 |
| `cookie` | Cookie 字符串 |
| `linkPattern` | 自定义链接匹配正则 |
| `inlineVar` | SSR 内联变量名（如 `'__INITIAL_STATE__'`） |
| **返回** | `{ html, links, jsonLD, inlineData }` |

### `ScrapeCN.api(url, options?)` · 静态方法，零依赖

| 参数 | 说明 |
|:-----|:-----|
| `transform` | `(json) => data` 转换函数 |
| `headers` | 自定义请求头 |
| **返回** | 转换后的数据 |

### `new ScrapeCN(options?)` · 需要 Playwright

| 参数 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `headless` | `false` | 无头模式 |
| `locale` | `'zh-CN'` | 浏览器语言 |
| `viewport` | `{width:1280, height:900}` | 视口 |
| `screenshotDir` | `null` | 截图目录 |
| `slowMo` | `0` | 操作间隔 |

### `scraper.scrape(target, options?)`

| 字段 | 说明 |
|:-----|:-----|
| `url` | 目标 URL |
| `wait` | SPA 等待时间（默认 5000ms） |
| `search` | 搜索框：`'关键词'` 或 `{text, input?, submit?, waitAfter?}` |
| `click` | 点击元素：`'文字'` 或 `['.选择器', '文字']` |
| `actions` | 有序操作：`[{search:...}, {click:...}, {wait:...}, {scroll:true}]` |
| `api.match` | API 拦截：URL 子串匹配 |
| `api.fetch` | 同源 fetch：相对路径 API |
| `api.transform` | `(json) => items` 转换函数 |
| `extract` | 自定义提取：`(page) => data` |
| `selector` + `fields` | 声明式提取 |
| `paginate` | 翻页：`{maxPages?, next?, waitAfter?}` |

### `scraper.connectCDP(options?)` · 需要 Playwright

连接真实 Chrome。`{ port: 9222, relaunch: true }`

### `scraper.waitForLogin(page, options?)`

等待手动登录。`{ timeout: 180000, indicators: ['个人中心'] }`

---

## 中国网站等待时间速查

| 站点 | 首次加载 | 搜索后 | 翻页后 |
|:-----|:---------|:-------|:-------|
| 字节跳动 | 5s | 5s | 3s |
| 腾讯 | 5s | 3s | 3s |
| B 站 | **15s** | 8s | 5s |
| 飞书门户 | 5s | 4s | 3s |
| 一般网站 | 3s | 2s | 2s |

---

## 示例

```bash
node examples/basic.js                # 3 种策略对比
node examples/search-and-filter.js     # 搜索框 + 筛选器
node examples/api-intercept.js         # API 拦截
node examples/declarative-extract.js   # 声明式提取
node examples/custom-extract.js        # 自定义 + actions
node examples/multi-site.js            # 批量多站点
node examples/boss-cdp.js              # Boss 直聘 CDP
bash examples/boss-applescript.sh      # Boss 直聘 AppleScript (macOS)
```

---

## 技术原理

9 轮迭代踩过的所有坑和攻克方案：**[docs/how-it-works.md](docs/how-it-works.md)**

涵盖：SPA 渲染、反自动化检测、登录墙、飞书门户、LLM 幻觉数据、DOM 结构差异、频率限制、URL 参数失效、API 拦截、同源问题等。

---

## 贡献

欢迎 PR！特别欢迎：
- 新的站点预设配置
- 新的抓取策略
- Bug 修复和改进

---

## License

MIT
