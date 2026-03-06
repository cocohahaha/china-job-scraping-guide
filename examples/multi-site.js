#!/usr/bin/env node
/**
 * 批量抓取多个站点（需要 Playwright）
 *
 * 用法：
 *   node examples/multi-site.js                        # 全部站点
 *   node examples/multi-site.js bytedance,tencent      # 指定站点
 */

const { ScrapeCN, presets } = require('../');
const fs = require('fs');

const OUTPUT = 'output/multi-site/results.json';

async function main() {
  const keys = process.argv[2]
    ? process.argv[2].split(',')
    : Object.keys(presets).filter(k => k !== 'boss');

  console.log(`抓取 ${keys.length} 个站点: ${keys.join(', ')}\n`);

  const scraper = new ScrapeCN({ screenshotDir: 'output/multi-site/screenshots' });
  const all = {};

  try {
    for (const key of keys) {
      if (!presets[key]) { console.log(`[跳过] ${key}`); continue; }
      console.log(`=== ${presets[key].name} ===`);
      try {
        const items = await scraper.scrape(key);
        all[key] = { name: presets[key].name, count: items.length, items, scrapedAt: new Date().toISOString() };
        console.log(`  ${items.length} 条`);
        items.slice(0, 3).forEach(i => console.log(`  · ${i.title}`));
      } catch (e) {
        console.log(`  错误: ${e.message}`);
        all[key] = { name: presets[key].name, error: e.message };
      }
      console.log();
    }
  } finally {
    await scraper.close();
  }

  fs.mkdirSync('output/multi-site', { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(all, null, 2), 'utf-8');

  const total = Object.values(all).reduce((s, r) => s + (r.count || 0), 0);
  console.log(`总计: ${total} 条 → ${OUTPUT}`);
}

main().catch(console.error);
