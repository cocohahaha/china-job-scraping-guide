#!/usr/bin/env node
/**
 * 声明式提取：用 CSS 选择器定义数据结构
 *
 * 不需要写 page.evaluate，只需声明：
 *   selector: 数据项容器的选择器
 *   fields: 每个字段对应容器内的子选择器
 *
 * 字段选择器语法：
 *   'h3'           → 取 h3 的 textContent
 *   'a @href'      → 取 a 的 href 属性
 *   'img @src'     → 取 img 的 src 属性
 */

const { ScrapeCN } = require('../');

async function main() {
  const scraper = new ScrapeCN();

  try {
    const items = await scraper.scrape('https://hr.163.com/job-list.html?workType=1&lang=zh', {
      wait: 5000,
      // 声明式提取
      selector: '[class*="job-item"], [class*="position-item"], li[class]',
      fields: {
        title: 'h3, h4, [class*="title"], [class*="name"]',
        link: 'a @href',
        location: '[class*="location"], [class*="city"]',
      },
    });

    console.log(`提取到 ${items.length} 条数据：`);
    items.slice(0, 10).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title} [${item.location || ''}]`);
    });
  } finally {
    await scraper.close();
  }
}

main().catch(console.error);
