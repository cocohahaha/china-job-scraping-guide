/**
 * 预置站点配置
 *
 * 每个预设都是经过实战验证的配置，可以直接传给 scraper.scrape()。
 * 用户也可以基于预设覆盖任意字段：
 *   scraper.scrape('bytedance', { search: '工程师', click: ['北京'] })
 */

// ========= 飞书门户通用提取器 =========
// 很多中国 AI 公司使用飞书招聘门户（xxx.jobs.feishu.cn）
// 关键发现：详情页有登录墙不渲染 JD，但列表页卡片中包含 JD 摘要
function feishuExtract(page) {
  return page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a[href*="/position/"]').forEach(a => {
      const href = a.href;
      if (!href.includes('/detail') && !href.match(/\/position\/\d+/)) return;

      const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
      const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');

      const titleMatch = fullText.match(/^(.+?)(?:北京|上海|深圳|杭州|广州|成都|旧金山|远程|社招|校招)/);
      const title = titleMatch ? titleMatch[1].trim() : (a.textContent || '').trim().split(/\s/)[0];

      const locMatch = fullText.match(/((?:北京|上海|深圳|杭州|广州|成都|远程)(?:、(?:北京|上海|深圳|杭州|广州|成都|远程))*)/);

      if (title && title.length > 2 && title.length < 80) {
        results.push({
          title,
          url: href,
          location: locMatch ? locMatch[1] : '',
          text: fullText.slice(0, 1000),
        });
      }
    });
    return results;
  });
}

// 飞书门户的前置操作：点击"社会招聘" tab → 搜索
async function feishuBeforeExtract(page) {
  for (const tab of ['社会招聘', '社招', '全部职位']) {
    try {
      const el = page.locator(`text=${tab}`).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForTimeout(3000);
        break;
      }
    } catch (e) {}
  }
}

function makeFeishuPreset(name, url, searchKeyword) {
  return {
    name,
    url,
    wait: 5000,
    search: searchKeyword ? { text: searchKeyword, waitAfter: 4000 } : undefined,
    extract: async (page) => {
      await feishuBeforeExtract(page);
      return feishuExtract(page);
    },
    paginate: { maxPages: 3, next: 'button:has-text("下一页"), [class*="next"]' },
  };
}

// ========= 预设 =========
const presets = {

  // ---------- 字节跳动 ----------
  // 关键发现：URL 参数筛选会失效（category ID 经常变），搜索框交互更可靠
  bytedance: {
    name: '字节跳动',
    url: 'https://jobs.bytedance.com/experienced/position',
    wait: 5000,
    search: { text: '产品经理', waitAfter: 5000 },
    click: ['上海'],
    waitForSelector: 'a[href*="/position/"]',
    extract: (page) => page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href*="/position/"]').forEach(a => {
        const href = a.href;
        if (href.includes('/page-') || href.includes('/position?')) return;
        if (!/\/position\/\d+/.test(href)) return;
        const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');
        const title = linkText.length > 2 && linkText.length < 100 ? linkText : fullText.slice(0, 80);
        const loc = fullText.match(/(上海|北京|深圳|杭州|广州|成都)/);
        if (title && title.length > 2) {
          results.push({ title, url: href, location: loc ? loc[1] : '' });
        }
      });
      return results;
    }),
    paginate: { maxPages: 3, next: '[class*="next"]' },
  },

  // ---------- 腾讯 ----------
  // 关键发现：API 响应拦截比 DOM 提取稳定得多，返回结构化 JSON
  tencent: {
    name: '腾讯',
    url: 'https://careers.tencent.com/search.html?pcid=40001&locationId=2156',
    wait: 5000,
    api: {
      match: 'tencentcareer/api/post/Query',
      // 同源 fetch fallback（在 careers.tencent.com 域下调用）
      fetch: '/tencentcareer/api/post/Query?timestamp=0&countryId=&cityId=2156&bgIds=&productId=&categoryId=&parentCategoryId=&attrId=&keyword=产品&pageIndex=0&pageSize=20&language=zh-cn&area=cn',
      transform: (json) => (json?.Data?.Posts || []).map(p => ({
        title: p.PostName || p.RecruitPostName || '',
        url: `https://careers.tencent.com/jobdesc.html?postId=${p.PostId}`,
        location: p.LocationName || '',
        department: p.CategoryName || '',
        bg: p.BGName || '',
        lastUpdate: p.LastUpdateTime || '',
      })),
    },
  },

  // ---------- B 站 ----------
  // 关键发现：networkidle 永远超时，必须用 domcontentloaded + 15s 等待
  bilibili: {
    name: 'B站',
    url: 'https://jobs.bilibili.com/social/positions',
    wait: 15000,
    timeout: 45000,
    search: { text: 'AI', submit: 'button:has-text("搜索")', waitAfter: 8000 },
    extract: (page) => page.evaluate(() => {
      const results = [];
      const seen = new Set();
      // 策略 1: <a> 链接
      document.querySelectorAll('a[href*="positions"]').forEach(a => {
        if (seen.has(a.href)) return;
        seen.add(a.href);
        const card = a.closest('[class*="item"], [class*="card"], li') || a;
        const text = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim();
        if (linkText.length > 2 && linkText.length < 100) {
          results.push({ title: linkText, url: a.href, text: text.slice(0, 500) });
        }
      });
      // 策略 2: 无链接的卡片
      if (results.length === 0) {
        for (const sel of ['[class*="position-item"]', '[class*="job-card"]', '[class*="job-item"]']) {
          document.querySelectorAll(sel).forEach(card => {
            const titleEl = card.querySelector('h3, h4, [class*="title"]');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (title && !seen.has(title)) {
              seen.add(title);
              results.push({ title, url: '', text: (card.textContent || '').slice(0, 500) });
            }
          });
          if (results.length > 0) break;
        }
      }
      return results;
    }),
  },

  // ---------- 飞书招聘门户 ----------
  minimax:     makeFeishuPreset('MiniMax', 'https://vrfi1sk8a0.jobs.feishu.cn/', '产品'),
  zhipu:       makeFeishuPreset('智谱AI', 'https://zhipu-ai.jobs.feishu.cn/', '产品'),
  baichuan:    makeFeishuPreset('百川智能', 'https://cq6qe6bvfr6.jobs.feishu.cn/', '产品'),
  lingyiwanwu: makeFeishuPreset('零一万物', 'https://01ai.jobs.feishu.cn/', '产品'),

  // ---------- Boss 直聘 ----------
  // 需要先调用 scraper.connectCDP() 连接真实 Chrome
  boss: {
    name: 'Boss直聘',
    url: 'https://www.zhipin.com/web/geek/job?query=AI产品经理&city=101020100',
    _note: '需要 connectCDP() + 手动登录',
    wait: 5000,
    extract: (page) => page.evaluate(() => {
      const results = [];
      const selectors = [
        '.job-card-wrapper',
        '.search-job-result .job-card-body',
        '[class*="job-card"]',
        '.job-list li',
      ];
      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > cards.length) cards = Array.from(found);
      }
      if (cards.length === 0) {
        document.querySelectorAll('a[href*="job_detail"]').forEach(a => {
          const parent = a.closest('li, div[class], article');
          if (parent && !cards.includes(parent)) cards.push(parent);
        });
      }
      cards.forEach(card => {
        const title = (card.querySelector('.job-name, [class*="job-name"]')?.textContent || '').trim();
        const company = (card.querySelector('.company-name, [class*="company-name"]')?.textContent || '').trim();
        const salary = (card.querySelector('.salary, [class*="salary"]')?.textContent || '').trim();
        const location = (card.querySelector('.job-area, [class*="job-area"]')?.textContent || '').trim();
        const linkEl = card.querySelector('a[href*="job_detail"]') || card.querySelector('a');
        if (title || (card.innerText || '').length > 30) {
          results.push({
            title: title || (card.innerText || '').slice(0, 100).replace(/\n/g, ' '),
            company, salary, location,
            url: linkEl?.href || '',
          });
        }
      });
      return results;
    }),
  },

  // ---------- 其他官网 ----------
  alibaba: {
    name: '阿里巴巴',
    url: 'https://talent.alibaba.com/off-campus/position-list?lang=zh',
    wait: 5000,
  },
  stepfun: {
    name: '阶跃星辰',
    url: 'https://www.stepfun.com/company',
    wait: 5000,
  },
  moonshot: {
    name: '月之暗面',
    url: 'https://www.moonshot.cn/jobs',
    wait: 5000,
  },
  mihoyo: {
    name: '米哈游',
    url: 'https://jobs.mihoyo.com/#/social',
    wait: 5000,
  },
  netease: {
    name: '网易',
    url: 'https://hr.163.com/job-list.html?workType=1&lang=zh',
    wait: 5000,
  },
};

module.exports = presets;
