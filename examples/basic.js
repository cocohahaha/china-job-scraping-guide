#!/usr/bin/env node
/**
 * 最简示例：自动提取页面上的链接和卡片
 *
 * 不需要任何配置，ChinaScraper 会自动识别详情页链接和列表卡片。
 * 适合大多数结构清晰的中国网站。
 */

const { ChinaScraper } = require('../');

async function main() {
  const scraper = new ChinaScraper({ screenshotDir: 'output/screenshots' });

  try {
    // 自动提取：ChinaScraper 会找到所有像"详情页"的链接
    const items = await scraper.scrape('https://hr.163.com/job-list.html?workType=1&lang=zh', {
      wait: 5000,
    });

    console.log(`提取到 ${items.length} 条数据：`);
    items.slice(0, 10).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title}`);
      if (item.url) console.log(`     ${item.url}`);
    });
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
