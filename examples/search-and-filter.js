#!/usr/bin/env node
/**
 * 搜索框交互 + 筛选器点击（需要 Playwright）
 *
 * 中国网站的 URL 参数经常失效（ID 随版本变），搜索框交互更可靠。
 */

const { ScrapeCN } = require('../');

async function main() {
  const scraper = new ScrapeCN();

  try {
    // 使用预设
    console.log('=== 字节跳动（预设）===');
    const jobs = await scraper.scrape('bytedance');
    console.log(`${jobs.length} 条岗位`);
    jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j.title} [${j.location}]`));

    // 覆盖搜索词 + 筛选
    console.log('\n=== 自定义搜索 ===');
    const devJobs = await scraper.scrape('bytedance', {
      search: { text: '前端工程师' },
      click: ['北京'],
    });
    console.log(`前端工程师(北京): ${devJobs.length} 条`);

    // 纯手动配置
    console.log('\n=== 手动配置 ===');
    const custom = await scraper.scrape({
      url: 'https://jobs.bytedance.com/experienced/position',
      wait: 5000,
      search: { text: '数据分析', waitAfter: 5000 },
      click: ['上海'],
    });
    console.log(`数据分析(上海): ${custom.length} 条`);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
