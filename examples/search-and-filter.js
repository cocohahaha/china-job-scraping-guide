#!/usr/bin/env node
/**
 * 搜索框交互 + 筛选器点击
 *
 * 中国网站的 URL 参数经常失效（category ID、location code 随版本变化）。
 * 更可靠的方式是模拟用户操作：在搜索框中输入关键词，然后点击筛选条件。
 *
 * 本例演示抓取字节跳动招聘页面。
 */

const { ChinaScraper } = require('../');

async function main() {
  const scraper = new ChinaScraper();

  try {
    // 方式 1：使用预设（一行搞定）
    console.log('=== 使用预设 ===');
    const jobs = await scraper.scrape('bytedance');
    console.log(`字节跳动: ${jobs.length} 条岗位`);
    jobs.forEach((j, i) => console.log(`  ${i + 1}. ${j.title} [${j.location}]`));

    // 方式 2：自定义搜索词和筛选（覆盖预设）
    console.log('\n=== 自定义搜索 ===');
    const devJobs = await scraper.scrape('bytedance', {
      search: { text: '前端工程师' },
      click: ['北京'],
    });
    console.log(`前端工程师(北京): ${devJobs.length} 条`);

    // 方式 3：纯手动配置（不用预设）
    console.log('\n=== 手动配置 ===');
    const customJobs = await scraper.scrape({
      url: 'https://jobs.bytedance.com/experienced/position',
      wait: 5000,
      search: { text: '数据分析', waitAfter: 5000 },
      click: ['上海'],
    });
    console.log(`数据分析(上海): ${customJobs.length} 条`);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
