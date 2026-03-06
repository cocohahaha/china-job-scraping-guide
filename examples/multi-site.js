#!/usr/bin/env node
/**
 * 批量抓取多个站点
 *
 * 遍历所有预设站点，逐个抓取数据并汇总。
 * 每个站点使用独立的 page（避免同源问题），失败不影响其他站点。
 */

const { ChinaScraper, presets } = require('../');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = 'output/multi-site';

async function main() {
  // 选择要抓取的站点（排除需要 CDP 的 boss）
  const siteKeys = process.argv[2]
    ? process.argv[2].split(',')
    : Object.keys(presets).filter(k => k !== 'boss');

  console.log(`将抓取 ${siteKeys.length} 个站点: ${siteKeys.join(', ')}\n`);

  const scraper = new ChinaScraper({ screenshotDir: path.join(OUTPUT_DIR, 'screenshots') });
  const allResults = {};

  try {
    for (const key of siteKeys) {
      const preset = presets[key];
      if (!preset) {
        console.log(`[跳过] 未知预设: ${key}`);
        continue;
      }

      console.log(`=== ${preset.name} (${key}) ===`);
      try {
        const items = await scraper.scrape(key);
        allResults[key] = {
          name: preset.name,
          url: preset.url,
          scrapedAt: new Date().toISOString(),
          count: items.length,
          items,
        };
        console.log(`  ${items.length} 条数据`);
        items.slice(0, 3).forEach(item => console.log(`  · ${item.title}`));
        if (items.length > 3) console.log(`  ...还有 ${items.length - 3} 条`);
      } catch (e) {
        console.log(`  [错误] ${e.message}`);
        allResults[key] = { name: preset.name, error: e.message, items: [] };
      }
      console.log();
    }
  } finally {
    await scraper.close();
  }

  // 保存汇总
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), 'utf-8');

  // 打印汇总
  console.log('='.repeat(50));
  console.log('汇总：');
  let total = 0;
  for (const [key, result] of Object.entries(allResults)) {
    const count = result.count || 0;
    total += count;
    console.log(`  ${result.name}: ${count} 条${result.error ? ' (失败)' : ''}`);
  }
  console.log(`总计: ${total} 条`);
  console.log(`保存到: ${outPath}`);
}

main().catch(console.error);
