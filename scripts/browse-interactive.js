#!/usr/bin/env node
/**
 * 交互式浏览器 - 打开公司招聘页面，用网站自带筛选器浏览
 *
 * 适合不需要全自动化、只想快速浏览多个公司岗位的场景。
 * 会自动截图和提取页面链接，浏览完按回车关闭。
 *
 * 用法：
 *   node scripts/browse-interactive.js --site bytedance
 *   node scripts/browse-interactive.js --site list       # 查看所有站点
 *   node scripts/browse-interactive.js --url "https://..." # 自定义 URL
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

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

const SITES = {
  bytedance: {
    name: '字节跳动',
    urls: ['https://jobs.bytedance.com/experienced/position?category=6704215862603155720&location=CT_51'],
  },
  alibaba: {
    name: '阿里巴巴',
    urls: ['https://talent.alibaba.com/off-campus/position-list?lang=zh'],
  },
  tencent: {
    name: '腾讯',
    urls: ['https://careers.tencent.com/search.html?pcid=40001&locationId=2156'],
  },
  minimax: {
    name: 'MiniMax',
    urls: ['https://vrfi1sk8a0.jobs.feishu.cn/'],
  },
  moonshot: {
    name: '月之暗面',
    urls: ['https://www.moonshot.cn/jobs'],
  },
  zhipu: {
    name: '智谱AI',
    urls: ['https://zhipu-ai.jobs.feishu.cn/'],
  },
  stepfun: {
    name: '阶跃星辰',
    urls: ['https://www.stepfun.com/careers'],
  },
  baichuan: {
    name: '百川智能',
    urls: ['https://cq6qe6bvfr6.jobs.feishu.cn/'],
  },
  mihoyo: {
    name: '米哈游',
    urls: ['https://jobs.mihoyo.com/#/social'],
  },
  bilibili: {
    name: 'B站',
    urls: ['https://jobs.bilibili.com/social/positions'],
  },
  netease: {
    name: '网易',
    urls: ['https://hr.163.com/job-list.html?workType=1&lang=zh'],
  },
  boss: {
    name: 'Boss直聘（需登录）',
    urls: ['https://www.zhipin.com/shanghai/'],
  },
};

async function main() {
  const args = parseArgs();
  const siteKey = args.site;
  const directUrl = args.url;
  const screenshotDir = args['screenshot-dir'] || 'output/browse-screenshots';

  let targetUrls, siteName;

  if (directUrl) {
    targetUrls = [directUrl];
    siteName = '自定义';
  } else if (siteKey === 'list') {
    console.log('可用站点：');
    Object.entries(SITES).forEach(([k, v]) => console.log(`  --site ${k}  →  ${v.name}`));
    process.exit(0);
  } else if (siteKey && SITES[siteKey]) {
    targetUrls = SITES[siteKey].urls;
    siteName = SITES[siteKey].name;
  } else {
    console.error('用法: node browse-interactive.js --site <站点名> 或 --site list');
    process.exit(1);
  }

  console.log(`\n=== 浏览 ${siteName} 招聘页面 ===\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });

  try {
    for (let i = 0; i < targetUrls.length; i++) {
      const url = targetUrls[i];
      console.log(`[${i + 1}/${targetUrls.length}] 打开: ${url}`);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);

      // 截图
      fs.mkdirSync(screenshotDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ssPath = path.join(screenshotDir, `${siteKey || 'custom'}-${i + 1}-${ts}.png`);
      await page.screenshot({ path: ssPath, fullPage: false });
      console.log(`截图: ${ssPath}`);

      // 提取所有链接
      const links = await page.evaluate(() => {
        const results = [];
        const seen = new Set();
        document.querySelectorAll('a').forEach(a => {
          const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
          const href = a.href;
          if (!href || seen.has(href) || text.length < 2 || text.length > 150) return;
          if (href.startsWith('javascript:') || href === '#') return;
          seen.add(href);
          results.push({ title: text.slice(0, 120), url: href });
        });
        return results;
      });

      const linksPath = path.join(screenshotDir, `${siteKey || 'custom'}-${i + 1}-links.json`);
      fs.writeFileSync(linksPath, JSON.stringify(links, null, 2), 'utf-8');
      console.log(`提取 ${links.length} 个链接 → ${linksPath}`);
    }

    console.log('\n========================================');
    console.log('浏览器已打开。请：');
    console.log('  1. 使用网站自带的筛选器（地区、职能等）');
    console.log('  2. 浏览感兴趣的岗位');
    console.log('  3. 完成后回到终端按回车关闭');
    console.log('========================================');

    await new Promise(resolve => process.stdin.once('data', resolve));
  } finally {
    await browser.close();
  }
}

main();
