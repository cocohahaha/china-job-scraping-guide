#!/usr/bin/env node
/**
 * API 响应拦截
 *
 * 很多中国 SPA 站点的 DOM 结构极其复杂（嵌套 Shadow DOM、虚拟列表、动态 class），
 * 但底层一定会调用 API 获取数据。直接拦截 API 响应能拿到结构化的 JSON，
 * 比从 DOM 提取准确得多，也不受前端改版影响。
 *
 * 本例演示两种 API 获取方式：
 *   1. response 事件拦截（被动监听）
 *   2. 同源 fetch（主动调用）
 */

const { ChinaScraper } = require('../');

async function main() {
  const scraper = new ChinaScraper();

  try {
    // ===== 方式 1：使用预设（已配置好 API 拦截）=====
    console.log('=== 腾讯（预设）===');
    const tencentJobs = await scraper.scrape('tencent');
    console.log(`腾讯: ${tencentJobs.length} 条岗位`);
    tencentJobs.slice(0, 5).forEach((j, i) => {
      console.log(`  ${i + 1}. [${j.bg}] ${j.title} - ${j.location}`);
    });

    // ===== 方式 2：自定义 API 拦截 =====
    console.log('\n=== 自定义 API 拦截 ===');
    const items = await scraper.scrape('https://careers.tencent.com/search.html', {
      wait: 5000,
      api: {
        // match: API URL 中包含的关键字（子串匹配）
        match: 'tencentcareer/api/post/Query',
        // transform: 从 API 响应 JSON 中提取你需要的数据
        transform: (json) => (json?.Data?.Posts || []).map(p => ({
          title: p.PostName,
          postId: p.PostId,
          city: p.LocationName,
          department: p.CategoryName,
        })),
      },
    });
    console.log(`自定义拦截: ${items.length} 条`);

    // ===== 方式 3：同源 fetch（手动调 API）=====
    // 注意：必须先导航到目标域名，然后用相对路径调用 API（避免 CORS）
    console.log('\n=== 同源 fetch ===');
    const fetchItems = await scraper.scrape('https://careers.tencent.com/search.html', {
      wait: 3000,
      api: {
        // fetch: 相对路径，会在目标域名的上下文中执行
        fetch: '/tencentcareer/api/post/Query?timestamp=0&cityId=2156&keyword=AI&pageIndex=0&pageSize=10&language=zh-cn&area=cn',
        transform: (json) => (json?.Data?.Posts || []).map(p => ({
          title: p.PostName,
          city: p.LocationName,
        })),
      },
    });
    console.log(`同源 fetch: ${fetchItems.length} 条`);
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
