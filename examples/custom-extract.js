#!/usr/bin/env node
/**
 * 自定义提取函数 + actions 流水线
 *
 * 当内置的自动提取和声明式提取都不满足需求时，
 * 可以写自定义的 extract 函数，拿到完整的 Playwright page 对象。
 *
 * actions 数组支持有序的多步操作：
 *   { click: '社会招聘' }  → 点击包含该文字的元素
 *   { search: '产品' }     → 在搜索框中输入并提交
 *   { wait: 3000 }         → 等待指定毫秒
 *   { scroll: true }       → 滚动到页面底部
 */

const { ChinaScraper } = require('../');

async function main() {
  const scraper = new ChinaScraper();

  try {
    const items = await scraper.scrape({
      url: 'https://vrfi1sk8a0.jobs.feishu.cn/',
      wait: 5000,

      // actions: 按顺序执行的操作（先点 tab，再搜索）
      actions: [
        { click: '社会招聘' },
        { wait: 3000 },
        { search: { text: '产品', waitAfter: 4000 } },
      ],

      // extract: 自定义提取逻辑
      extract: async (page) => {
        return page.evaluate(() => {
          const results = [];
          document.querySelectorAll('a[href*="/position/"]').forEach(a => {
            const card = a.closest('[class*="item"], [class*="card"], li, div') || a;
            const fullText = (card.textContent || '').trim().replace(/\s+/g, ' ');
            results.push({
              title: (a.textContent || '').trim().split(/\s/)[0],
              url: a.href,
              jdSummary: fullText.slice(0, 500),
            });
          });
          return results;
        });
      },
    });

    console.log(`提取到 ${items.length} 条数据：`);
    items.forEach((item, i) => {
      console.log(`\n${i + 1}. ${item.title}`);
      console.log(`   URL: ${item.url}`);
      console.log(`   摘要: ${(item.jdSummary || '').slice(0, 100)}...`);
    });
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
