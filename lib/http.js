/**
 * 轻量 HTTP 抓取（不依赖 Playwright）
 *
 * 用 Node.js 内置 fetch 请求页面，然后用正则/字符串方法提取数据。
 * 适用于：服务端渲染的静态页面、公开 API 端点、简单的招聘页面。
 *
 * 对于 SPA 页面（字节跳动、腾讯等），需要 Playwright → 见 scraper.js
 */

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/**
 * HTTP GET 请求，返回文本
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {Object} [options.headers] - 自定义请求头
 * @param {number} [options.timeout=15000] - 超时（毫秒）
 * @param {string} [options.cookie] - Cookie 字符串
 * @returns {string} 响应文本
 */
async function fetchText(url, options = {}) {
  const headers = { ...DEFAULT_HEADERS, ...options.headers };
  if (options.cookie) headers['Cookie'] = options.cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const resp = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP GET 请求，返回 JSON
 */
async function fetchJSON(url, options = {}) {
  const headers = {
    ...DEFAULT_HEADERS,
    'Accept': 'application/json',
    ...options.headers,
  };
  if (options.cookie) headers['Cookie'] = options.cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const resp = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 HTML 字符串中提取数据（不依赖 cheerio）
 *
 * 用正则表达式匹配 <a> 标签、标题标签等。
 * 精度不如 DOM parser 但零依赖。
 *
 * @param {string} html
 * @param {Object} [options]
 * @param {RegExp} [options.linkPattern] - 匹配详情页 URL 的正则
 * @param {string[]} [options.keywords] - 标题关键词过滤
 * @returns {Array<{title: string, url: string}>}
 */
function parseLinks(html, options = {}) {
  const results = [];
  const seen = new Set();

  // 默认匹配含数字 ID 的详情页链接
  const linkPattern = options.linkPattern
    || /href="([^"]*(?:position|job|detail|post|article)[^"]*\d{4,}[^"]*)"/gi;

  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    if (seen.has(href)) continue;
    seen.add(href);

    // 提取 href 前后最近的文本作为标题
    const pos = match.index;
    const surrounding = html.slice(Math.max(0, pos - 200), pos + match[0].length + 500);

    // 找 <a> 标签内的文本
    const titleMatch = surrounding.match(/>([^<]{2,80})</);
    const title = titleMatch ? titleMatch[1].trim() : '';

    if (title && (!options.keywords || options.keywords.some(k => title.includes(k)))) {
      results.push({ title, url: href });
    }
  }

  return results;
}

/**
 * 从 HTML 中提取 JSON-LD 结构化数据
 *
 * 很多网站（包括中国的）会在页面中嵌入 JSON-LD，这是最干净的数据源。
 */
function parseJsonLD(html) {
  const results = [];
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]));
    } catch (e) {}
  }

  return results;
}

/**
 * 从 HTML 中提取内联的 JSON 数据（window.__INITIAL_STATE__ 等）
 *
 * 中国 SPA 框架常把首屏数据注入到全局变量中，即使 fetch 也能拿到。
 *
 * @param {string} html
 * @param {string} [variableName] - 变量名（如 '__INITIAL_STATE__'）
 */
function parseInlineJSON(html, variableName) {
  const patterns = variableName
    ? [new RegExp(`${variableName}\\s*=\\s*(\\{[\\s\\S]*?\\});?\\s*<\\/script>`, 'i')]
    : [
        /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
        /window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
        /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
        /window\.__APP_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
      ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try { return JSON.parse(match[1]); } catch (e) {}
    }
  }
  return null;
}

module.exports = { fetchText, fetchJSON, parseLinks, parseJsonLD, parseInlineJSON };
