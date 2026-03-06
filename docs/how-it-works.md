# China Job Site Scraping Guide

**中国招聘网站自动化抓取实战指南** -- 技术难点与攻克方案全记录

> 在构建一个 AI 驱动的自动求职系统（基于 Claude Code + Playwright）的过程中，我们踩了无数坑。这个仓库记录了抓取中国主流招聘平台时遇到的所有技术难点，以及经过 9 轮迭代后最终攻克的方案。希望能帮到同样在做招聘数据自动化的开发者。

---

## 目录

- [背景与动机](#背景与动机)
- [技术栈](#技术栈)
- [平台难度分级](#平台难度分级)
- [难点 1：SPA 渲染 -- 你 fetch 到的是空壳](#难点-1spa-渲染----你-fetch-到的是空壳)
- [难点 2：反自动化检测 -- Boss 直聘的层层封锁](#难点-2反自动化检测----boss-直聘的层层封锁)
- [难点 3：登录墙 -- 无 Cookie 寸步难行](#难点-3登录墙----无-cookie-寸步难行)
- [难点 4：飞书招聘门户 -- AI 公司的统一入口](#难点-4飞书招聘门户----ai-公司的统一入口)
- [难点 5：LLM Agent 幻觉 -- 最隐蔽的陷阱](#难点-5llm-agent-幻觉----最隐蔽的陷阱)
- [难点 6：各站点 DOM 结构各异](#难点-6各站点-dom-结构各异)
- [难点 7：频率限制与验证码](#难点-7频率限制与验证码)
- [难点 8：抓到的是平台总链接而非具体岗位](#难点-8抓到的是平台总链接而非具体岗位)
- [难点 9：搜索框交互 vs URL 参数 -- 同一站点两种命运](#难点-9搜索框交互-vs-url-参数----同一站点两种命运)
- [难点 10：API 响应拦截 -- SPA 的终极武器](#难点-10api-响应拦截----spa-的终极武器)
- [难点 11：飞书门户详情页不渲染 -- 列表页才有 JD](#难点-11飞书门户详情页不渲染----列表页才有-jd)
- [最终架构](#最终架构)
- [各平台攻克方案速查](#各平台攻克方案速查)
- [脚本使用说明](#脚本使用说明)
- [经验教训总结](#经验教训总结)
- [License](#license)

---

## 背景与动机

我在做一个基于 Claude Code 的自动化求职系统，目标是：

1. 自动搜索上海 AI/互联网行业的产品经理岗位
2. 抓取 JD 全文进行匹配分析
3. 自动定制简历
4. 半自动化投递

听起来很美好，但光是 **"把岗位信息抓下来"** 这一步就花了 6 轮迭代才搞定。

---

## 技术栈

| 组件 | 技术 | 用途 |
|------|------|------|
| 浏览器自动化 | Playwright (Node.js) | SPA 渲染、表单填写、截图 |
| 简单抓取 | WebFetch / fetch | 静态页面、API 端点 |
| 反检测 | CDP 协议 + 真实 Chrome | 绕过 Bot 检测 |
| macOS 辅助 | AppleScript + pbpaste | 终极降级方案 |
| AI 分析 | Claude Code (Opus) | JD 解析、简历定制 |

```bash
# 依赖安装
npm install playwright nodemailer
npx playwright install chromium
```

---

## 平台难度分级

| 难度 | 平台 | 主要障碍 | 推荐方案 | 实测结果 |
|------|------|---------|---------|---------|
| Easy | 公司官网（Dify、小公司） | 无 | WebFetch / fetch 直接抓 | 成功 |
| Medium | 飞书招聘门户（MiniMax、智谱等） | SPA + 详情页登录墙 | Playwright 列表页提取 | 列表页可抓，详情页需登录 |
| Medium | 字节跳动 | SPA + URL 参数失效 | Playwright **搜索框交互** | URL 参数 0 结果，搜索框 10+ |
| Medium | 腾讯 | SPA + 无岗位链接 | **API 响应拦截** (同源) | API 返回 20 条结构化数据 |
| Medium-Hard | B 站 | SPA + 超慢渲染 + 无 `<a>` 标签 | `domcontentloaded` + 15s 等待 | 列表页可抓，详情页超时 |
| Hard | Boss 直聘 | SPA + 登录 + 反自动化 | CDP 模式 / AppleScript | 需真实 Chrome |
| Hard | 猎聘、拉勾、智联 | 强制登录 + 反爬 | 建议手动 | — |

---

## 难点 1：SPA 渲染 -- 你 fetch 到的是空壳

### 问题

中国主流招聘网站（字节跳动、腾讯、B 站、飞书招聘门户等）全部是 **SPA（Single Page Application）**。用 `fetch` 或 `curl` 请求只能拿到一个空的 HTML 骨架 + 一堆 JS bundle，**岗位列表在 JS 执行后才会渲染到 DOM 中**。

```bash
# 你以为能拿到岗位列表
curl https://jobs.bytedance.com/experienced/position
# 实际拿到的是：
# <div id="app"></div>
# <script src="/static/js/chunk-xxx.js"></script>
```

**受影响平台：** 几乎所有大公司官网 + 飞书招聘门户

### 解决方案：Playwright 渲染

用 Playwright 启动真实浏览器，等待 JS 执行完毕后再提取 DOM。

```javascript
const { chromium } = require('playwright');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('https://jobs.bytedance.com/experienced/position', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

// 关键：等待 SPA 渲染完成（不能只等 DOMContentLoaded）
await page.waitForTimeout(5000);

// 现在才能提取到真实内容
const jobs = await page.evaluate(() => {
  // ... 提取逻辑
});
```

### 关键细节

1. **`waitUntil: 'networkidle'` 不可靠** -- 很多 SPA 会持续发轮询请求，导致永远不会 idle。用 `domcontentloaded` + 固定等待更稳定。
2. **等待时间因站点而异** -- 飞书门户需要 5s+，字节跳动需要 4s+，普通官网 2-3s。
3. **有些站点需要交互才显示内容** -- 比如要先点击"社会招聘" tab，再搜索关键词。

---

## 难点 2：反自动化检测 -- Boss 直聘的层层封锁

### 问题

Boss 直聘（zhipin.com）是中国最大的招聘平台之一，也是反自动化做得最狠的：

1. **检测 Playwright 的 Chromium** -- navigator.webdriver 为 true 时直接返回空白页
2. **检测浏览器指纹** -- Playwright 默认 Chromium 的指纹与真实 Chrome 不同
3. **验证码机制** -- 频繁操作触发滑块/图形验证码
4. **登录拦截** -- 未登录状态下搜索结果受限或直接跳转登录页

### 攻克历程（4 个方案逐步升级）

#### 方案 A：Playwright Chromium + 反检测参数 -- 失败

```javascript
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});
```

结果：页面能打开但显示"请使用真实浏览器访问"，或者搜索结果返回空。

#### 方案 B：Playwright channel: 'chrome' -- 部分成功

```javascript
// 使用用户本机安装的 Chrome，而非 Playwright 自带 Chromium
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});
```

进步：Boss 直聘不再检测为自动化工具。但问题是：
- 需要一个独立的 user data directory
- 不能复用用户已有的 Chrome profile（登录状态丢失）
- 仍然需要重新登录

#### 方案 C：CDP 协议连接真实 Chrome -- 最终方案

```javascript
// 1. 关闭现有 Chrome
execSync('osascript -e \'tell application "Google Chrome" to quit\'');

// 2. 以远程调试模式重启 Chrome（保留用户真实 profile）
spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--remote-debugging-port=9222',
  '--user-data-dir=' + userDataDir,  // 用户真实的 Chrome profile
  '--restore-last-session',
]);

// 3. 通过 CDP 连接
const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
const page = await contexts[0].newPage();

// 4. Boss 直聘完全看不出是自动化 -- 因为就是用户的真实 Chrome
await page.goto('https://www.zhipin.com/web/geek/job?query=AI产品经理&city=101020100');
```

**核心思路：** 不是"让 Playwright 假装是 Chrome"，而是"让 Playwright 控制真正的 Chrome"。

**优势：**
- Boss 直聘完全无法检测（因为就是真 Chrome）
- 复用用户已有的登录状态和 Cookie
- 浏览器指纹与用户日常使用完全一致

**注意事项：**
- 必须先完全关闭 Chrome 再以调试模式重启
- 用 `curl http://localhost:9222/json/version` 确认调试端口已就绪
- 脚本结束时只断开 CDP 连接，不关闭 Chrome

#### 方案 D：AppleScript + 剪贴板 -- 终极降级方案

当 CDP 方案也遇到问题时（比如 Chrome 拒绝被远程调试），还有一个纯 macOS 的终极方案：

```bash
# 用 AppleScript 导航 Chrome
osascript -e 'tell application "Google Chrome"
  activate
  set URL of active tab of window 1 to "https://www.zhipin.com/web/geek/job?query=AI产品经理&city=101020100"
end tell'

sleep 8

# 用 AppleScript 模拟 Cmd+A / Cmd+C 复制页面内容
osascript -e '
tell application "System Events"
  tell process "Google Chrome"
    keystroke "a" using command down
    delay 0.3
    keystroke "c" using command down
  end tell
end tell'

# 从剪贴板提取内容
pbpaste > boss-search-results.txt
```

**更进阶：在 Chrome 中注入 JS 提取结构化数据**

```bash
# 通过 AppleScript 执行 JavaScript
osascript << 'EOF'
tell application "Google Chrome"
  tell active tab of window 1
    return execute javascript "
      var jobs = [];
      document.querySelectorAll('.job-card-wrapper').forEach(function(card) {
        var title = card.querySelector('.job-name')?.textContent?.trim();
        var company = card.querySelector('.company-name')?.textContent?.trim();
        var salary = card.querySelector('.salary')?.textContent?.trim();
        if (title) jobs.push(title + ' ||| ' + company + ' ||| ' + salary);
      });
      'TOTAL:' + jobs.length + '\\n' + jobs.join('\\n');
    "
  end tell
end tell
EOF
```

这个方案虽然"土"，但：
- **零检测风险** -- 完全不涉及 WebDriver 协议
- **零依赖** -- 只需要 macOS 自带的 osascript
- **复用登录态** -- 用户在 Chrome 中登录的状态直接可用

---

## 难点 3：登录墙 -- 无 Cookie 寸步难行

### 问题

Boss 直聘、猎聘、拉勾等平台**必须登录后才能搜索/查看完整 JD**。登录方式通常是：
- 手机验证码
- 微信/支付宝扫码
- 图形验证码 + 密码

这些都无法完全自动化。

### 解决方案：半自动化登录 + 状态持久化

```javascript
// 1. 打开登录页面
await page.goto('https://www.zhipin.com/web/user/?ka=header-login');

// 2. 等待用户手动登录（检测登录成功的标志）
try {
  await page.waitForFunction(() => {
    const url = window.location.href;
    const text = document.body?.innerText || '';
    return url.includes('/web/geek') ||      // URL 跳转
           url.includes('/recommend') ||
           text.includes('个人中心') ||       // 页面内容变化
           !!document.querySelector('[class*="avatar"]');  // 头像出现
  }, { timeout: 180000 });  // 最多等 3 分钟
  console.log('登录成功！');
} catch (e) {
  console.log('登录超时，继续尝试...');
}

// 3. 保存登录状态（下次可跳过登录）
await context.storageState({ path: '/tmp/boss-state.json' });
```

**关键设计决策：**

- **不存储密码** -- 只保存 cookie / localStorage
- **多种登录检测方式并行** -- URL 变化 + DOM 变化 + 页面文本变化，应对不同平台的登录完成行为
- **超时不中断** -- 登录超时后继续尝试，因为有些平台即使没有完全登录也能看到部分结果

---

## 难点 4：飞书招聘门户 -- AI 公司的统一入口

### 问题

2024-2026 年，大量中国 AI 公司（MiniMax、智谱、百川、零一万物、月之暗面等）使用 **飞书招聘门户** 作为官方招聘入口。每个公司有一个类似 `https://xxx.jobs.feishu.cn/` 的子域名。

这些门户的特点：
- 纯 SPA，需要 JS 渲染
- 岗位列表通过 API 异步加载
- 需要先选择"社会招聘"或搜索关键词
- 内推链接可能失效（如月之暗面的 `moonshot.jobs.feishu.cn/s/iNxEE34T` 已失效）

### 解决方案：飞书门户专用提取器

```javascript
async function extractJobsFeishu(page) {
  // 1. 等待 API 数据加载
  await page.waitForTimeout(5000);

  // 2. 尝试切换到"社会招聘" tab
  const tabs = ['社会招聘', '社招', '全部职位', '所有职位'];
  for (const tab of tabs) {
    try {
      const el = await page.locator(`text=${tab}`).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForTimeout(3000);
        break;
      }
    } catch(e) {}
  }

  // 3. 搜索"产品"
  try {
    const searchInput = await page.locator(
      'input[placeholder*="搜索"], input[placeholder*="search"], input[type="search"]'
    ).first();
    if (await searchInput.isVisible({ timeout: 2000 })) {
      await searchInput.fill('产品');
      await searchInput.press('Enter');
      await page.waitForTimeout(3000);
    }
  } catch(e) {}

  // 4. 提取岗位
  return await extractJobsGeneric(page);
}
```

**已验证的飞书门户 URL：**

| 公司 | 飞书门户 URL |
|------|-------------|
| MiniMax | `https://vrfi1sk8a0.jobs.feishu.cn/` |
| 智谱 AI | `https://zhipu-ai.jobs.feishu.cn/` |
| 百川智能 | `https://cq6qe6bvfr6.jobs.feishu.cn/` |
| 零一万物 | `https://01ai.jobs.feishu.cn/` |
| 月之暗面 | `https://moonshot.jobs.feishu.cn/` (内推链接可能失效) |

---

## 难点 5：LLM Agent 幻觉 -- 最隐蔽的陷阱

### 问题

这是我们踩的**最大的坑**，比所有技术问题加起来都严重。

我们使用 Claude Code 的 subagent 系统，让不同的 Agent 负责不同的任务。但有一个致命的设计缺陷：

> **Subagent 没有网络访问能力（没有 WebSearch/WebFetch），却被指派去"搜索岗位"。**
> **结果：Agent 编造了看起来完全合理的假数据。**

**Round 1-6 的所有岗位数据（6 轮！）都是 Agent 凭空编造的：**

```markdown
# Agent 编造的假数据示例
### 字节跳动 - Coze Agent 产品经理
- URL: https://www.zhipin.com/job/coze-agent-pm-sh.html  # 假的！Boss直聘URL是随机字母数字ID
- 薪资: 35-55K·16薪  # 假的！
- JD: 负责Coze平台Agent模块的产品规划...  # 假的！

# 真实的 Boss 直聘 URL 格式：
# https://www.zhipin.com/job_detail/88e63d1628a6bf1c03R-3tq6FldR.html
```

**如何发现假数据的：**
- Boss 直聘的真实 URL 格式是 `/job_detail/{随机字母数字ID}.html`，而 Agent 编造的 URL 使用可读的英文 slug
- 点击 Agent 给的 URL 全部 404
- 薪资数字完美符合预期（太巧了）

### 解决方案：严格的能力边界 + 防造假规则

```markdown
# 在 Agent prompt 中加入绝对禁令

## 绝对禁令
1. 你没有网络（没有 WebSearch/WebFetch）-- 岗位搜索由主 Agent 完成
2. 禁止编造任何岗位信息 -- URL、薪资、JD、公司信息全部禁止编造
3. 禁止委派子 Agent 去"搜索"岗位 -- 它们也没有网络
4. 所有岗位数据必须来自 docs/ 目录中已有的文件
```

**架构调整：**

```
之前（错误）：
  Subagent（无网络）→ 被要求搜索 → 编造数据

之后（正确）：
  主 Agent（有网络）→ 真实搜索 → 保存到文件
  Subagent（无网络）→ 只读取已保存的文件 → 分析/生成报告
```

**验证机制：**
- 每条岗位数据必须包含：实际 URL、抓取时间、获取方式
- URL 格式校验（如 Boss 直聘必须是 `/job_detail/{随机ID}.html`）
- 无法获取时必须标注"未找到"或"需手动确认"

---

## 难点 6：各站点 DOM 结构各异

### 问题

每个招聘网站的 HTML 结构完全不同，没有统一标准。同一个平台的不同版本、不同页面，DOM 结构也可能不一样。

### 解决方案：多策略 fallback 提取器

```javascript
async function extractJobsGeneric(page) {
  return await page.evaluate(() => {
    const jobs = [];
    const seen = new Set();

    // 策略 1：关键词匹配链接
    const keywords = ['产品', 'PM', 'Product', 'AI', 'Agent', 'AIGC'];
    document.querySelectorAll('a').forEach(a => {
      const text = (a.textContent || '').trim();
      const href = a.href;
      if (keywords.some(k => text.includes(k)) && !seen.has(href)) {
        seen.add(href);
        jobs.push({ title: text, url: href, source: 'link' });
      }
    });

    // 策略 2：卡片/列表元素（覆盖多种 class 命名风格）
    const cardSelectors = [
      '[class*="job"]', '[class*="position"]', '[class*="career"]',
      '[class*="list-item"]', '[class*="card"]', '[class*="post"]',
    ];
    cardSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        // ... 提取逻辑
      });
    });

    return jobs;
  });
}
```

**Boss 直聘专用提取（需要覆盖多个版本的 DOM）：**

```javascript
// Boss 直聘的 DOM 结构会频繁变化，所以用多种选择器 fallback
const selectors = [
  '.job-card-wrapper',           // 2024 版
  '.search-job-result .job-card-body',  // 2025 版
  '[class*="job-card"]',         // 通用 fallback
  '.job-list li',                // 旧版
  '.job-list-box .job-card-left', // 另一种布局
];

let cards = [];
for (const sel of selectors) {
  const found = document.querySelectorAll(sel);
  if (found.length > cards.length) cards = Array.from(found);
}
```

---

## 难点 7：频率限制与验证码

### 问题

连续搜索多个关键词时容易触发：
- 滑块验证码
- 图形验证码
- IP 封禁（临时）
- 返回空结果

### 解决方案

```javascript
// 1. 请求间隔
await page.waitForTimeout(2000 + Math.random() * 1000);  // 2-3 秒随机间隔

// 2. slowMo 模式让操作更像人类
const browser = await chromium.launch({
  headless: false,
  slowMo: 200,  // 每个操作间隔 200ms
});

// 3. 搜索前先滚动页面
osascript -e '
tell application "System Events"
  tell process "Google Chrome"
    key code 119  -- End key，滚动到底
    delay 1
    key code 119
    delay 1
  end tell
end tell'

// 4. 遇到验证码时暂停，等用户处理
console.log('WAIT_FOR_USER: 请在浏览器中完成验证码...');
await new Promise(resolve => process.stdin.once('data', resolve));
```

---

## 难点 8：抓到的是平台总链接而非具体岗位

### 问题

v1 版本的通用提取器犯了一个很常见的错误：**把导航链接、分类标签、JD 正文碎片都当成了岗位**。

实际抓取结果惨不忍睹：

```json
// 字节跳动：只抓到导航分类链接，实际岗位 0 条
{ "title": "产品与技术", "url": "https://jobs.bytedance.com/experienced/page-AgCQiO" }

// 腾讯：抓到的是分类标签
{ "title": "技术运营类", "url": "https://careers.tencent.com/search.html?pcid=40001" }
{ "title": "产品 产品类游戏产品类项目类金融类", "url": "" }

// MiniMax：有 URL 的 5 条，无 URL 的碎片 30+ 条
{ "title": "1、参与Agent产品各环节规划，制定产品战略与路线图...", "url": "" }
```

**根因分析：**
1. **通用提取器太贪心** -- 只要文本含关键词就算岗位，导航栏的"产品"也被抓了
2. **SPA 岗位卡片没有 `<a>` 标签** -- 很多 SPA 用 click handler 而非链接跳转
3. **嵌套 DOM 导致重复** -- 同一岗位的 `<li>`、`<div>`、`<span>` 各匹配一次
4. **不区分 URL 类型** -- `/page-xxx`（分类页）和 `/position/123456`（详情页）被同等对待

### 解决方案：平台专用提取器 + URL 模式过滤 + 点击获取详情

**核心改进 1：URL 模式过滤**

```javascript
// 只保留像岗位详情页的 URL，过滤掉导航/分类/筛选页
function isJobDetailUrl(url) {
  const detailPatterns = [
    /\/position\/\d+/,        // 飞书: /position/7579523111286147366/detail
    /\/job_detail\//,          // Boss直聘: /job_detail/88e63d16.html
    /\/job\/\d+/,              // 通用
    /[?&]id=\d+/,              // query 参数带 ID
  ];
  return detailPatterns.some(p => p.test(url));
}
```

**核心改进 2：各平台专用提取器**

```javascript
// 字节跳动专用 -- 只找 /position/{数字ID} 的链接，过滤 /page-xxx 分类页
document.querySelectorAll('a[href*="/position/"]').forEach(a => {
  if (href.includes('/page-') || href.includes('/position?')) return; // 过滤导航
  if (!/\/position\/\d+/.test(href)) return;                          // 必须有数字ID
  // ... 提取
});

// 飞书门户专用 -- 只找 /position/{ID}/detail 的链接
document.querySelectorAll('a[href*="/position/"]').forEach(a => {
  if (!href.includes('/detail') && !href.match(/\/position\/\d+/)) return;
  // ... 提取标题、城市、类别
});

// 腾讯专用 -- SPA 没有链接，需要从卡片结构和点击行为获取
// 先从 DOM 提取标题，再逐个点击卡片获取跳转后的 URL
```

**核心改进 3：点击卡片获取详情 URL**

```javascript
// 腾讯等 SPA 站点：岗位卡片只有 click handler，没有 <a> 标签
// 解决：自动逐个点击卡片，读取跳转后的 URL
const cards = await page.$$('[class*="job-item"]');
for (let i = 0; i < cards.length; i++) {
  await cards[i].click();
  await page.waitForTimeout(1500);
  const detailUrl = page.url();  // 点击后 SPA 路由变化，读取新 URL
  allJobs[i].url = detailUrl;
  await page.goBack();
}
```

**核心改进 4：自动翻页**

```javascript
// 每个提取器都支持翻页，默认 3 页
for (let p = 0; p < maxPages; p++) {
  const jobs = await extractCurrentPage(page);
  allJobs.push(...jobs);
  // 尝试点击下一页
  const nextBtn = page.locator('[class*="next"]:not([class*="disabled"])');
  if (await nextBtn.isVisible()) {
    await nextBtn.click();
    await page.waitForTimeout(3000);
  } else break;
}
```

### 修复前后对比

| 平台 | v1 结果 | v2 结果 |
|------|---------|---------|
| 字节跳动 | 1 条导航链接 + 1 条筛选器文本 | 每条都有 `/position/{ID}` 详情链接 |
| 腾讯 | 1 条分类链接 + 一堆无 URL 碎片 | 结构化提取标题/城市/部门 + 点击获取 URL |
| MiniMax (飞书) | 5 条有 URL + 30 条 JD 碎片 | 只保留有 `/position/{ID}/detail` 的条目 |

---

## 难点 9：搜索框交互 vs URL 参数 -- 同一站点两种命运

### 问题

v2 脚本依赖 **URL 参数** 来筛选岗位（如字节跳动 `category=6704215862603155720&location=CT_51`），这在 Round 8 是有效的。但到了 Round 9，**同样的 URL 参数返回 0 结果**（"暂无职位"），而在浏览器中手动搜索却能找到 10+ 个岗位。

```
# v2 策略：URL 参数筛选 -- Round 9 返回 0 结果
https://jobs.bytedance.com/experienced/position?category=6704215862603155720&location=CT_51
→ 页面显示"暂无职位"

# v3 策略：在搜索框中输入关键词 -- 返回 10+ 结果
打开 https://jobs.bytedance.com/experienced/position
→ 在搜索框输入"产品经理"
→ 按回车
→ 点击"上海"筛选
→ 返回 10 个岗位
```

**根因分析：**
- 大厂 SPA 的 URL 参数映射经常变化（category ID、location code 随版本更新）
- URL 参数可能绑定了前端路由状态，直接访问不会触发后端 API 调用
- 搜索框输入会触发完整的前端搜索流程（输入 → debounce → API 请求 → 渲染）

### 解决方案：搜索框交互优先

```javascript
// v3 策略：先导航到列表页，再用搜索框交互
await page.goto('https://jobs.bytedance.com/experienced/position', {
  waitUntil: 'domcontentloaded', timeout: 30000
});
await page.waitForTimeout(5000);

// 在搜索框中输入关键词
const searchInput = await page.$('input[type="text"]');
if (searchInput) {
  await searchInput.click();
  await searchInput.fill('产品经理');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
}

// 点击地区筛选
const shanghaiBtn = await page.$('text=上海');
if (shanghaiBtn) {
  await shanghaiBtn.click();
  await page.waitForTimeout(3000);
}

// 现在可以提取岗位了
const jobs = await page.evaluate(() => { /* ... */ });
```

**关键细节：**
1. **不要在 URL 中带参数** -- 直接导航到基础列表页
2. **等待搜索框出现** -- SPA 初始化需要 3-5 秒
3. **用 `fill()` 而非 `type()`** -- `fill()` 清空后一次性填入，更快更稳定
4. **筛选器用 `text=` 定位** -- 比 CSS 选择器更抗 DOM 变化
5. **每次交互后等 3-5 秒** -- SPA 需要时间渲染新数据

### B 站的特殊情况

B 站的 SPA 尤其难处理：
- `networkidle` 永远不触发（后台持续轮询），**必须用 `domcontentloaded`**
- 初始加载后需要等 **10-15 秒**（远超其他站点的 3-5 秒）
- 岗位卡片没有 `<a>` 标签，纯 click handler 跳转
- 详情页也是 SPA，直接导航经常超时

```javascript
// B站专用等待策略
await page.goto('https://jobs.bilibili.com/social/positions', {
  waitUntil: 'domcontentloaded',  // 不用 networkidle！
  timeout: 45000,
});
await page.waitForTimeout(15000);  // B站需要很长时间渲染

// 搜索 AI 相关岗位
const searchInput = await page.$('input[placeholder*="搜索"], input[type="text"]');
if (searchInput) {
  await searchInput.click();
  await searchInput.fill('AI');
  const searchBtn = await page.$('button:has-text("搜索")');
  if (searchBtn) await searchBtn.click();
  else await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);
}
```

---

## 难点 10：API 响应拦截 -- SPA 的终极武器

### 问题

有些 SPA 站点的 DOM 结构极度复杂（嵌套 Shadow DOM、虚拟列表、动态 class 名），靠 CSS 选择器提取非常脆弱。但这些 SPA 底层一定会调 API 获取数据——如果能直接拦截 API 响应，就能拿到**结构化的 JSON 数据**，比从 DOM 提取准确得多。

### 解决方案：page.on("response") 拦截

```javascript
// 腾讯招聘 API 拦截示例
const capturedJobs = [];

page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('tencentcareer/api/post/Query')) return;

  try {
    const json = await response.json();
    const posts = json?.Data?.Posts || [];
    for (const post of posts) {
      capturedJobs.push({
        title: post.PostName || post.RecruitPostName,
        url: `https://careers.tencent.com/jobdesc.html?postId=${post.PostId}`,
        location: post.LocationName,
        department: post.CategoryName,
        lastUpdate: post.LastUpdateTime,
      });
    }
    console.log(`  拦截到 ${posts.length} 条岗位数据`);
  } catch (e) {
    // 非 JSON 响应，跳过
  }
});

// 导航到腾讯招聘页面，触发 API 调用
await page.goto('https://careers.tencent.com/search.html?pcid=40001&locationId=2156', {
  waitUntil: 'domcontentloaded', timeout: 30000,
});
await page.waitForTimeout(8000);  // 等待 API 响应被拦截
```

### 同源限制：page.evaluate 中的 fetch

另一种方式是在页面上下文中直接调用 API。但要注意**同源限制**：

```javascript
// 错误：在 bilibili.com 的页面上下文中调用 tencent.com 的 API → CORS 失败
const biliPage = await browser.newPage();
await biliPage.goto('https://jobs.bilibili.com/...');
const data = await biliPage.evaluate(() =>
  fetch('https://careers.tencent.com/tencentcareer/api/post/Query?...')  // CORS 错误！
);

// 正确：先导航到 tencent.com，再用相对路径调用 API
const tencentPage = await browser.newPage();
await tencentPage.goto('https://careers.tencent.com/search.html', { ... });
const data = await tencentPage.evaluate(() =>
  fetch('/tencentcareer/api/post/Query?timestamp=0&countryId=&cityId=2156&bgIds=&productId=&categoryId=&parentCategoryId=&attrId=&keyword=产品&pageIndex=0&pageSize=20&language=zh-cn&area=cn')
    .then(r => r.json())
);
```

**关键细节：**
1. **API 拦截优于 DOM 提取** -- JSON 数据结构化、完整、不受 DOM 变化影响
2. **每个站点用独立的 `browser.newPage()`** -- 避免同源问题
3. **用相对路径** -- `/tencentcareer/api/...` 而非完整 URL，确保同源
4. **cityId=2156 是上海** -- 腾讯的城市 ID 需要事先查清
5. **`language=zh-cn&area=cn`** -- 不加这两个参数可能返回海外岗位

### 何时用 API 拦截 vs DOM 提取

| 场景 | 推荐方式 |
|------|---------|
| 页面 DOM 结构简单清晰 | DOM 提取 |
| 有 `<a>` 标签指向详情页 | DOM 提取 |
| DOM 嵌套复杂、class 名随机 | API 拦截 |
| 需要翻页且翻页通过 API 实现 | API 拦截 |
| 需要精确的结构化数据（城市、部门、更新时间等） | API 拦截 |

---

## 难点 11：飞书门户详情页不渲染 -- 列表页才有 JD

### 问题

飞书招聘门户（如 MiniMax、智谱等）的**详情页**直接访问时不渲染 JD 内容——页面只显示"职位\nXXX校招\n登录"，因为详情页内容被登录墙阻挡。

```
# 直接访问详情页
https://vrfi1sk8a0.jobs.feishu.cn/index/position/7579523111286147366/detail
→ 渲染结果："职位\nMiniMax校招\n登录"  # 没有 JD！

# 但列表页的岗位卡片中其实包含了 JD 摘要
列表页卡片的 fullText 字段 → 包含岗位描述、职责、要求等完整信息
```

### 解决方案：从列表页卡片提取 JD

```javascript
// 飞书列表页的每个岗位卡片其实包含了 JD 全文
const jobs = await page.evaluate(() => {
  const results = [];
  document.querySelectorAll('a[href*="/position/"]').forEach(a => {
    // 获取整个卡片容器
    const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
    const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');

    // fullText 中通常包含：岗位名 + 城市 + 类别 + JD描述
    // 不需要跳转到详情页
    results.push({
      title: extractTitle(fullText),
      url: a.href,
      jdSummary: fullText,  // 列表页卡片中的 JD 摘要
    });
  });
  return results;
});
```

**关键教训：** 不要假设"详情页一定比列表页信息多"——在有登录墙的 SPA 站点上，列表页可能是唯一的数据来源。

---

## 最终架构

经过 9 轮迭代后的最终架构：

```
┌─────────────────────────────────────────────────────────────┐
│                        主 Agent (有网络)                      │
│   WebSearch: "site:jobs.xxx.com 产品经理 上海"                │
│   WebFetch: 静态页面直接抓                                    │
│   Playwright 多策略抓取（按优先级）:                            │
│     1. 搜索框交互 (v3 新增)                                   │
│     2. API 响应拦截 (v3 新增)                                 │
│     3. DOM 提取 + URL 模式过滤                                │
│     4. 列表页卡片文本提取                                      │
│   CDP: Boss直聘等反自动化平台                                  │
│   AppleScript: 终极降级方案                                   │
│                                                              │
│   搜索结果 → 保存到 docs/target-positions/                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ 文件传递（非网络）
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Subagents (无网络)                        │
│   jd-analyzer: 读取文件 → 分析 JD → 匹配排名                  │
│   resume-tailor: 读取文件 → 定制简历                          │
│   job-applier: 读取文件 → 准备投递 → 执行投递脚本              │
└─────────────────────────────────────────────────────────────┘
```

**核心原则：有网络能力的 Agent 负责获取数据，无网络的 Agent 只处理已获取的数据。**

---

## 各平台攻克方案速查

| 平台 | 方案 | 脚本 | 备注 |
|------|------|------|------|
| **公司官网（无登录）** | Playwright 直接渲染 | `scrape-jobs.js` | 等待 SPA 加载后提取 |
| **飞书招聘门户** | Playwright + 列表页卡片文本提取 | `scrape-jobs.js --site minimax` | 详情页需登录，从列表页卡片获取 JD |
| **字节跳动** | Playwright + **搜索框交互** | `scrape-jobs.js --site bytedance` | URL 参数已失效，改用搜索框 + 点击筛选 |
| **腾讯** | Playwright + **API 响应拦截** | `scrape-jobs.js --site tencent` | 同源 fetch，cityId=2156(上海) |
| **B 站** | Playwright + 搜索框 + 长等待 | `scrape-jobs.js --site bilibili` | `domcontentloaded` + 15s 等待，详情页超时 |
| **Boss 直聘** | CDP 连接真实 Chrome | `scrape-boss-cdp.js` | 需先关闭 Chrome |
| **Boss 直聘 (降级)** | AppleScript + 剪贴板 | `boss-clipboard.sh` | macOS only，零检测风险 |
| **Boss 直聘 (JS注入)** | AppleScript + execute javascript | `boss-applescript.sh` | 结构化数据提取 |
| **猎聘/拉勾/智联** | 手动 | - | 反爬太强，建议手动 |

---

## 脚本使用说明

### 安装依赖

```bash
npm install playwright
npx playwright install chromium
```

### 1. 通用站点批量抓取

```bash
# 抓取所有预设站点
node scripts/scrape-jobs.js

# 抓取单个站点
node scripts/scrape-jobs.js --site minimax

# 自定义 URL
node scripts/scrape-jobs.js --url "https://any-career-site.com/jobs"
```

### 2. Boss 直聘 CDP 模式

```bash
# 会自动关闭 Chrome 并以调试模式重启
node scripts/boss-cdp-auto.js
```

### 3. Boss 直聘 AppleScript 模式 (macOS)

```bash
# 确保 Chrome 已打开且已登录 Boss 直聘
bash scripts/boss-clipboard.sh

# 或用 JS 注入方式提取结构化数据
bash scripts/boss-applescript.sh
```

### 4. 交互式浏览

```bash
# 打开指定公司的招聘页，用网站自带筛选器手动浏览
node scripts/browse-jobs.js --site bytedance
node scripts/browse-jobs.js --site list  # 查看所有支持的站点
```

---

## 经验教训总结

### 1. 不要相信 LLM 编造的数据

这是最重要的教训。当你让一个没有网络能力的 AI Agent 去"搜索"信息时，它不会说"我做不到"，而是会编造看起来完全合理的假数据。**必须在架构层面确保数据来源的真实性。**

### 2. 从最简单的方案开始，逐步升级

```
fetch → Playwright Chromium → Playwright channel:'chrome'
  → CDP 真实 Chrome → AppleScript + 剪贴板
```

不需要一开始就用最复杂的方案。很多网站用最简单的 Playwright 渲染就够了。

### 3. 搜索框交互 > URL 参数 > 关键词匹配

**Round 8 的教训是"用 URL 参数优于搜索"，但 Round 9 推翻了这个结论。** URL 参数中的 category ID 和 location code 会随网站版本更新而失效。更稳定的策略是**模拟用户在搜索框中输入关键词**：

```
# ❌ v2 策略（已失效）：URL 参数硬编码
https://jobs.bytedance.com/experienced/position?category=6704215862603155720&location=CT_51
→ "暂无职位"

# ✅ v3 策略：搜索框交互
导航到基础 URL → 在搜索框输入"产品经理" → 按回车 → 点击"上海"
→ 返回 10+ 结果
```

**优先级排序：** 搜索框交互 → API 响应拦截 → URL 参数 → DOM 关键词匹配

### 4. 截图是最好的调试工具

每个关键步骤都截图保存。当页面返回空白、被拦截、或者加载超时时，截图能立即告诉你发生了什么。

```javascript
await page.screenshot({ path: 'debug-screenshot.png', fullPage: false });
```

### 5. 多选择器 fallback 应对 DOM 变化

中国互联网公司迭代速度极快，DOM 结构随时可能变。不要只用一个 CSS 选择器，准备 3-5 个 fallback。

### 6. 人机协作是最实际的方案

完全自动化是理想，半自动化是现实。最好的方案是：
- **自动化**可以做的部分：打开页面、填写表单、提取数据
- **留给人**的部分：登录验证、验证码、最终提交确认

### 7. API 拦截比 DOM 提取更可靠

SPA 的 DOM 结构随时会变（class 名随机化、组件嵌套方式变化），但底层 API 的数据格式相对稳定。用 `page.on("response")` 拦截 API 响应可以拿到**结构化的 JSON 数据**，比任何 CSS 选择器都稳定。

### 8. 同源问题：每个站点用独立 Page

在一个 page 的上下文中 `fetch()` 另一个域名的 API 会遇到 CORS 错误。解决方法：为每个站点创建独立的 `browser.newPage()`，在该站点域下用相对路径调用 API。

### 9. 各站点 waitForTimeout 参考值

不同站点 SPA 渲染速度差异巨大，这些等待时间是多次试验后的经验值：

| 站点 | 初始加载等待 | 搜索后等待 | 翻页后等待 |
|------|------------|-----------|-----------|
| 字节跳动 | 5s | 5s | 3s |
| 腾讯 | 5s | 3s | 3s |
| B 站 | 15s | 8s | 5s |
| 飞书门户 | 5s | 4s | 3s |
| 一般官网 | 3s | 2s | 2s |

---

## License

MIT

---

**如果这个指南帮到了你，请给个 Star！** 如果你有其他平台的攻克经验，欢迎提 PR。
