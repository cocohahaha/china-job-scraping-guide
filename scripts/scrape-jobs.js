#!/usr/bin/env node
/**
 * 全自动岗位抓取器 v3 - 搜索框交互 + API 拦截 + 多策略 fallback
 *
 * v2 → v3 的核心变化：
 *   - 字节跳动：URL 参数筛选 → 搜索框输入"产品经理" + 点击"上海"
 *   - 腾讯：DOM 提取 → API 响应拦截（page.on("response")）
 *   - B站：新增专用提取器，domcontentloaded + 15s 等待
 *   - 飞书门户：详情页登录墙 → 从列表页卡片提取 JD 摘要
 *   - 通用策略升级：搜索框交互优先，URL 参数作为 fallback
 *
 * 用法：
 *   node scripts/scrape-jobs.js                       # 抓取所有预设站点
 *   node scripts/scrape-jobs.js --site minimax         # 抓取单个站点
 *   node scripts/scrape-jobs.js --site list            # 查看所有可用站点
 *   node scripts/scrape-jobs.js --url "https://..."    # 自定义 URL
 *   node scripts/scrape-jobs.js --keywords "工程师,开发"  # 自定义搜索关键词
 *   node scripts/scrape-jobs.js --pages 3              # 翻页数（默认 3）
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output/scraped-jobs';

// ========= 站点配置 =========
const SITES = {
  // --- 飞书招聘门户（很多 AI 公司使用）---
  minimax: {
    name: 'MiniMax',
    url: 'https://vrfi1sk8a0.jobs.feishu.cn/',
    type: 'feishu',
  },
  zhipu: {
    name: '智谱AI',
    url: 'https://zhipu-ai.jobs.feishu.cn/',
    type: 'feishu',
  },
  baichuan: {
    name: '百川智能',
    url: 'https://cq6qe6bvfr6.jobs.feishu.cn/',
    type: 'feishu',
  },
  lingyiwanwu: {
    name: '零一万物',
    url: 'https://01ai.jobs.feishu.cn/',
    type: 'feishu',
  },

  // --- 大厂官网（各有专用提取器）---
  bytedance: {
    name: '字节跳动',
    url: 'https://jobs.bytedance.com/experienced/position',  // v3: 不带 URL 参数
    type: 'bytedance',
    searchKeyword: '产品经理',  // v3: 用搜索框输入
    locationFilter: '上海',     // v3: 点击筛选
  },
  tencent: {
    name: '腾讯',
    url: 'https://careers.tencent.com/search.html',  // v3: 基础 URL
    type: 'tencent',
    apiPath: '/tencentcareer/api/post/Query',  // v3: API 拦截路径
    apiParams: 'timestamp=0&countryId=&cityId=2156&bgIds=&productId=&categoryId=&parentCategoryId=&attrId=&keyword=产品&pageIndex=0&pageSize=20&language=zh-cn&area=cn',
  },
  bilibili: {
    name: 'B站',
    url: 'https://jobs.bilibili.com/social/positions',
    type: 'bilibili',
    searchKeyword: 'AI',
  },

  // --- 其他公司官网 ---
  stepfun: {
    name: '阶跃星辰',
    url: 'https://www.stepfun.com/company',
    type: 'generic',
  },
  moonshot: {
    name: '月之暗面',
    url: 'https://www.moonshot.cn/jobs',
    type: 'generic',
  },
  mihoyo: {
    name: '米哈游',
    url: 'https://jobs.mihoyo.com/#/social',
    type: 'generic',
  },
  netease: {
    name: '网易',
    url: 'https://hr.163.com/job-list.html?workType=1&lang=zh',
    type: 'generic',
  },
};

const DEFAULT_KEYWORDS = ['产品', 'PM', 'Product', 'AI', 'Agent', 'AIGC', '策略', '运营'];

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] || ''; i++;
    }
  }
  return args;
}

// ========= 工具函数 =========

function isJobDetailUrl(url) {
  if (!url) return false;
  const detailPatterns = [
    /\/position\/\d+/,
    /\/job_detail\//,
    /\/job\/\d+/,
    /\/jobs?\/.+\/\d+/,
    /\/career.*\/\d+/,
    /\/detail/,
    /[?&]id=\d+/,
    /\/positions?\/.+\d{4,}/,
    /[?&]postId=\d+/,
  ];
  return detailPatterns.some(p => p.test(url));
}

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = j.url || j.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ========= 飞书招聘门户专用提取器 =========
// v3 改进：从列表页卡片提取 JD 摘要（详情页有登录墙不渲染 JD）
async function extractFeishu(page, keywords, maxPages) {
  await page.waitForTimeout(5000);

  // 尝试切换到"社会招聘"
  for (const tab of ['社会招聘', '社招', '全部职位']) {
    try {
      const el = page.locator(`text=${tab}`).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        await page.waitForTimeout(3000);
        break;
      }
    } catch(e) {}
  }

  const allJobs = [];
  const searchKeywords = keywords.slice(0, 3);

  for (const kw of searchKeywords) {
    console.log(`  飞书搜索: "${kw}"`);
    try {
      const searchInput = page.locator(
        'input[placeholder*="搜索"], input[placeholder*="search"], input[type="search"]'
      ).first();
      if (await searchInput.isVisible({ timeout: 2000 })) {
        await searchInput.click();
        await searchInput.fill('');
        await searchInput.fill(kw);
        await searchInput.press('Enter');
        await page.waitForTimeout(4000);
      }
    } catch(e) {}

    for (let p = 0; p < maxPages; p++) {
      const jobs = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('a[href*="/position/"]').forEach(a => {
          const href = a.href;
          if (!href.includes('/detail') && !href.match(/\/position\/\d+/)) return;

          // v3: 获取整个卡片的完整文本作为 JD 摘要
          const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
          const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');

          const titleMatch = fullText.match(/^(.+?)(?:北京|上海|深圳|杭州|广州|成都|旧金山|伦敦|远程|社招|校招|实习)/);
          const title = titleMatch ? titleMatch[1].trim() : (a.textContent || '').trim().split(/\s/)[0];

          const locationMatch = fullText.match(/((?:北京|上海|深圳|杭州|广州|成都|旧金山|远程)(?:、(?:北京|上海|深圳|杭州|广州|成都|旧金山|远程))*)/);
          const location = locationMatch ? locationMatch[1] : '';

          const categoryMatch = fullText.match(/(社招全职|社招实习|校招|实习)/);
          const jobType = categoryMatch ? categoryMatch[1] : '';

          if (title && title.length > 2 && title.length < 80) {
            results.push({
              title,
              url: href,
              location,
              jobType,
              jdSummary: fullText.slice(0, 1000),  // v3: 保存列表页的 JD 摘要
            });
          }
        });
        return results;
      });

      allJobs.push(...jobs);
      console.log(`    第 ${p + 1} 页: ${jobs.length} 条`);
      if (jobs.length === 0) break;

      try {
        const nextBtn = page.locator('button:has-text("下一页"), [class*="next"], [aria-label="next"]').first();
        if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
          await nextBtn.click();
          await page.waitForTimeout(3000);
        } else break;
      } catch(e) { break; }
    }
  }

  return deduplicateJobs(allJobs);
}

// ========= 字节跳动专用提取器 =========
// v3 改进：搜索框交互代替 URL 参数（URL 参数已失效）
async function extractBytedance(page, site, maxPages) {
  await page.waitForTimeout(5000);

  // v3: 搜索框交互
  const searchKeyword = site.searchKeyword || '产品经理';
  const locationFilter = site.locationFilter || '上海';

  console.log(`  搜索框输入: "${searchKeyword}"`);
  try {
    const searchInput = await page.$('input[type="text"]');
    if (searchInput) {
      await searchInput.click();
      await searchInput.fill(searchKeyword);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    }
  } catch(e) {
    console.log(`  搜索框交互失败: ${e.message}`);
  }

  // v3: 点击地区筛选
  console.log(`  点击筛选: "${locationFilter}"`);
  try {
    const filterBtn = await page.$(`text=${locationFilter}`);
    if (filterBtn) {
      await filterBtn.click();
      await page.waitForTimeout(3000);
    }
  } catch(e) {}

  // 等待岗位列表加载
  try {
    await page.waitForSelector('a[href*="/position/"]', { timeout: 10000 });
  } catch(e) {
    console.log('  未找到岗位链接，尝试截图诊断...');
  }

  const allJobs = [];

  for (let p = 0; p < maxPages; p++) {
    const jobs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href*="/position/"]').forEach(a => {
        const href = a.href;
        if (href.includes('/page-') || href.includes('/position?')) return;
        if (!/\/position\/\d+/.test(href)) return;

        const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');

        const title = linkText.length > 2 && linkText.length < 100
          ? linkText : fullText.slice(0, 80);
        const locationMatch = fullText.match(/(上海|北京|深圳|杭州|广州|成都)/);

        if (title && title.length > 2) {
          results.push({
            title,
            url: href,
            location: locationMatch ? locationMatch[1] : '',
          });
        }
      });
      return results;
    });

    allJobs.push(...jobs);
    console.log(`  第 ${p + 1} 页: ${jobs.length} 条`);
    if (jobs.length === 0) break;

    try {
      const nextBtn = page.locator('[class*="next"], button:has-text("下一页"), [aria-label*="next"]').first();
      if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else break;
    } catch(e) { break; }
  }

  return deduplicateJobs(allJobs);
}

// ========= 腾讯专用提取器 =========
// v3 改进：API 响应拦截，获取结构化 JSON 数据
async function extractTencent(page, site) {
  const capturedJobs = [];

  // v3: 注册 API 响应拦截器
  const apiPath = site.apiPath || '/tencentcareer/api/post/Query';
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes(apiPath)) return;

    try {
      const json = await response.json();
      const posts = json?.Data?.Posts || [];
      for (const post of posts) {
        capturedJobs.push({
          title: post.PostName || post.RecruitPostName || '',
          url: `https://careers.tencent.com/jobdesc.html?postId=${post.PostId}`,
          location: post.LocationName || '',
          department: post.CategoryName || '',
          lastUpdate: post.LastUpdateTime || '',
          bgName: post.BGName || '',
          source: 'api-intercept',
        });
      }
      console.log(`  API 拦截到 ${posts.length} 条岗位`);
    } catch (e) {
      // 非 JSON 响应，跳过
    }
  });

  // 导航到腾讯招聘页面，触发 API 调用
  const urlWithParams = site.apiParams
    ? `${site.url}?pcid=40001&locationId=2156`
    : site.url;

  await page.goto(urlWithParams, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(8000);

  // 如果 API 拦截已获取数据，直接返回
  if (capturedJobs.length > 0) {
    return deduplicateJobs(capturedJobs);
  }

  // fallback: 主动调用 API（同源 fetch）
  console.log('  API 拦截未触发，尝试主动调用...');
  try {
    const apiParams = site.apiParams || 'timestamp=0&countryId=&cityId=2156&bgIds=&productId=&categoryId=&parentCategoryId=&attrId=&keyword=产品&pageIndex=0&pageSize=20&language=zh-cn&area=cn';
    const data = await page.evaluate(async (params) => {
      const res = await fetch(`/tencentcareer/api/post/Query?${params}`);
      return res.json();
    }, apiParams);

    const posts = data?.Data?.Posts || [];
    for (const post of posts) {
      capturedJobs.push({
        title: post.PostName || post.RecruitPostName || '',
        url: `https://careers.tencent.com/jobdesc.html?postId=${post.PostId}`,
        location: post.LocationName || '',
        department: post.CategoryName || '',
        lastUpdate: post.LastUpdateTime || '',
        source: 'api-fetch',
      });
    }
    console.log(`  API fetch 获取 ${posts.length} 条岗位`);
  } catch (e) {
    console.log(`  API fetch 失败: ${e.message}`);
  }

  // 如果 API 都没数据，fallback 到 DOM 提取
  if (capturedJobs.length === 0) {
    console.log('  fallback 到 DOM 提取...');
    return await extractTencentDOM(page);
  }

  return deduplicateJobs(capturedJobs);
}

// 腾讯 DOM 提取 fallback
async function extractTencentDOM(page) {
  const jobs = await page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll('[class*="recruit-list"] > div, [class*="job-item"], [class*="position-item"]');

    if (cards.length > 0) {
      cards.forEach(card => {
        const text = (card.textContent || '').trim();
        const link = card.querySelector('a');
        const href = link ? link.href : '';
        const titleEl = card.querySelector('h4, h3, [class*="title"], [class*="name"]');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const locationMatch = text.match(/(上海|北京|深圳|杭州|广州|成都|西安)/);

        if (title && title.length > 4 && title.length < 100) {
          results.push({
            title,
            url: href,
            location: locationMatch ? locationMatch[1] : '',
            source: 'dom',
          });
        }
      });
    }
    return results;
  });

  return deduplicateJobs(jobs);
}

// ========= B站专用提取器 =========
// v3 新增：B站需要 domcontentloaded + 超长等待，搜索框交互
async function extractBilibili(page, site) {
  // B站特殊：初始加载需要 10-15 秒
  console.log('  等待 B站 SPA 渲染（15s）...');
  await page.waitForTimeout(15000);

  // v3: 搜索框交互
  const searchKeyword = site.searchKeyword || 'AI';
  console.log(`  搜索: "${searchKeyword}"`);
  try {
    const searchInput = await page.$('input[placeholder*="搜索"], input[type="text"]');
    if (searchInput) {
      await searchInput.click();
      await searchInput.fill(searchKeyword);
      const searchBtn = await page.$('button:has-text("搜索")');
      if (searchBtn) await searchBtn.click();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(8000);  // B站搜索后也需要很长时间
    }
  } catch(e) {
    console.log(`  搜索框交互失败: ${e.message}`);
  }

  // 提取岗位
  const jobs = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // 策略 1: 找 <a> 标签指向 positions 页面的链接
    document.querySelectorAll('a[href*="positions"]').forEach(a => {
      const href = a.href;
      if (seen.has(href)) return;
      seen.add(href);

      const card = a.closest('[class*="item"], [class*="card"], li') || a;
      const text = (card.textContent || '').trim().replace(/\s+/g, ' ');
      const linkText = (a.textContent || '').trim();

      if (linkText.length > 2 && linkText.length < 100) {
        results.push({
          title: linkText,
          url: href,
          fullText: text.slice(0, 500),
        });
      }
    });

    // 策略 2: SPA 卡片（可能没有 <a> 标签）
    if (results.length === 0) {
      const cardSelectors = [
        '[class*="position-item"]', '[class*="job-card"]',
        '[class*="job-item"]', '[class*="recruit"] li',
      ];
      for (const sel of cardSelectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length === 0) continue;

        cards.forEach(card => {
          const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
          const title = titleEl ? titleEl.textContent.trim() : '';
          const text = (card.textContent || '').trim().replace(/\s+/g, ' ');
          const locationMatch = text.match(/(上海|北京|深圳|杭州|广州|成都)/);

          if (title && title.length > 2 && title.length < 80 && !seen.has(title)) {
            seen.add(title);
            results.push({
              title,
              url: '',
              location: locationMatch ? locationMatch[1] : '',
              fullText: text.slice(0, 500),
              source: 'card-no-url',
            });
          }
        });

        if (results.length > 0) break;
      }
    }

    // 策略 3: 纯文本解析（最后手段）
    if (results.length === 0) {
      const text = document.body?.innerText || '';
      const pmKeywords = ['产品经理', 'AI产品', 'AIGC产品', 'AI战略'];
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pmKeywords.some(k => line.includes(k)) && line.length < 80) {
          const locationLine = lines[i + 1] || '';
          const locationMatch = locationLine.match(/(上海|北京|深圳|杭州|广州)/);
          if (!seen.has(line)) {
            seen.add(line);
            results.push({
              title: line,
              url: '',
              location: locationMatch ? locationMatch[1] : '',
              source: 'text-parse',
            });
          }
        }
      }
    }

    return results;
  });

  console.log(`  提取到 ${jobs.length} 条岗位`);
  return deduplicateJobs(jobs);
}

// ========= 通用提取器（改进版）=========
async function extractGeneric(page, keywords, maxPages) {
  await page.waitForTimeout(5000);

  const allJobs = [];

  for (let p = 0; p < maxPages; p++) {
    const jobs = await page.evaluate((kws) => {
      const results = [];
      const seen = new Set();

      // 策略 1: 找岗位详情链接
      document.querySelectorAll('a').forEach(a => {
        const href = a.href || '';
        if (!href || seen.has(href)) return;
        if (href.startsWith('javascript:') || href === '#') return;

        const isDetail = /(position|job|career|detail).*\d{4,}/.test(href) ||
                        /\/\d{6,}(\/|$|\.)/.test(href);
        if (!isDetail) return;

        const card = a.closest('[class*="item"], [class*="card"], [class*="row"], li') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');

        let title = '';
        if (linkText.length > 2 && linkText.length < 80) {
          title = linkText;
        } else {
          const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
          title = titleEl ? titleEl.textContent.trim() : fullText.slice(0, 60);
        }

        const locationMatch = fullText.match(/(上海|北京|深圳|杭州|广州|成都|Remote|远程)/);

        if (title && title.length > 2) {
          seen.add(href);
          results.push({
            title,
            url: href,
            location: locationMatch ? locationMatch[1] : '',
          });
        }
      });

      // 策略 2: 岗位卡片（无 <a> 标签的 SPA）
      if (results.length === 0) {
        const cardSelectors = [
          '[class*="job-item"]', '[class*="position-item"]', '[class*="career-item"]',
          '[class*="job-card"]', '[class*="recruit"] li',
        ];
        for (const sel of cardSelectors) {
          const cards = document.querySelectorAll(sel);
          if (cards.length === 0) continue;

          cards.forEach(card => {
            const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
            const locationMatch = fullText.match(/(上海|北京|深圳|杭州|广州|成都|Remote|远程)/);
            const link = card.querySelector('a');

            if (title && title.length > 2 && title.length < 80) {
              const hasKw = kws.length === 0 || kws.some(k => (title + fullText).includes(k));
              if (hasKw && !seen.has(title)) {
                seen.add(title);
                results.push({
                  title,
                  url: link ? link.href : '',
                  location: locationMatch ? locationMatch[1] : '',
                  source: 'card-no-url',
                });
              }
            }
          });

          if (results.length > 0) break;
        }
      }

      return results;
    }, keywords);

    allJobs.push(...jobs);
    console.log(`  第 ${p + 1} 页: ${jobs.length} 条`);
    if (jobs.length === 0) break;

    try {
      const nextBtn = page.locator(
        'button:has-text("下一页"), [class*="next"]:not([class*="disabled"]), [aria-label*="next"], a:has-text(">")'
      ).first();
      if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else break;
    } catch(e) { break; }
  }

  return deduplicateJobs(allJobs);
}

// ========= 分发提取器 =========
async function extractJobs(page, site, keywords, maxPages) {
  switch (site.type) {
    case 'feishu':
      return await extractFeishu(page, keywords, maxPages);
    case 'bytedance':
      return await extractBytedance(page, site, maxPages);
    case 'tencent':
      return await extractTencent(page, site);
    case 'bilibili':
      return await extractBilibili(page, site);
    default:
      return await extractGeneric(page, keywords, maxPages);
  }
}

// ========= 主流程 =========
async function main() {
  const args = parseArgs();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const keywords = args.keywords
    ? args.keywords.split(',').map(k => k.trim())
    : DEFAULT_KEYWORDS;
  const maxPages = parseInt(args.pages) || 3;

  // 站点选择
  let sitesToScrape;
  if (args.site) {
    if (args.site === 'list') {
      console.log('可用站点：');
      Object.entries(SITES).forEach(([k, v]) => console.log(`  --site ${k}  →  ${v.name} (${v.type})`));
      process.exit(0);
    }
    if (!SITES[args.site]) {
      console.error(`未知站点: ${args.site}\n可用: ${Object.keys(SITES).join(', ')}`);
      process.exit(1);
    }
    sitesToScrape = { [args.site]: SITES[args.site] };
  } else if (args.url) {
    sitesToScrape = { custom: { name: '自定义', url: args.url, type: 'generic' } };
  } else {
    sitesToScrape = SITES;
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const allResults = {};

  for (const [key, site] of Object.entries(sitesToScrape)) {
    console.log(`\n=== ${site.name} (${key}) [${site.type}] ===`);
    console.log(`URL: ${site.url}`);

    // v3: 每个站点用独立的 page（避免同源问题）
    const page = await browser.newPage();
    try {
      // v3: B站用 domcontentloaded，其他站点也统一用 domcontentloaded
      await page.goto(site.url, {
        waitUntil: 'domcontentloaded',
        timeout: site.type === 'bilibili' ? 45000 : 30000,
      });

      // 截图
      const initialWait = site.type === 'bilibili' ? 3000 : 3000;
      await page.waitForTimeout(initialWait);
      const screenshotPath = path.join(OUTPUT_DIR, `${key}-screenshot.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`截图: ${screenshotPath}`);

      // 提取岗位
      const jobs = await extractJobs(page, site, keywords, maxPages);
      console.log(`合计: ${jobs.length} 条不重复岗位`);

      const withUrl = jobs.filter(j => j.url).length;
      if (jobs.length > 0) {
        console.log(`其中 ${withUrl} 条有详情 URL (${Math.round(withUrl/jobs.length*100)}%)`);
      }

      allResults[key] = {
        name: site.name,
        url: site.url,
        type: site.type,
        scrapedAt: new Date().toISOString(),
        jobCount: jobs.length,
        jobsWithUrl: withUrl,
        jobs,
      };

      // 保存单站点结果
      const outPath = path.join(OUTPUT_DIR, `${key}-jobs.json`);
      fs.writeFileSync(outPath, JSON.stringify(allResults[key], null, 2), 'utf-8');

    } catch(e) {
      console.log(`错误: ${e.message}`);
      allResults[key] = { name: site.name, url: site.url, jobs: [], error: e.message };
    } finally {
      await page.close();
    }
  }

  // 保存汇总
  const summaryPath = path.join(OUTPUT_DIR, 'all-results-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(allResults, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(50)}`);
  console.log('汇总：');
  let totalJobs = 0;
  let totalWithUrl = 0;
  for (const [key, result] of Object.entries(allResults)) {
    const count = result.jobCount || 0;
    const withUrl = result.jobsWithUrl || 0;
    totalJobs += count;
    totalWithUrl += withUrl;
    console.log(`  ${result.name}: ${count} 条 (${withUrl} 条有URL)`);
  }
  console.log(`总计: ${totalJobs} 条岗位, ${totalWithUrl} 条有详情URL`);
  console.log(`结果已保存: ${summaryPath}`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
