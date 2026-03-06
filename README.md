# china-web-scraper

**针对中国大陆网站的 Playwright 爬虫工具包。**

解决中国网站爬取中最常遇到的问题：SPA 渲染、搜索框交互、API 响应拦截、反自动化绕过。

内置字节跳动、腾讯、B 站、飞书招聘门户、Boss 直聘等站点预设配置，开箱即用。

```javascript
const { ChinaScraper } = require('china-web-scraper');

const scraper = new ChinaScraper();
const items = await scraper.scrape('bytedance');     // 用预设
const items = await scraper.scrape('https://...');   // 自动提取
await scraper.close();
```

---

## 安装

```bash
npm install playwright
npx playwright install chromium

git clone https://github.com/cocohahaha/china-job-scraping-guide.git
cd china-job-scraping-guide
```

---

## 快速开始

### 1. 自动提取

不需要任何配置。ChinaScraper 会自动找到页面上的详情链接和列表卡片。

```javascript
const { ChinaScraper } = require('./');

const scraper = new ChinaScraper();
const items = await scraper.scrape('https://hr.163.com/job-list.html?workType=1&lang=zh');
// → [{ title: '...', url: '...', text: '...' }, ...]

await scraper.close();
```

### 2. 搜索框 + 筛选器

中国网站的 URL 参数经常失效。搜索框交互更可靠：

```javascript
// 用预设（字节跳动：搜索"产品经理" + 点击"上海"）
const jobs = await scraper.scrape('bytedance');

// 覆盖搜索词
const jobs = await scraper.scrape('bytedance', {
  search: { text: '前端工程师' },
  click: ['北京'],
});

// 纯手动配置
const jobs = await scraper.scrape({
  url: 'https://jobs.bytedance.com/experienced/position',
  wait: 5000,
  search: { text: '数据分析' },
  click: ['上海'],
});
```

### 3. API 响应拦截

SPA 底层一定会调 API。拦截 API 响应能拿到结构化 JSON，比 DOM 提取稳定得多：

```javascript
// 用预设
const jobs = await scraper.scrape('tencent');

// 自定义 API 拦截
const items = await scraper.scrape('https://some-spa-site.com', {
  api: {
    match: 'api/list',                          // URL 子串匹配
    transform: (json) => json.data.items,       // 从 JSON 中提取数组
  },
});

// 同源 fetch（主动调用站点 API）
const items = await scraper.scrape('https://some-spa-site.com', {
  api: {
    fetch: '/api/list?page=1&size=20',         // 相对路径，避免 CORS
    transform: (json) => json.data,
  },
});
```

### 4. 声明式提取

用选择器描述数据结构，不写 JavaScript：

```javascript
const items = await scraper.scrape('https://some-site.com/list', {
  selector: '.item-card',
  fields: {
    title: 'h3',              // textContent
    link: 'a @href',          // attribute
    price: '.price',
    image: 'img @src',
  },
});
```

### 5. actions 流水线

需要精确控制操作顺序时（比如先点 tab，再搜索）：

```javascript
const items = await scraper.scrape({
  url: 'https://xxx.jobs.feishu.cn/',
  wait: 5000,
  actions: [
    { click: '社会招聘' },              // 先点击 tab
    { wait: 3000 },
    { search: { text: '产品' } },       // 再搜索
  ],
  extract: async (page) => {
    // 自定义提取
    return page.evaluate(() => { /* ... */ });
  },
});
```

### 6. CDP 模式（反自动化站点）

Boss 直聘等站点会检测自动化工具。CDP 模式连接用户真实 Chrome，完全不可检测：

```javascript
const scraper = new ChinaScraper();
await scraper.connectCDP();  // 会重启 Chrome 并通过 CDP 连接

// 如果需要登录
const page = await scraper.newPage();
await page.goto('https://www.zhipin.com/');
console.log('请在浏览器中登录...');
await scraper.waitForLogin(page);

// 登录后正常抓取
const jobs = await scraper.scrape('boss');
await scraper.close();
```

---

## API

### `new ChinaScraper(options?)`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `headless` | boolean | `false` | 无头模式 |
| `locale` | string | `'zh-CN'` | 浏览器语言 |
| `viewport` | object | `{width:1280, height:900}` | 视口大小 |
| `screenshotDir` | string | `null` | 截图保存目录 |
| `slowMo` | number | `0` | 操作间隔（毫秒） |

### `scraper.scrape(target, options?)`

`target` 可以是：
- **字符串 URL**: `'https://...'` → 自动提取
- **预设名称**: `'bytedance'`, `'tencent'`, `'bilibili'` 等
- **配置对象**: `{ url, search, click, api, extract, ... }`

`options` 会合并覆盖 target 的配置。

**配置字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `url` | string | 目标 URL |
| `wait` | number | SPA 渲染等待时间（毫秒），默认 5000 |
| `timeout` | number | 页面加载超时（毫秒），默认 30000 |
| `waitUntil` | string | 导航等待策略，默认 `'domcontentloaded'` |
| `search` | string \| object | 搜索框交互。字符串=搜索词，对象=`{text, input?, submit?, waitAfter?}` |
| `click` | string \| string[] | 点击元素。文字匹配或 CSS 选择器（`.`/`#`/`[` 开头） |
| `clickWait` | number | 每次点击后等待（毫秒），默认 3000 |
| `actions` | array | 有序操作列表，替代 search/click |
| `api` | object | API 拦截配置 `{match?, fetch?, transform?}` |
| `extract` | function | 自定义提取函数 `(page) => data` |
| `selector` | string | 声明式提取：数据项容器选择器 |
| `fields` | object | 声明式提取：字段映射 `{name: 'selector'}` |
| `waitForSelector` | string | 提取前等待指定元素出现 |
| `paginate` | object | 翻页配置 `{maxPages?, next?, waitAfter?}` |
| `screenshotDir` | string | 当前任务的截图目录 |

### `scraper.connectCDP(options?)`

通过 CDP 连接真实 Chrome（macOS）。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | number | `9222` | CDP 端口 |
| `relaunch` | boolean | `true` | 是否重启 Chrome |

### `scraper.waitForLogin(page, options?)`

等待用户手动登录。检测页面文本/元素变化判断登录成功。

### `scraper.newPage()`

获取原始 Playwright Page 对象，用于完全自定义的流程。

### `scraper.close()`

关闭浏览器。

---

## 预设列表

| 预设名 | 站点 | 策略 | 备注 |
|--------|------|------|------|
| `bytedance` | 字节跳动 | 搜索框 + 筛选 | 搜"产品经理"+点"上海" |
| `tencent` | 腾讯 | API 拦截 | 返回结构化 JSON |
| `bilibili` | B 站 | 搜索框 + 长等待 | 需要 15s 渲染 |
| `minimax` | MiniMax | 飞书门户 | 列表页提取 JD 摘要 |
| `zhipu` | 智谱 AI | 飞书门户 | |
| `baichuan` | 百川智能 | 飞书门户 | |
| `lingyiwanwu` | 零一万物 | 飞书门户 | |
| `boss` | Boss 直聘 | 需 CDP | 需 `connectCDP()` + 手动登录 |
| `alibaba` | 阿里巴巴 | 自动提取 | |
| `stepfun` | 阶跃星辰 | 自动提取 | |
| `moonshot` | 月之暗面 | 自动提取 | |
| `mihoyo` | 米哈游 | 自动提取 | |
| `netease` | 网易 | 自动提取 | |

覆盖预设的任何字段：

```javascript
scraper.scrape('bytedance', { search: '工程师', click: ['深圳'] })
```

---

## 中国网站常见问题

| 问题 | 症状 | 解决方案 |
|------|------|---------|
| **SPA 渲染** | fetch/curl 只拿到空 HTML | Playwright + `waitForTimeout` |
| **networkidle 超时** | 页面永远加不完 | 用 `domcontentloaded` + 固定等待 |
| **URL 参数失效** | 直接访问带参数 URL 返回 0 结果 | 搜索框交互 `search: '关键词'` |
| **DOM 不稳定** | class 名随机、结构频繁变化 | API 拦截 `api: { match: '...' }` |
| **反自动化** | 页面空白或跳转 | CDP 连接真实 Chrome |
| **登录墙** | 需要手机验证码/扫码 | `waitForLogin()` 半自动化 |
| **CORS** | 跨域 fetch 失败 | 每个站点独立 page + 相对路径 fetch |
| **详情页不渲染** | 详情页需登录 | 从列表页卡片提取数据 |

### 各站点推荐等待时间

| 站点 | 初始加载 | 搜索后 | 翻页后 |
|------|---------|--------|--------|
| 字节跳动 | 5s | 5s | 3s |
| 腾讯 | 5s | 3s | 3s |
| B 站 | **15s** | 8s | 5s |
| 飞书门户 | 5s | 4s | 3s |
| 一般官网 | 3-5s | 2-3s | 2s |

---

## 示例

```bash
node examples/basic.js                # 自动提取
node examples/search-and-filter.js     # 搜索框 + 筛选
node examples/api-intercept.js         # API 拦截
node examples/declarative-extract.js   # 声明式提取
node examples/custom-extract.js        # 自定义提取 + actions
node examples/multi-site.js            # 批量多站点
node examples/boss-cdp.js              # Boss 直聘 CDP 模式
bash examples/boss-applescript.sh      # Boss 直聘 AppleScript (macOS)
node examples/browse-interactive.js --site list  # 交互式浏览
```

---

## 技术细节

想了解每个方案背后的原理和踩坑经历？见 [docs/how-it-works.md](docs/how-it-works.md)。

---

## License

MIT
