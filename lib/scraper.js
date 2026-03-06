const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('./http');

// Playwright 懒加载（可选依赖）
let _chromium = null;
function getChromium() {
  if (_chromium) return _chromium;
  try {
    _chromium = require('playwright').chromium;
    return _chromium;
  } catch (e) {
    throw new Error(
      'Playwright 未安装。当前操作需要浏览器渲染。\n'
      + '安装方法: npm install playwright && npx playwright install chromium\n'
      + '如果只需要抓取静态页面，可以用 ScrapeCN.fetch() 代替。'
    );
  }
}

/**
 * ScrapeCN - 专为中国大陆网站设计的数据抓取工具包
 *
 * 3 层策略，按需升级：
 *   1. HTTP fetch   — 静态页面，零依赖，最快
 *   2. Playwright   — SPA 渲染、搜索框交互、API 拦截
 *   3. CDP Chrome   — 反自动化站点（Boss 直聘等）
 *
 * Playwright 和 CDP 是可选的——只有用到时才需要安装。
 */
class ScrapeCN {

  /**
   * @param {Object} [options]
   * @param {boolean} [options.headless=false] - 无头模式
   * @param {string} [options.locale='zh-CN'] - 浏览器语言
   * @param {Object} [options.viewport] - 视口大小
   * @param {string} [options.screenshotDir] - 截图目录
   * @param {number} [options.slowMo=0] - 操作间隔（毫秒）
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

  // ================================================================
  //  策略 1: HTTP fetch（零依赖，不需要 Playwright）
  // ================================================================

  /**
   * 用 HTTP 请求抓取页面，从 HTML 中提取数据。
   * 适用于服务端渲染的页面、公开 API、JSON-LD 数据。
   * SPA 页面用这个方法只能拿到空壳——需要 scrape()。
   *
   * @param {string} url
   * @param {Object} [options]
   * @param {Object} [options.headers] - 自定义请求头
   * @param {string} [options.cookie] - Cookie
   * @param {RegExp} [options.linkPattern] - 链接匹配正则
   * @param {string[]} [options.keywords] - 关键词过滤
   * @returns {Object} { html, links, jsonLD, inlineData }
   */
  static async fetch(url, options = {}) {
    const html = await http.fetchText(url, options);
    return {
      html,
      links: http.parseLinks(html, options),
      jsonLD: http.parseJsonLD(html),
      inlineData: http.parseInlineJSON(html, options.inlineVar),
    };
  }

  /**
   * 直接调用 JSON API
   *
   * @param {string} url - API 完整 URL
   * @param {Object} [options]
   * @param {Function} [options.transform] - 数据转换函数
   * @returns {any}
   */
  static async api(url, options = {}) {
    const json = await http.fetchJSON(url, options);
    return options.transform ? options.transform(json) : json;
  }

  // ================================================================
  //  策略 2: Playwright 渲染（需要安装 playwright）
  // ================================================================

  /** 启动 Playwright 浏览器 */
  async launch() {
    if (this.browser) return;
    const chromium = getChromium();
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
   * Playwright 渲染抓取——处理 SPA、搜索框交互、API 拦截等。
   *
   * 执行流程:
   *   注册 API 拦截 → 导航 → 等待渲染 → 交互(搜索/筛选)
   *   → 提取数据 → 翻页 → 去重
   *
   * @param {string|Object} target - URL / 预设名 / 配置对象
   * @param {Object} [options] - 覆盖配置（见 README 配置表）
   * @returns {Array} 提取到的数据
   */
  async scrape(target, options = {}) {
    const config = this._resolveConfig(target, options);
    if (!config.url) throw new Error('url is required');

    if (!this.browser) await this.launch();

    const page = await this.browser.newPage();

    try {
      // API 拦截
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

      // 导航
      await page.goto(config.url, {
        waitUntil: config.waitUntil || 'domcontentloaded',
        timeout: config.timeout || 30000,
      });

      // SPA 渲染等待
      await page.waitForTimeout(config.wait ?? 5000);
      await this._screenshot(page, config, 'initial');

      // 页面交互
      if (config.actions) {
        for (const action of config.actions) {
          await this._executeAction(page, action);
        }
      } else {
        if (config.search) await this._doSearch(page, config.search);
        if (config.click) await this._doClicks(page, config.click, config.clickWait);
      }

      if (config.waitForSelector) {
        try { await page.waitForSelector(config.waitForSelector, { timeout: 10000 }); } catch (e) {}
      }

      await this._screenshot(page, config, 'ready');

      // 数据提取
      let result = await this._extractData(page, config, apiData);
      if (!Array.isArray(result)) result = result ? [result] : [];

      // 翻页
      if (config.paginate && result.length > 0) {
        result.push(...await this._paginate(page, config));
      }

      return _dedup(result);
    } finally {
      await page.close();
    }
  }

  // ================================================================
  //  策略 3: CDP 连接真实 Chrome（反自动化站点）
  // ================================================================

  /**
   * 通过 CDP 连接用户本机的真实 Chrome。
   * 反自动化检测完全无效——因为就是真实 Chrome + 真实 profile。
   *
   * @param {Object} [options]
   * @param {number} [options.port=9222] - 调试端口
   * @param {boolean} [options.relaunch=true] - 是否重启 Chrome（仅 macOS）
   */
  async connectCDP(options = {}) {
    const chromium = getChromium();
    const port = options.port || 9222;

    if (options.relaunch !== false && process.platform === 'darwin') {
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
        '--no-first-run', '--no-default-browser-check',
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

  // ================================================================
  //  工具方法
  // ================================================================

  /**
   * 等待用户在浏览器中手动登录
   * @param {Page} page
   * @param {Object} [options]
   * @returns {boolean}
   */
  async waitForLogin(page, options = {}) {
    const timeout = options.timeout || 180000;
    const indicators = options.indicators || ['个人中心', '我的', '退出登录'];
    const selectors = options.selectors || ['[class*="avatar"]', '[class*="user-info"]'];
    try {
      await page.waitForFunction(
        ({ inds, sels }) => {
          const text = document.body?.innerText || '';
          return inds.some(i => text.includes(i)) || sels.some(s => document.querySelector(s));
        },
        { inds: indicators, sels: selectors },
        { timeout },
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 获取原始 Playwright Page 对象 */
  async newPage() {
    if (!this.browser) await this.launch();
    return this.browser.newPage();
  }

  // ================================================================
  //  内部方法
  // ================================================================

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
    if (action.search) await this._doSearch(page, action.search);
    else if (action.click) await this._doClicks(page, [action.click], action.wait);
    else if (action.wait) await page.waitForTimeout(action.wait);
    else if (action.scroll) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(action.scrollWait || 2000);
    }
  }

  async _doSearch(page, cfg) {
    const s = typeof cfg === 'string' ? { text: cfg } : cfg;
    const input = await page.$(s.input || 'input[type="text"], input[type="search"], input[placeholder*="搜索"]');
    if (!input) return;
    await input.click();
    await input.fill(s.text);
    if (s.submit) {
      const btn = await page.$(s.submit);
      if (btn) await btn.click(); else await page.keyboard.press('Enter');
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(s.waitAfter ?? 5000);
  }

  async _doClicks(page, targets, defaultWait) {
    for (const t of Array.isArray(targets) ? targets : [targets]) {
      try {
        const sel = (typeof t === 'string' && /^[.#\[]/.test(t)) ? t : null;
        const el = sel ? await page.$(sel) : await page.$(`text=${typeof t === 'string' ? t : t.text || t.selector}`);
        if (el) { await el.click(); await page.waitForTimeout(defaultWait ?? 3000); }
      } catch (e) {}
    }
  }

  async _extractData(page, config, apiData) {
    if (config.api?.match && apiData.length > 0) return apiData;

    if (config.api?.fetch) {
      try {
        const raw = await page.evaluate(async (u) => { const r = await fetch(u); return r.json(); }, config.api.fetch);
        return config.api.transform ? config.api.transform(raw) : raw;
      } catch (e) {}
    }

    if (typeof config.extract === 'function') return config.extract(page);

    if (config.selector && config.fields) {
      return page.evaluate(({ sel, flds }) => {
        const items = [];
        document.querySelectorAll(sel).forEach(el => {
          const item = {};
          for (const [k, v] of Object.entries(flds)) {
            if (v.includes(' @')) {
              const [s, attr] = v.split(' @');
              const t = s ? el.querySelector(s) : el;
              item[k] = t ? t.getAttribute(attr) || '' : '';
            } else {
              const t = el.querySelector(v);
              item[k] = t ? t.textContent.trim() : '';
            }
          }
          if (Object.values(item).some(x => x)) items.push(item);
        });
        return items;
      }, { sel: config.selector, flds: config.fields });
    }

    return this._autoExtract(page);
  }

  async _autoExtract(page) {
    return page.evaluate(() => {
      const results = [], seen = new Set();
      document.querySelectorAll('a').forEach(a => {
        const href = a.href || '';
        if (!href || seen.has(href) || href.startsWith('javascript:') || href === '#') return;
        const isDetail = /(position|job|career|detail|post|article).*\d{4,}/.test(href)
          || /\/\d{6,}(\/|$|\.)/.test(href)
          || /[?&](id|postId|articleId)=\d+/.test(href);
        if (!isDetail) return;
        const card = a.closest('[class*="item"], [class*="card"], [class*="row"], li') || a;
        const text = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');
        const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
        const title = (linkText.length > 2 && linkText.length < 100)
          ? linkText : (titleEl ? titleEl.textContent.trim() : text.slice(0, 80));
        if (title && title.length > 2) { seen.add(href); results.push({ title, url: href, text: text.slice(0, 500) }); }
      });
      if (results.length === 0) {
        for (const sel of ['[class*="job-item"]', '[class*="position-item"]', '[class*="list-item"]', '[class*="card-item"]']) {
          document.querySelectorAll(sel).forEach(card => {
            const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (title && title.length > 2 && title.length < 100 && !seen.has(title)) {
              seen.add(title);
              const link = card.querySelector('a');
              results.push({ title, url: link ? link.href : '', text: (card.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500) });
            }
          });
          if (results.length > 0) break;
        }
      }
      return results;
    });
  }

  async _paginate(page, config) {
    const p = config.paginate;
    const nextSel = p.next || 'button:has-text("下一页"), [class*="next"]:not([class*="disabled"])';
    const more = [];
    for (let i = 1; i < (p.maxPages || 3); i++) {
      try {
        const btn = page.locator(nextSel).first();
        if (!await btn.isVisible({ timeout: 2000 }) || !await btn.isEnabled({ timeout: 1000 })) break;
        await btn.click();
        await page.waitForTimeout(p.waitAfter || 3000);
        const data = await this._extractData(page, config, []);
        if (!data || data.length === 0) break;
        more.push(...data);
      } catch (e) { break; }
    }
    return more;
  }

  async _screenshot(page, config, suffix) {
    const dir = config.screenshotDir || this.screenshotDir;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const name = new URL(config.url).hostname.replace(/\./g, '-');
    await page.screenshot({ path: path.join(dir, `${name}-${suffix}.png`), fullPage: false });
  }
}

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

module.exports = { ScrapeCN };
