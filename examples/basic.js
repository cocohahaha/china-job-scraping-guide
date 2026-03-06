#!/usr/bin/env node
/**
 * 基础示例：3 种抓取方式
 */

const { ScrapeCN } = require('../');

async function main() {
  // ===== 方式 1: HTTP fetch（零依赖，不需要 Playwright）=====
  console.log('=== HTTP fetch ===');
  const { links, jsonLD, inlineData } = await ScrapeCN.fetch(
    'https://hr.163.com/job-list.html?workType=1&lang=zh'
  );
  console.log(`链接: ${links.length} 条, JSON-LD: ${jsonLD.length} 个, 内联数据: ${inlineData ? '有' : '无'}`);
  links.slice(0, 3).forEach(l => console.log(`  · ${l.title}`));

  // ===== 方式 2: Playwright 渲染（SPA 页面）=====
  console.log('\n=== Playwright 渲染 ===');
  const scraper = new ScrapeCN();
  try {
    const items = await scraper.scrape('https://hr.163.com/job-list.html?workType=1&lang=zh');
    console.log(`提取: ${items.length} 条`);
    items.slice(0, 3).forEach(item => console.log(`  · ${item.title}`));
  } finally {
    await scraper.close();
  }

  // ===== 方式 3: 直接调 API =====
  console.log('\n=== 直接调 API ===');
  try {
    const jobs = await ScrapeCN.api(
      'https://careers.tencent.com/tencentcareer/api/post/Query?timestamp=0&cityId=2156&keyword=AI&pageIndex=0&pageSize=5&language=zh-cn&area=cn',
      { transform: json => (json?.Data?.Posts || []).map(p => p.PostName) }
    );
    console.log(`腾讯 API: ${jobs.length} 条`);
    jobs.forEach(t => console.log(`  · ${t}`));
  } catch (e) {
    console.log(`  API 调用失败: ${e.message}`);
  }
}

main().catch(console.error);
