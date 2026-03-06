#!/usr/bin/env node
/**
 * Boss直聘 CDP 模式抓取器
 *
 * 原理：以调试模式启动用户的真实 Chrome，通过 CDP 协议连接控制。
 * Boss直聘的反自动化检测完全无效，因为浏览器就是用户的真实 Chrome。
 *
 * 适用平台：macOS（需要本机安装 Chrome）
 *
 * 用法：
 *   node scripts/boss-cdp.js
 *   node scripts/boss-cdp.js --keywords "前端工程师,React开发"
 *   node scripts/boss-cdp.js --city 101020100  # 上海
 *
 * 城市代码：
 *   上海: 101020100  北京: 101010100  深圳: 101280100
 *   杭州: 101210100  广州: 101280100  成都: 101270100
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output/boss-jobs';
const CDP_PORT = 9222;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function main() {
  const args = parseArgs();
  const city = args.city || '101020100'; // 默认上海
  const searchTerms = args.keywords
    ? args.keywords.split(',').map(k => k.trim())
    : ['AI产品经理', 'AIGC产品经理', 'AI Agent产品', '大模型产品经理'];

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log('=== Boss直聘 CDP 自动抓取 ===\n');

  // Step 1: 关闭现有 Chrome
  console.log('Step 1: 关闭现有 Chrome...');
  try {
    execSync('osascript -e \'tell application "Google Chrome" to quit\' 2>/dev/null || true');
    await sleep(3000);
    execSync('pkill -f "Google Chrome" 2>/dev/null || true');
    await sleep(2000);
  } catch (e) {}
  console.log('  Chrome 已关闭\n');

  // Step 2: 以调试模式重启 Chrome（保留用户 profile）
  console.log('Step 2: 以调试模式重启 Chrome...');
  const userDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome`;

  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    `--user-data-dir=${userDataDir}`,
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  // 等待调试端口就绪
  let connected = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    try {
      const resp = execSync(`curl -s http://localhost:${CDP_PORT}/json/version 2>/dev/null`).toString();
      if (resp.includes('Browser')) { connected = true; break; }
    } catch (e) {}
  }
  if (!connected) {
    console.error('Chrome 启动超时。请确认 Chrome 已安装。');
    process.exit(1);
  }
  console.log('  调试端口已就绪\n');

  // Step 3: 通过 CDP 连接
  console.log('Step 3: 通过 CDP 连接...');
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    console.log('  连接成功！\n');
  } catch (e) {
    console.error(`连接失败: ${e.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const page = await context.newPage();

  // Step 4: 打开 Boss 直聘并检查登录状态
  console.log('Step 4: 检查登录状态...');
  try {
    await page.goto('https://www.zhipin.com/shanghai/', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
  } catch (e) { console.log('  页面加载超时，继续...'); }
  await sleep(5000);

  const state = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return {
      title: document.title,
      hasLogin: text.includes('登录'),
      hasJobs: text.includes('职位') || text.includes('岗位'),
      textLen: text.length,
    };
  });

  if (state.hasLogin && !state.hasJobs) {
    console.log('\n  需要登录。请在 Chrome 窗口中完成登录（扫码/验证码）...');
    console.log('  等待最多 2 分钟...\n');
    try {
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return text.includes('个人中心') || text.includes('我的') ||
               document.querySelector('[class*="avatar"]') !== null;
      }, { timeout: 120000 });
      console.log('  登录成功！\n');
    } catch (e) {
      console.log('  登录等待超时，继续尝试...\n');
    }
  } else {
    console.log('  已登录或不需要登录\n');
  }

  // Step 5: 搜索岗位
  console.log('Step 5: 搜索岗位...\n');

  const allJobs = [];
  const seenKeys = new Set();

  for (const term of searchTerms) {
    console.log(`搜索: "${term}"`);
    try {
      const url = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(term)}&city=${city}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(5000);

      // 截图
      const ssPath = path.join(OUTPUT_DIR, `search-${term.replace(/\s+/g, '_')}.png`);
      await page.screenshot({ path: ssPath });

      // 提取岗位（多选择器 fallback）
      const jobs = await page.evaluate(() => {
        const results = [];
        const selectors = [
          '.job-card-wrapper',
          '.search-job-result .job-card-body',
          '[class*="job-card"]',
          '.job-list li',
          '.job-list-box .job-card-left',
        ];

        let cards = [];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > cards.length) cards = Array.from(found);
        }

        // 宽泛 fallback
        if (cards.length === 0) {
          document.querySelectorAll('a[href*="job_detail"]').forEach(a => {
            const parent = a.closest('li, div[class], article');
            if (parent && !cards.includes(parent)) cards.push(parent);
          });
        }

        cards.forEach(card => {
          const text = card.innerText || '';
          const linkEl = card.querySelector('a[href*="job_detail"]') || card.querySelector('a');
          const title = (card.querySelector('.job-name, [class*="job-name"]')?.textContent || '').trim();
          const company = (card.querySelector('.company-name, [class*="company-name"]')?.textContent || '').trim();
          const salary = (card.querySelector('.salary, [class*="salary"]')?.textContent || '').trim();
          const location = (card.querySelector('.job-area, [class*="job-area"]')?.textContent || '').trim();
          const tags = Array.from(card.querySelectorAll('.tag-list li, [class*="tag"]'))
            .map(t => t.textContent.trim()).filter(Boolean).join(', ');

          if (title || text.length > 30) {
            results.push({
              title: title || text.slice(0, 100).replace(/\n/g, ' '),
              company, salary, location, tags,
              url: linkEl?.href || '',
            });
          }
        });
        return results;
      });

      const newJobs = jobs.filter(j => {
        const key = j.url || (j.title + j.company);
        if (!key || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      console.log(`  找到 ${jobs.length} 条（新增 ${newJobs.length} 条）`);
      allJobs.push(...newJobs.map(j => ({ ...j, searchTerm: term })));

      await sleep(2000 + Math.random() * 1000); // 随机间隔防触发频率限制
    } catch (e) {
      console.log(`  搜索失败: ${e.message}`);
    }
  }

  // 保存结果
  const outPath = path.join(OUTPUT_DIR, 'boss-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(allJobs, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`共找到 ${allJobs.length} 个岗位`);
  console.log(`保存到: ${outPath}`);

  if (allJobs.length > 0) {
    console.log('\n岗位列表：');
    allJobs.forEach((j, i) => {
      console.log(`  ${i + 1}. [${j.company}] ${j.title} | ${j.salary} | ${j.location}`);
    });
  }

  // 断开 CDP 连接但不关闭 Chrome
  await browser.close();
  console.log('\nChrome 保持运行，你可以继续使用。');
}

main().catch(e => { console.error(e); process.exit(1); });
