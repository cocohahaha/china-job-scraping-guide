#!/usr/bin/env node
/**
 * API 响应拦截（需要 Playwright）
 *
 * SPA 底层一定会调 API。拦截 API 响应能拿到结构化 JSON，
 * 比 DOM 提取稳定得多，不受前端改版影响。
 */

const { ScrapeCN } = require('../');

async function main() {
  // ===== 方式 1: 先试直接调 API（不需要 Playwright）=====
  console.log('=== 直接调 API（无需浏览器）===');
  try {
    const jobs = await ScrapeCN.api(
      'https://careers.tencent.com/tencentcareer/api/post/Query?timestamp=0&cityId=2156&keyword=产品&pageIndex=0&pageSize=10&language=zh-cn&area=cn',
      {
        transform: (json) => (json?.Data?.Posts || []).map(p => ({
          title: p.PostName,
          url: `https://careers.tencent.com/jobdesc.html?postId=${p.PostId}`,
          location: p.LocationName,
          department: p.CategoryName,
        })),
      }
    );
    console.log(`腾讯: ${jobs.length} 条`);
    jobs.forEach((j, i) => console.log(`  ${i + 1}. [${j.department}] ${j.title} - ${j.location}`));
  } catch (e) {
    console.log(`  直接调用失败: ${e.message}`);
  }

  // ===== 方式 2: Playwright + API 拦截（拦截浏览器中的 API 响应）=====
  console.log('\n=== Playwright API 拦截 ===');
  const scraper = new ScrapeCN();
  try {
    const jobs = await scraper.scrape('tencent');
    console.log(`腾讯: ${jobs.length} 条`);
    jobs.slice(0, 5).forEach((j, i) => console.log(`  ${i + 1}. [${j.bg}] ${j.title} - ${j.location}`));
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
