#!/usr/bin/env node
/**
 * 全自动岗位抓取器 - Playwright 渲染 SPA 页面并提取岗位列表
 *
 * 支持：飞书招聘门户、公司官网、通用招聘页面
 *
 * 用法：
 *   node scripts/scrape-jobs.js                    # 抓取所有预设站点
 *   node scripts/scrape-jobs.js --site minimax      # 抓取单个站点
 *   node scripts/scrape-jobs.js --url "https://..."  # 自定义URL
 *   node scripts/scrape-jobs.js --keywords "工程师,开发"  # 自定义关键词
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output/scraped-jobs';

// ========= 站点配置 =========
// 可根据自己的目标公司修改
const SITES = {
  // 飞书招聘门户（很多 AI 公司使用）
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

  // 公司官网
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
  bytedance: {
    name: '字节跳动',
    // 通过 URL 参数筛选：产品类 + 上海
    url: 'https://jobs.bytedance.com/experienced/position?keywords=&category=6704215862603155720&location=CT_51',
    type: 'generic',
  },
  tencent: {
    name: '腾讯',
    // pcid=40001 产品类, locationId=2156 上海
    url: 'https://careers.tencent.com/search.html?pcid=40001&locationId=2156',
    type: 'generic',
  },
  bilibili: {
    name: 'B站',
    url: 'https://jobs.bilibili.com/social/positions',
    type: 'generic',
  },
  netease: {
    name: '网易',
    url: 'https://hr.163.com/job-list.html?workType=1&lang=zh',
    type: 'generic',
  },
};

// ========= 搜索关键词（可自定义） =========
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

// ========= 通用岗位提取器 =========
async function extractJobsGeneric(page, keywords) {
  return await page.evaluate((kws) => {
    const jobs = [];
    const seen = new Set();

    // 策略 1: 查找包含关键词的链接
    document.querySelectorAll('a').forEach(a => {
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      const href = a.href;
      if (!href || seen.has(href) || text.length < 4 || text.length > 200) return;
      if (href.startsWith('javascript:') || href === '#') return;

      const hasKeyword = kws.some(k => text.includes(k));
      if (hasKeyword) {
        seen.add(href);
        jobs.push({ title: text.slice(0, 150), url: href, source: 'link' });
      }
    });

    // 策略 2: 查找卡片/列表元素中的岗位
    const cardSelectors = [
      '[class*="job"]', '[class*="position"]', '[class*="career"]',
      '[class*="list-item"]', '[class*="card"]', '[class*="post"]',
      'li[class]', 'tr[class]',
    ];
    cardSelectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
          if (text.length < 10 || text.length > 500) return;
          const hasKeyword = kws.some(k => text.includes(k));
          if (!hasKeyword) return;

          const link = el.querySelector('a');
          const href = link ? link.href : '';
          const key = href || text.slice(0, 60);
          if (seen.has(key)) return;
          seen.add(key);

          const locationMatch = text.match(/(上海|北京|深圳|杭州|广州|成都|Remote|远程)/);
          jobs.push({
            title: text.slice(0, 200),
            url: href,
            location: locationMatch ? locationMatch[1] : '',
            source: 'card',
          });
        });
      } catch(e) {}
    });

    return jobs;
  }, keywords);
}

// ========= 飞书招聘门户专用提取器 =========
async function extractJobsFeishu(page, keywords) {
  // 飞书门户的 API 数据加载较慢
  await page.waitForTimeout(5000);

  // 尝试切换到"社会招聘"
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

  // 尝试在搜索框输入第一个关键词
  try {
    const searchInput = await page.locator(
      'input[placeholder*="搜索"], input[placeholder*="search"], input[type="search"]'
    ).first();
    if (await searchInput.isVisible({ timeout: 2000 })) {
      await searchInput.fill(keywords[0] || '产品');
      await searchInput.press('Enter');
      await page.waitForTimeout(3000);
    }
  } catch(e) {}

  return await extractJobsGeneric(page, keywords);
}

// ========= 主流程 =========
async function main() {
  const args = parseArgs();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const keywords = args.keywords
    ? args.keywords.split(',').map(k => k.trim())
    : DEFAULT_KEYWORDS;

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const allResults = {};

  // 确定要抓取的站点
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

  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });

  for (const [key, site] of Object.entries(sitesToScrape)) {
    console.log(`\n--- ${site.name} (${key}) ---`);
    console.log(`URL: ${site.url}`);

    const page = await context.newPage();
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      // 截图
      const screenshotPath = path.join(OUTPUT_DIR, `${key}-screenshot.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`截图: ${screenshotPath}`);

      // 提取岗位
      let jobs;
      if (site.type === 'feishu') {
        jobs = await extractJobsFeishu(page, keywords);
      } else {
        jobs = await extractJobsGeneric(page, keywords);
      }

      console.log(`提取 ${jobs.length} 条相关结果`);

      // 获取页面文本用于调试
      const pageText = await page.evaluate(() => {
        return document.body ? document.body.innerText.slice(0, 5000) : '';
      });

      allResults[key] = {
        name: site.name,
        url: site.url,
        scrapedAt: new Date().toISOString(),
        jobCount: jobs.length,
        jobs,
        pageTextPreview: pageText.slice(0, 2000),
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

  console.log(`\n=== 汇总 ===`);
  let totalJobs = 0;
  for (const [key, result] of Object.entries(allResults)) {
    const count = result.jobs ? result.jobs.length : 0;
    totalJobs += count;
    console.log(`  ${result.name}: ${count} 条`);
  }
  console.log(`总计: ${totalJobs} 条相关岗位`);
  console.log(`结果已保存: ${summaryPath}`);

  await context.close();
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
