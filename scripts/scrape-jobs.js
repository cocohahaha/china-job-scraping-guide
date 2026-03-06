#!/usr/bin/env node
/**
 * 全自动岗位抓取器 v2 - 精准提取每个岗位的详情链接
 *
 * v1 的问题：通用提取器把导航链接、分类标签、JD 正文碎片都当成了岗位。
 * v2 的改进：
 *   - 为飞书门户、字节跳动、腾讯等主流平台写专用提取器
 *   - 点击岗位卡片获取详情 URL（SPA 不在 DOM 里放 <a> 标签）
 *   - 自动翻页获取更多结果
 *   - URL 模式过滤：只保留岗位详情页 URL，过滤掉导航/分类链接
 *   - 去重：基于 URL 或标题去重，不会重复抓取同一岗位
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
    url: 'https://jobs.bytedance.com/experienced/position?keywords=&category=6704215862603155720&location=CT_51',
    type: 'bytedance',
  },
  tencent: {
    name: '腾讯',
    url: 'https://careers.tencent.com/search.html?pcid=40001&locationId=2156',
    type: 'tencent',
  },
  bilibili: {
    name: 'B站',
    url: 'https://jobs.bilibili.com/social/positions',
    type: 'generic',
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

// 判断 URL 是否像岗位详情页（而非导航/分类页）
function isJobDetailUrl(url) {
  if (!url) return false;
  const detailPatterns = [
    /\/position\/\d+/,           // 飞书门户: /position/7579523111286147366/detail
    /\/job_detail\//,            // Boss直聘
    /\/job\/\d+/,                // 通用
    /\/jobs?\/.+\/\d+/,          // 通用带 ID
    /\/career.*\/\d+/,           // career 页面
    /\/detail/,                  // 详情页
    /[?&]id=\d+/,               // query 参数 ID
    /\/positions?\/.+\d{4,}/,    // 带长数字 ID 的 position 页
  ];
  return detailPatterns.some(p => p.test(url));
}

// 去重：基于 URL 或标题
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
async function extractFeishu(page, keywords, maxPages) {
  // 等待 SPA 渲染
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

  // 逐个关键词搜索（飞书门户搜索框只能输一个词）
  const searchKeywords = keywords.slice(0, 3); // 最多搜 3 个避免太慢

  for (const kw of searchKeywords) {
    console.log(`  飞书搜索: "${kw}"`);
    try {
      // 清空并输入关键词
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
    } catch(e) {
      // 没有搜索框，直接提取当前页面
    }

    // 提取当前页面的岗位卡片
    for (let p = 0; p < maxPages; p++) {
      const jobs = await page.evaluate(() => {
        const results = [];
        // 飞书门户的岗位卡片通常是可点击的 div/a，包含职位链接
        // URL 模式: /index/position/{id}/detail
        document.querySelectorAll('a[href*="/position/"]').forEach(a => {
          const href = a.href;
          if (!href.includes('/detail') && !href.match(/\/position\/\d+/)) return;

          // 获取最近的卡片容器来提取完整信息
          const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
          const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');

          // 提取岗位名（通常是链接文本的第一部分，在城市/类别之前）
          const titleMatch = fullText.match(/^(.+?)(?:北京|上海|深圳|杭州|广州|成都|旧金山|伦敦|远程|社招|校招|实习)/);
          const title = titleMatch ? titleMatch[1].trim() : (a.textContent || '').trim().split(/\s/)[0];

          // 提取城市
          const locationMatch = fullText.match(/((?:北京|上海|深圳|杭州|广州|成都|旧金山|远程)(?:、(?:北京|上海|深圳|杭州|广州|成都|旧金山|远程))*)/);
          const location = locationMatch ? locationMatch[1] : '';

          // 提取类别
          const categoryMatch = fullText.match(/(社招全职|社招实习|校招|实习)/);
          const jobType = categoryMatch ? categoryMatch[1] : '';

          // 提取部门/职能
          const deptMatch = fullText.match(/(产品\s*\/?\s*策划\s*\/?\s*项目|研发|设计|市场|运营|销售|互联网\s*\/?\s*电子\s*\/?\s*网游)/);
          const department = deptMatch ? deptMatch[1].replace(/\s+/g, '') : '';

          if (title && title.length > 2 && title.length < 80) {
            results.push({ title, url: href, location, jobType, department });
          }
        });
        return results;
      });

      allJobs.push(...jobs);
      console.log(`    第 ${p + 1} 页: ${jobs.length} 条`);

      if (jobs.length === 0) break;

      // 尝试翻页
      try {
        const nextBtn = page.locator('button:has-text("下一页"), [class*="next"], [aria-label="next"]').first();
        if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
          await nextBtn.click();
          await page.waitForTimeout(3000);
        } else {
          break;
        }
      } catch(e) { break; }
    }
  }

  return deduplicateJobs(allJobs);
}

// ========= 字节跳动专用提取器 =========
async function extractBytedance(page, maxPages) {
  await page.waitForTimeout(5000);

  const allJobs = [];

  // 字节跳动官网需要等待岗位列表加载（通过检测列表元素出现）
  try {
    await page.waitForSelector('a[href*="/position/"]', { timeout: 10000 });
  } catch(e) {
    // 可能确实没有结果，或者需要手动选筛选条件
    console.log('  提示: 字节跳动官网需要先在左侧选择筛选条件（职位类别 + 工作地点）');
    console.log('  如果显示 0 结果，请在浏览器中手动操作筛选器，然后按回车继续...');
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 5000); // 5s 后自动继续
      process.stdin.once('data', () => { clearTimeout(timeout); resolve(); });
    });
    await page.waitForTimeout(2000);
  }

  for (let p = 0; p < maxPages; p++) {
    const jobs = await page.evaluate(() => {
      const results = [];
      // 字节跳动岗位链接格式: /experienced/position/{id}
      document.querySelectorAll('a[href*="/position/"]').forEach(a => {
        const href = a.href;
        // 过滤掉导航链接（如 "产品与技术" 分类页）
        if (href.includes('/page-') || href.includes('/position?')) return;
        // 必须包含数字 ID
        if (!/\/position\/\d+/.test(href)) return;

        const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');

        // 岗位标题通常是链接文本
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

    // 翻页
    try {
      const nextBtn = page.locator('[class*="next"], button:has-text("下一页"), [aria-label*="next"]').first();
      if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else { break; }
    } catch(e) { break; }
  }

  return deduplicateJobs(allJobs);
}

// ========= 腾讯专用提取器 =========
async function extractTencent(page, maxPages) {
  await page.waitForTimeout(5000);

  const allJobs = [];

  for (let p = 0; p < maxPages; p++) {
    // 腾讯招聘的岗位卡片是 SPA 渲染的，需要点击才跳转
    // 但每个卡片内部有一个"复制链接"按钮，或者可以从点击行为推断 URL
    const jobs = await page.evaluate(() => {
      const results = [];
      // 腾讯岗位卡片通常有标题 + 城市 + 部门 + 经验
      // 页面文本结构: "岗位名\n城市\n部门\n经验\n更新日期\nJD..."
      const cards = document.querySelectorAll('[class*="recruit-list"] > div, [class*="job-item"], [class*="position-item"]');

      if (cards.length > 0) {
        cards.forEach(card => {
          const text = (card.textContent || '').trim();
          const link = card.querySelector('a');
          const href = link ? link.href : '';

          // 尝试从卡片结构中提取字段
          const titleEl = card.querySelector('h4, h3, [class*="title"], [class*="name"]');
          const title = titleEl ? titleEl.textContent.trim() : '';
          const locationMatch = text.match(/(上海|北京|深圳|杭州|广州|成都|西安)/);
          const deptMatch = text.match(/(WXG|IEG|CSIG|TEG|PCG|CDG|[A-Z]{2,4}技术|[A-Z]{2,4}产品)/);
          const expMatch = text.match(/(\d+年以上工作经验|经验不限)/);

          if (title && title.length > 4 && title.length < 100) {
            results.push({
              title,
              url: href,
              location: locationMatch ? locationMatch[1] : '',
              department: deptMatch ? deptMatch[1] : '',
              experience: expMatch ? expMatch[1] : '',
            });
          }
        });
      }

      // 备选：从页面文本结构中解析（腾讯的 DOM 经常变化）
      if (results.length === 0) {
        const text = document.body?.innerText || '';
        // 腾讯岗位列表的文本格式通常是: "岗位名\n城市\n部门..."
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // 岗位名特征：包含中文 + 英文/符号，长度 5-60，后面跟城市名
          if (line.length >= 5 && line.length <= 60) {
            const nextLine = lines[i + 1] || '';
            const isCityNext = /(上海|北京|深圳|杭州|广州|成都|西安)/.test(nextLine);
            const isJobTitle = /[-—·]/.test(line) || // 带分隔符的标题如 "元宝-大模型产品经理"
                              /(产品|工程师|设计师|经理|算法|运营|策略|开发|总监)/.test(line);
            if (isJobTitle && isCityNext) {
              const dept = lines[i + 2] || '';
              const exp = lines[i + 3] || '';
              results.push({
                title: line,
                url: '', // 腾讯 SPA 没有直接 URL，后续需要点击获取
                location: nextLine.match(/(上海|北京|深圳|杭州|广州|成都|西安)/)?.[1] || nextLine,
                department: /^[A-Z]/.test(dept) ? dept : '',
                experience: /经验/.test(exp) ? exp : '',
              });
            }
          }
        }
      }

      return results;
    });

    allJobs.push(...jobs);
    console.log(`  第 ${p + 1} 页: ${jobs.length} 条`);

    if (jobs.length === 0) break;

    // 翻页
    try {
      const nextBtn = page.locator('[class*="next"]:not([class*="disabled"]), button:has-text("下一页")').first();
      if (await nextBtn.isVisible({ timeout: 1000 })) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else { break; }
    } catch(e) { break; }
  }

  // 如果没有 URL，尝试逐个点击岗位卡片获取详情 URL
  const jobsWithoutUrl = allJobs.filter(j => !j.url);
  if (jobsWithoutUrl.length > 0 && allJobs.some(j => j.url)) {
    console.log(`  ${jobsWithoutUrl.length} 条岗位缺少 URL，已有 URL 的会保留`);
  } else if (jobsWithoutUrl.length > 0) {
    console.log(`  尝试点击岗位卡片获取详情 URL...`);
    const cards = await page.$$('[class*="recruit-list"] > div, [class*="job-item"]');
    for (let i = 0; i < Math.min(cards.length, allJobs.length); i++) {
      try {
        await cards[i].click();
        await page.waitForTimeout(1500);
        const detailUrl = page.url();
        if (detailUrl !== allJobs[i].url && isJobDetailUrl(detailUrl)) {
          allJobs[i].url = detailUrl;
        }
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1000);
      } catch(e) { break; }
    }
  }

  return deduplicateJobs(allJobs);
}

// ========= 通用提取器（改进版）=========
async function extractGeneric(page, keywords, maxPages) {
  await page.waitForTimeout(5000);

  const allJobs = [];

  for (let p = 0; p < maxPages; p++) {
    const jobs = await page.evaluate((kws) => {
      const results = [];
      const seen = new Set();

      // 策略 1: 找岗位详情链接（URL 含 position/job/career + 数字ID）
      document.querySelectorAll('a').forEach(a => {
        const href = a.href || '';
        if (!href || seen.has(href)) return;
        if (href.startsWith('javascript:') || href === '#') return;

        // 只要岗位详情页 URL
        const isDetail = /(position|job|career|detail).*\d{4,}/.test(href) ||
                        /\/\d{6,}(\/|$|\.)/.test(href);
        if (!isDetail) return;

        const card = a.closest('[class*="item"], [class*="card"], [class*="row"], li') || a;
        const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
        const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');

        // 岗位名 = 链接文本（如果合理长度），否则从卡片提取
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

      // 策略 2: 岗位列表卡片（可能没有 <a> 标签，SPA 用 click handler）
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

          if (results.length > 0) break; // 找到了就不用试其他 selector
        }
      }

      return results;
    }, keywords);

    allJobs.push(...jobs);
    console.log(`  第 ${p + 1} 页: ${jobs.length} 条`);

    if (jobs.length === 0) break;

    // 翻页
    try {
      const nextBtn = page.locator(
        'button:has-text("下一页"), [class*="next"]:not([class*="disabled"]), [aria-label*="next"], a:has-text(">")'
      ).first();
      if (await nextBtn.isVisible({ timeout: 1000 }) && await nextBtn.isEnabled({ timeout: 1000 })) {
        await nextBtn.click();
        await page.waitForTimeout(3000);
      } else { break; }
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
      return await extractBytedance(page, maxPages);
    case 'tencent':
      return await extractTencent(page, maxPages);
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

  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });

  const allResults = {};

  for (const [key, site] of Object.entries(sitesToScrape)) {
    console.log(`\n=== ${site.name} (${key}) [${site.type}] ===`);
    console.log(`URL: ${site.url}`);

    const page = await context.newPage();
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 截图
      await page.waitForTimeout(3000);
      const screenshotPath = path.join(OUTPUT_DIR, `${key}-screenshot.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`截图: ${screenshotPath}`);

      // 提取岗位
      const jobs = await extractJobs(page, site, keywords, maxPages);
      console.log(`合计: ${jobs.length} 条不重复岗位`);

      // 统计有 URL 的比例
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

  await context.close();
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
