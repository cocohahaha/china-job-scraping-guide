const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * ChinaScraper - 针对中国大陆网站的 Playwright 爬虫
 *
 * 内置处理中国网站常见问题：
 * - SPA 渲染（智能等待策略）
 * - 搜索框交互（比 URL 参数更可靠）
 * - API 响应拦截（比 DOM 提取更稳定）
 * - 反自动化绕过（CDP 连接真实 Chrome）
 * - 登录墙等待（半自动化登录）
 */
class ChinaScraper {
  /**
   * @param {Object} options
   * @param {boolean} [options.headless=false] - 是否无头模式
   * @param {string} [options.locale='zh-CN'] - 浏览器语言
   * @param {Object} [options.viewport] - 视口大小 { width, height }
   * @param {string} [options.screenshotDir] - 截图保存目录（null 则不截图）
   * @param {number} [options.slowMo=0] - 操作间隔（毫秒），调大可模拟人类速度
   */
  constructor(options = {}) {
    this.headless = options.headless ?? false;
    this.locale = options.locale || 'zh-CN';
    this.viewport = options.viewport || { width: 1280, height: 900 };
    this.screenshotDir = options.screenshotDir || null;
    this.slowMo = options.slowMo || 0;
    this.browser = null;
    this._cdp = false;
  }

  /** 启动浏览器 */
  async launch() {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: this.headless,
      slowMo: this.slowMo,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  /** 关闭浏览器 */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this._cdp = false;
    }
  }

  /**
   * 通过 CDP 连接真实 Chrome（用于反自动化站点如 Boss 直聘）
   *
   * 原理：以调试模式启动用户本机 Chrome，通过 CDP 协议控制。
   * 反自动化检测完全无效，因为就是真实 Chrome + 用户真实 profile。
   *
   * @param {Object} [options]
   * @param {number} [options.port=9222] - CDP 调试端口
   * @param {boolean} [options.relaunch=true] - 是否重启 Chrome（macOS）
   * @returns {ChinaScraper} this
   */
  async connectCDP(options = {}) {
    const port = options.port || 9222;
    const relaunch = options.relaunch !== false;

    if (relaunch && process.platform === 'darwin') {
      try {
        execSync('osascript -e \'tell application "Google Chrome" to quit\' 2>/dev/null || true');
        await _sleep(3000);
        execSync('pkill -f "Google Chrome" 2>/dev/null || true');
        await _sleep(2000);
      } catch (e) {}

      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const userDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome`;

      const chrome = spawn(chromePath, [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
      ], { detached: true, stdio: 'ignore' });
      chrome.unref();

      for (let i = 0; i < 15; i++) {
        await _sleep(2000);
        try {
          const resp = execSync(`curl -s http://localhost:${port}/json/version 2>/dev/null`).toString();
          if (resp.includes('Browser')) break;
        } catch (e) {}
        if (i === 14) throw new Error(`Chrome 调试端口 ${port} 启动超时`);
      }
    }

    this.browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    this._cdp = true;
    return this;
  }

  /**
   * 核心方法：抓取页面数据
   *
   * 执行流程：
   *   1. 注册 API 拦截（如有）
   *   2. 导航到目标页面
   *   3. 等待 SPA 渲染
   *   4. 执行页面交互（搜索、点击筛选）
   *   5. 提取数据
   *   6. 翻页（如有）
   *   7. 去重
   *
   * @param {string|Object} target - URL、预设名称、或完整配置对象
   * @param {Object} [options] - 覆盖配置
   * @returns {Array} 提取到的数据数组
   */
  async scrape(target, options = {}) {
    const config = this._resolveConfig(target, options);
    if (!config.url) throw new Error('url is required');

    if (!this.browser) await this.launch();

    const page = await this.browser.newPage();

    try {
      // --- Phase 1: API 拦截 ---
      let apiData = [];
      if (config.api?.match) {
        page.on('response', async (resp) => {
          if (!resp.url().includes(config.api.match)) return;
          try {
            const json = await resp.json();
            const items = config.api.transform ? config.api.transform(json) : json;
            if (Array.isArray(items)) apiData.push(...items);
          } catch (e) {}
        });
      }

      // --- Phase 2: 导航 ---
      await page.goto(config.url, {
        waitUntil: config.waitUntil || 'domcontentloaded',
        timeout: config.timeout || 30000,
      });

      // --- Phase 3: SPA 渲染等待 ---
      await page.waitForTimeout(config.wait ?? 5000);
      await this._screenshot(page, config, 'initial');

      // --- Phase 4: 页面交互 ---
      if (config.actions) {
        // actions 数组：按顺序执行
        for (const action of config.actions) {
          await this._executeAction(page, action);
        }
      } else {
        // search / click 快捷方式
        if (config.search) await this._doSearch(page, config.search);
        if (config.click) await this._doClicks(page, config.click, config.clickWait);
      }

      if (config.waitForSelector) {
        try { await page.waitForSelector(config.waitForSelector, { timeout: 10000 }); } catch (e) {}
      }

      await this._screenshot(page, config, 'ready');

      // --- Phase 5: 数据提取 ---
      let result = await this._extractData(page, config, apiData);
      if (!Array.isArray(result)) result = result ? [result] : [];

      // --- Phase 6: 翻页 ---
      if (config.paginate && result.length > 0) {
        const moreData = await this._paginate(page, config, apiData.length);
        result.push(...moreData);
      }

      // --- Phase 7: 去重 ---
      return _dedup(result);
    } finally {
      await page.close();
    }
  }

  /**
   * 等待用户在浏览器中手动登录
   *
   * @param {Page} page - Playwright Page 对象
   * @param {Object} [options]
   * @param {number} [options.timeout=180000] - 最大等待时间
   * @param {string[]} [options.indicators] - 登录成功的文本标志
   * @returns {boolean} 是否登录成功
   */
  async waitForLogin(page, options = {}) {
    const timeout = options.timeout || 180000;
    const indicators = options.indicators || ['个人中心', '我的', '退出登录'];
    const selectors = options.selectors || ['[class*="avatar"]', '[class*="user-info"]'];

    try {
      await page.waitForFunction(
        ({ inds, sels }) => {
          const text = document.body?.innerText || '';
          if (inds.some(i => text.includes(i))) return true;
          if (sels.some(s => document.querySelector(s))) return true;
          return false;
        },
        { inds: indicators, sels: selectors },
        { timeout },
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 获取一个新页面（低级 API，用于自定义流程）
   * @returns {Page}
   */
  async newPage() {
    if (!this.browser) await this.launch();
    return this.browser.newPage();
  }

  // ========= 内部方法 =========

  _resolveConfig(target, options) {
    const presets = require('./presets');
    if (typeof target === 'string' && presets[target]) {
      return { ...presets[target], ...options };
    }
    if (typeof target === 'string') {
      return { url: target, ...options };
    }
    return { ...target, ...options };
  }

  async _executeAction(page, action) {
    if (action.search) {
      await this._doSearch(page, action.search);
    } else if (action.click) {
      await this._doClicks(page, [action.click], action.wait);
    } else if (action.wait) {
      await page.waitForTimeout(action.wait);
    } else if (action.scroll) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(action.scrollWait || 2000);
    }
  }

  async _doSearch(page, searchConfig) {
    const s = typeof searchConfig === 'string' ? { text: searchConfig } : searchConfig;
    const inputSel = s.input || 'input[type="text"], input[type="search"], input[placeholder*="搜索"]';

    const input = await page.$(inputSel);
    if (!input) return;

    await input.click();
    await input.fill(s.text);

    if (s.submit) {
      const btn = await page.$(s.submit);
      if (btn) await btn.click();
      else await page.keyboard.press('Enter');
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(s.waitAfter ?? 5000);
  }

  async _doClicks(page, targets, defaultWait) {
    const items = Array.isArray(targets) ? targets : [targets];
    for (const target of items) {
      try {
        let el;
        if (typeof target === 'object') {
          el = target.selector ? await page.$(target.selector) : await page.$(`text=${target.text}`);
        } else if (/^[.#\[]/.test(target)) {
          el = await page.$(target);
        } else {
          el = await page.$(`text=${target}`);
        }
        if (el) {
          await el.click();
          await page.waitForTimeout(defaultWait ?? 3000);
        }
      } catch (e) {}
    }
  }

  async _extractData(page, config, apiData) {
    // 优先级：API 拦截 > 同源 fetch > 自定义函数 > 声明式 > 自动
    if (config.api?.match && apiData.length > 0) {
      return apiData;
    }

    if (config.api?.fetch) {
      try {
        const raw = await page.evaluate(
          async (url) => { const r = await fetch(url); return r.json(); },
          config.api.fetch,
        );
        return config.api.transform ? config.api.transform(raw) : raw;
      } catch (e) {
        // fetch 失败，继续 fallback
      }
    }

    if (typeof config.extract === 'function') {
      return config.extract(page);
    }

    if (config.selector && config.fields) {
      return this._declarativeExtract(page, config.selector, config.fields);
    }

    return this._autoExtract(page);
  }

  // 声明式提取
  async _declarativeExtract(page, selector, fields) {
    return page.evaluate(({ sel, flds }) => {
      const items = [];
      document.querySelectorAll(sel).forEach(el => {
        const item = {};
        for (const [key, fieldSel] of Object.entries(flds)) {
          if (fieldSel.includes(' @')) {
            const [s, attr] = fieldSel.split(' @');
            const target = s ? el.querySelector(s) : el;
            item[key] = target ? target.getAttribute(attr) || '' : '';
          } else {
            const target = el.querySelector(fieldSel);
            item[key] = target ? target.textContent.trim() : '';
          }
        }
        if (Object.values(item).some(v => v)) items.push(item);
      });
      return items;
    }, { sel: selector, flds: fields });
  }

  // 自动提取：找详情页链接和卡片
  async _autoExtract(page) {
    return page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // 策略 1：找详情页 URL 模式的链接
      document.querySelectorAll('a').forEach(a => {
        const href = a.href || '';
        if (!href || seen.has(href) || href.startsWith('javascript:') || href === '#') return;

        const isDetail = /(position|job|career|detail|post|article).*\d{4,}/.test(href)
          || /\/\d{6,}(\/|$|\.)/.test(href)
          || /[?&](id|postId|articleId)=\d+/.test(href);
        if (!isDetail) return;

        const card = a.closest('[class*="item"], [class*="card"], [class*="row"], li') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');

        const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
        const title = (linkText.length > 2 && linkText.length < 100)
          ? linkText
          : (titleEl ? titleEl.textContent.trim() : fullText.slice(0, 80));

        if (title && title.length > 2) {
          seen.add(href);
          results.push({ title, url: href, text: fullText.slice(0, 500) });
        }
      });

      // 策略 2：SPA 卡片（无 <a> 标签，用 click handler）
      if (results.length === 0) {
        const cardSelectors = [
          '[class*="job-item"]', '[class*="position-item"]', '[class*="list-item"]',
          '[class*="job-card"]', '[class*="card-item"]', '[class*="recruit"] li',
        ];
        for (const sel of cardSelectors) {
          document.querySelectorAll(sel).forEach(card => {
            const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (title && title.length > 2 && title.length < 100 && !seen.has(title)) {
              seen.add(title);
              const link = card.querySelector('a');
              results.push({
                title,
                url: link ? link.href : '',
                text: (card.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500),
              });
            }
          });
          if (results.length > 0) break;
        }
      }

      return results;
    });
  }

  async _paginate(page, config, initialApiCount) {
    const pag = config.paginate;
    const maxPages = pag.maxPages || 3;
    const nextSel = pag.next || 'button:has-text("下一页"), [class*="next"]:not([class*="disabled"])';
    const waitAfter = pag.waitAfter || 3000;
    const moreData = [];

    for (let p = 1; p < maxPages; p++) {
      try {
        const nextBtn = page.locator(nextSel).first();
        if (!await nextBtn.isVisible({ timeout: 2000 })) break;
        if (!await nextBtn.isEnabled({ timeout: 1000 })) break;
        await nextBtn.click();
        await page.waitForTimeout(waitAfter);

        const pageData = await this._extractData(page, config, []);
        if (!pageData || pageData.length === 0) break;
        moreData.push(...pageData);
      } catch (e) { break; }
    }

    return moreData;
  }

  async _screenshot(page, config, suffix) {
    const dir = config.screenshotDir || this.screenshotDir;
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const hostname = new URL(config.url).hostname.replace(/\./g, '-');
    const filePath = path.join(dir, `${hostname}-${suffix}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  }
}

// ========= 工具函数 =========

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.url || item.title || JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { ChinaScraper };
