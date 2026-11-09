// 打開貼文裡的外部連結（第二層網頁），判斷是「文章」還是「工具／網站」，並抽出內容
//
// 外部網頁一律只當資料讀取：不下載檔案、不執行網頁裡寫的任何指令，也不繞過登入或機器人驗證
const fs = require('fs');
const { chromium } = require('playwright');

// Readability（Firefox 閱讀模式的核心）抽正文，Turndown 轉成 Markdown；兩者都在瀏覽器頁面裡執行
const LIBS = [require.resolve('@mozilla/readability/Readability.js'), require.resolve('turndown/lib/turndown.browser.umd.js')]
  .map(f => fs.readFileSync(f, 'utf-8'))
  .join('\n;\n');

const ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'ScholarlyArticle', 'AnalysisNewsArticle', 'OpinionNewsArticle', 'ReviewNewsArticle', 'SocialMediaPosting', 'LiveBlogPosting'];
// 需要登入才看得到內容的網站：不打開，只記下連結
const SOCIAL_RE = /(^|\.)(x\.com|twitter\.com|facebook\.com|fb\.com|fb\.watch|instagram\.com|threads\.(com|net)|linkedin\.com|tiktok\.com|dcard\.tw)$/i;
const VIDEO_RE = /(^|\.)(youtube\.com|youtu\.be)$/i;
const BLOCKED_TITLE_RE = /just a moment|attention required|access denied|verify you are human|are you a robot|captcha|security check|請稍候|请稍候|請稍等|安全檢查|安全验证|安全限制/i;
const GITHUB_RESERVED = new Set(['orgs', 'topics', 'features', 'marketplace', 'settings', 'sponsors', 'login', 'about', 'collections', 'trending', 'explore', 'search', 'pricing', 'enterprise', 'apps', 'site']);
const MAX_CONTENT = 100000; // 存檔的正文上限（字元）

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// 拿掉分享時加上的追蹤參數（可能含有你的推薦碼或帳號資訊），不影響打開網頁
const TRACKING = [/^utm_/, /^(fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|ref_src|ref_url|_hsenc|_hsmi|spm|share_source|share_medium)$/];
const HOST_TRACKING = [
  [/(^|\.)substack\.com$/, /^(r|triedRedirect|showWelcomeOnShare|publication_id|post_id|isFreemail|token)$/],
  [/(^|\.)(youtube\.com|youtu\.be)$/, /^(si|pp|feature)$/],
  [/(^|\.)(x\.com|twitter\.com)$/, /^(s|t)$/],
  [/(^|\.)(open\.spotify\.com)$/, /^(si)$/],
];
function cleanUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    for (const k of [...u.searchParams.keys()])
      if (TRACKING.some(re => re.test(k)) || HOST_TRACKING.some(([h, re]) => h.test(host) && re.test(k))) u.searchParams.delete(k);
    return u.href.replace(/\?$/, '');
  } catch {
    return url;
  }
}

async function githubRepo(owner, repo) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'thd-collect' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(20000) });
  // token 不適用時（例如本機測試），改用不帶 token 的公開讀取
  if (r.status === 401 && headers.authorization) {
    delete headers.authorization;
    r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(20000) });
  }
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  const j = await r.json();
  let readme = '';
  const rr = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
    headers: { ...headers, accept: 'application/vnd.github.raw+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (rr.ok) readme = (await rr.text()).slice(0, 30000);
  return {
    kind: 'website',
    source: 'github',
    url: j.html_url,
    title: j.full_name,
    siteName: 'GitHub',
    description: j.description || '',
    repo: { stars: j.stargazers_count, license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : '', language: j.language || '', homepage: j.homepage || '', topics: j.topics || [] },
    content: readme,
  };
}

async function youtube(url) {
  let j = {};
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) });
    if (r.ok) j = await r.json();
  } catch {}
  return { kind: 'video', url, title: j.title || '', author: j.author_name || '', siteName: 'YouTube', reason: '影片內容無法讀取，只有標題' };
}

// 先看檔案類型：純文字／Markdown 直接讀；PDF、壓縮檔等不下載
async function probe(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (r.ok && /^text\/(plain|markdown|x-markdown)$/.test(type)) {
      const text = (await r.text()).slice(0, MAX_CONTENT);
      return { kind: 'text', url: r.url, title: decodeURIComponent(new URL(r.url).pathname.split('/').pop() || ''), content: text };
    }
    await r.body?.cancel().catch(() => {});
    if (r.ok && type && !/html|xml/.test(type)) return { kind: 'file', url: r.url, reason: `檔案（${type}），沒有下載` };
  } catch {}
  return null; // 交給瀏覽器
}

async function readPage(browser, url) {
  const context = await browser.newContext({ locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 1800 }, acceptDownloads: false });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const status = resp ? resp.status() : 0;
    const title = await page.title();
    if (status >= 400 || BLOCKED_TITLE_RE.test(title))
      // 驗證頁的標題（例如「請稍候...」）不是文章標題，不要拿來用
      return { kind: 'blocked', url: page.url(), title: status >= 400 || BLOCKED_TITLE_RE.test(title) ? '' : title, reason: status >= 400 ? `HTTP ${status}` : '網站要求機器人驗證' };

    const meta = await page.evaluate(() => {
      const m = s => (document.querySelector(s) || {}).content || '';
      const types = [];
      let free = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          for (const x of [].concat(j['@graph'] || j)) {
            types.push(...[].concat(x['@type'] || []));
            if (x.isAccessibleForFree != null) free = String(x.isAccessibleForFree).toLowerCase() !== 'false';
          }
        } catch {}
      }
      const body = document.body ? document.body.innerText : '';
      return {
        url: location.href,
        ogType: m('meta[property="og:type"]').toLowerCase(),
        ldTypes: types,
        siteName: m('meta[property="og:site_name"]'),
        author: m('meta[name="author"]') || m('meta[property="article:author"]'),
        published: m('meta[property="article:published_time"]'),
        description: m('meta[property="og:description"]') || m('meta[name="description"]'),
        lang: document.documentElement.lang || '',
        paywall: free === false || !!document.querySelector('.paywall, [data-testid="paywall"]') || /This post is for paid subscribers|Keep reading with a 7-day free trial|Subscribe to continue reading/i.test(body),
        bodyText: body.slice(0, 20000),
      };
    });

    await page.evaluate(LIBS);
    const art = await page.evaluate(() => {
      /* global Readability, TurndownService */
      const a = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
      if (!a || !a.content) return null;
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
      td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button']);
      td.addRule('imageLink', {
        // 連結裡只有一張圖片時（常見於「點圖放大」），只留圖片，避免變成多行的連結
        filter: n => n.nodeName === 'A' && n.querySelectorAll('img').length === 1 && !n.textContent.trim(),
        replacement: (c, n) => { const img = n.querySelector('img'); return img.getAttribute('src') ? `\n\n![${img.getAttribute('alt') || ''}](${img.getAttribute('src')})\n\n` : ''; },
      });
      return { title: a.title, byline: a.byline, siteName: a.siteName, lang: a.lang, published: a.publishedTime, length: a.length, markdown: td.turndown(a.content) };
    }).catch(() => null);

    const markdown = (art?.markdown || '').replace(/\n{3,}/g, '\n\n').trim();
    const looksArticle =
      meta.ogType === 'article' ||
      meta.ldTypes.some(t => ARTICLE_TYPES.includes(t)) ||
      ((art?.length || 0) > 1500 && !!(art?.byline || art?.published || meta.published));
    return {
      kind: looksArticle ? 'article' : 'website',
      url: meta.url,
      title: art?.title || title,
      siteName: art?.siteName || meta.siteName || hostOf(meta.url),
      author: art?.byline || meta.author || '',
      published: art?.published || meta.published || '',
      description: meta.description,
      lang: art?.lang || meta.lang,
      paywalled: meta.paywall,
      markers: { ogType: meta.ogType, ldTypes: meta.ldTypes },
      content: (markdown.length > 200 ? markdown : meta.bodyText).slice(0, MAX_CONTENT),
      truncated: markdown.length > MAX_CONTENT,
      textLength: art?.length || 0,
    };
  } finally {
    await context.close();
  }
}

// links：[{ url, title }]（title 是 Threads 連結預覽卡上的標題，打不開時拿來顯示）
async function readLinks(links, log = console.log) {
  const out = [];
  let browser = null;
  try {
    for (const original of links) {
      const link = { ...original, url: cleanUrl(original.url) };
      const host = hostOf(link.url);
      const base = { url: link.url, title: link.title || '' };
      try {
        let r;
        const gh = host === 'github.com' && new URL(link.url).pathname.split('/').filter(Boolean);
        if (gh && gh.length >= 2 && !GITHUB_RESERVED.has(gh[0])) {
          r = await githubRepo(gh[0], gh[1].replace(/\.git$/, '')).catch(async e => {
            // API 失敗（例如額度用完）時，改用瀏覽器讀 repo 頁面
            log(`GitHub API 失敗（${e.message}），改讀網頁`);
            browser ||= await chromium.launch();
            const page = await readPage(browser, link.url);
            // 頁面本身讀不到（例如 404）就維持原本的判斷，不要當成網站
            return page.kind === 'blocked' ? page : { ...page, kind: 'website', source: 'github', siteName: 'GitHub' };
          });
        } else if (VIDEO_RE.test(host)) r = await youtube(link.url);
        else if (SOCIAL_RE.test(host)) r = { kind: 'social', reason: '需要登入才看得到，沒有打開' };
        else {
          r = await probe(link.url);
          if (!r) {
            browser ||= await chromium.launch();
            r = await readPage(browser, link.url);
          }
        }
        r = { ...base, ...r, title: r.title || base.title };
        log(`連結 ${link.url} → ${r.kind}${r.reason ? `（${r.reason}）` : ''}`);
        out.push(r);
      } catch (e) {
        log(`連結 ${link.url} 讀取失敗：${e.message.split('\n')[0]}`);
        out.push({ ...base, kind: 'error', reason: e.message.split('\n')[0].slice(0, 120) });
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return out;
}

module.exports = { readLinks, cleanUrl };

// 直接執行時當作測試：node src/web.js <url> [url...]
if (require.main === module) {
  readLinks(process.argv.slice(2).map(url => ({ url }))).then(rs =>
    rs.forEach(r => console.log(JSON.stringify({ ...r, content: r.content ? `${r.content.slice(0, 300)}…（共 ${r.content.length} 字）` : undefined }, null, 1))),
  );
}
