#!/bin/bash
# Boss直聘 AppleScript 终极方案
#
# 原理：通过 macOS AppleScript 控制用户已打开的 Chrome，
# 导航到 Boss直聘搜索页，然后用 Cmd+A/Cmd+C 复制页面内容。
# 完全不涉及 WebDriver 协议，零检测风险。
#
# 前提：Chrome 已打开且已登录 Boss 直聘
#
# 用法：
#   bash scripts/boss-applescript.sh
#   SEARCH_TERMS="前端工程师,React开发" bash scripts/boss-applescript.sh
#   CITY_CODE=101010100 bash scripts/boss-applescript.sh  # 北京

OUTPUT_DIR="${OUTPUT_DIR:-output/boss-applescript}"
CITY_CODE="${CITY_CODE:-101020100}"  # 默认上海
mkdir -p "$OUTPUT_DIR"

# 搜索关键词（可通过环境变量自定义）
if [ -n "$SEARCH_TERMS" ]; then
  IFS=',' read -ra TERMS <<< "$SEARCH_TERMS"
else
  TERMS=("AI产品经理" "AIGC产品经理" "AI Agent 产品" "大模型产品经理" "AI工程师")
fi

ALL_FILE="$OUTPUT_DIR/all-searches.txt"
> "$ALL_FILE"

echo "=== Boss直聘 AppleScript 抓取器 ==="
echo "城市代码: $CITY_CODE"
echo "搜索关键词: ${TERMS[*]}"
echo ""

for term in "${TERMS[@]}"; do
  echo "========== 搜索: $term =========="

  # URL 编码
  ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$term'))")
  URL="https://www.zhipin.com/web/geek/job?query=${ENCODED}&city=${CITY_CODE}"

  # 导航到搜索页
  osascript -e "tell application \"Google Chrome\"
    activate
    set URL of active tab of window 1 to \"$URL\"
  end tell"

  echo "等待页面加载..."
  sleep 8

  # 获取页面标题
  TITLE=$(osascript -e 'tell application "Google Chrome" to return title of active tab of window 1' 2>/dev/null)
  echo "标题: $TITLE"

  # 方式 1：Cmd+A / Cmd+C 复制全部页面文本
  osascript -e '
  tell application "Google Chrome" to activate
  delay 0.3
  tell application "System Events"
    tell process "Google Chrome"
      key code 119
      delay 1
      key code 119
      delay 1
      keystroke "a" using command down
      delay 0.3
      keystroke "c" using command down
      delay 0.5
    end tell
  end tell
  '

  TERM_FILE="$OUTPUT_DIR/search-${term// /_}.txt"
  pbpaste > "$TERM_FILE"
  CHARS=$(wc -c < "$TERM_FILE")
  echo "剪贴板内容: $CHARS 字节 → $TERM_FILE"

  # 方式 2：通过 JS 注入提取结构化数据
  JS_RESULT=$(osascript << 'ENDSCRIPT'
tell application "Google Chrome"
  tell active tab of window 1
    return execute javascript "
      (function() {
        var jobs = [];
        var seen = {};
        var cards = document.querySelectorAll('.job-card-wrapper .job-card-box');
        if (cards.length === 0) cards = document.querySelectorAll('.job-card-wrapper');
        if (cards.length === 0) cards = document.querySelectorAll('[class*=\"job-card\"]');
        cards.forEach(function(card) {
          var titleEl = card.querySelector('.job-name');
          var salaryEl = card.querySelector('.salary, [class*=\"salary\"]');
          var companyEl = card.querySelector('.company-name, [class*=\"company-name\"]');
          var locationEl = card.querySelector('.job-area, [class*=\"job-area\"]');
          var linkEl = card.querySelector('a[href*=\"job_detail\"]') || card.querySelector('a');
          var title = titleEl ? titleEl.textContent.trim() : '';
          var salary = salaryEl ? salaryEl.textContent.trim() : '';
          var company = companyEl ? companyEl.textContent.trim() : '';
          var location = locationEl ? locationEl.textContent.trim() : '';
          var link = linkEl ? linkEl.href : '';
          if (title && !seen[link]) {
            seen[link] = true;
            jobs.push([title, company, salary, location, link].join(' ||| '));
          }
        });
        return 'TOTAL:' + jobs.length + '\\n' + jobs.join('\\n');
      })()
    "
  end tell
end tell
ENDSCRIPT
  )

  JS_FILE="$OUTPUT_DIR/search-${term// /_}-structured.txt"
  echo "$JS_RESULT" > "$JS_FILE"
  JS_COUNT=$(echo "$JS_RESULT" | head -1 | grep -o '[0-9]*')
  echo "结构化提取: $JS_COUNT 条岗位 → $JS_FILE"

  # 追加到汇总
  echo "" >> "$ALL_FILE"
  echo "---${term}---" >> "$ALL_FILE"
  echo "$JS_RESULT" >> "$ALL_FILE"

  sleep 3
done

echo ""
echo "=== 抓取完成 ==="
echo "汇总文件: $ALL_FILE"
echo "文件大小: $(wc -c < "$ALL_FILE") 字节"
echo ""
echo "结果文件："
ls -la "$OUTPUT_DIR"/*.txt 2>/dev/null
