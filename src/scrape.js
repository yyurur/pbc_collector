// 用無頭瀏覽器（不登入）打開 Threads 貼文，抓主文、作者串文、留言與圖片
const { chromium } = require('playwright');

const TIME_RE = /^(\d+[smhdw]|\d{1,2}\/\d{1,2}\/\d{2,4}|just now)$/i;
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const COUNT_RE = /^[\d.,]+[KMB]?$/;
const UI_LINES = new Set(['Translate', 'Author', '·', 'Thread', 'Top', 'View activity']);

// 把頁面文字切成一則一則的貼文／留言
function parseSegments(text) {
  const cut = text.indexOf('Related threads');
  const lines = (cut > 0 ? text.slice(0, cut) : text).replace(/[\u2028\u2029]/g, '\n').split('\n').map(l => l.trimEnd());
  const headers = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!HANDLE_RE.test(lines[i].trim())) continue;
    // 帳號下一行是時間，或中間夾一行話題標籤
    if (TIME_RE.test(lines[i + 1].trim())) headers.push({ i, timeAt: i + 1 });
    else if (i + 2 < lines.length && TIME_RE.test(lines[i + 2].trim()) && !HANDLE_RE.test(lines[i + 1].trim()))
      headers.push({ i, timeAt: i + 2, topic: lines[i + 1].trim() });
  }
  return headers.map((h, k) => {
    const end = k + 1 < headers.length ? headers[k + 1].i : lines.length;
    let body = lines.slice(h.timeAt + 1, end);
    let isAuthor = false;
    if (body[0] && body[0].trim() === '·' && body[1] && body[1].trim() === 'Author') {
      isAuthor = true;
      body = body.slice(2);
    }
    // 去掉結尾的按讚數、回覆數等數字與介面文字
    while (body.length && (COUNT_RE.test(body[body.length - 1].trim()) || UI_LINES.has(body[body.length - 1].trim()) || !body[body.length - 1].trim()))
      body.pop();
    const textOut = body.filter(l => l.trim() !== 'Translate').join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { handle: lines[h.i].trim(), topic: h.topic || '', timeRaw: lines[h.timeAt].trim(), isAuthor, text: textOut };
  });
}

// Threads 把外部連結包成 l.threads.com/?u=原網址：解開、去掉重複，排除其他 Threads 貼文的連結
const MAX_LINKS = 3;
function collectLinks(list) {
  const out = [];
  const key = u => u.replace(/^http:/, 'https:').replace(/\/+$/, '').toLowerCase();
  for (const { url, title } of list) {
    let u = url;
    try {
      const parsed = new URL(u);
      if (/(^|\.)l\.threads\.(com|net)$/.test(parsed.hostname) && parsed.searchParams.get('u')) u = parsed.searchParams.get('u');
      u = new URL(u).href;
    } catch { continue; }
    if (!/^https?:/.test(u) || /^https?:\/\/(www\.)?threads\.(com|net)\//.test(u)) continue;
    const found = out.find(x => key(x.url) === key(u));
    if (found) { if (!found.title && title) found.title = title; if (/^http:/.test(found.url)) found.url = u; continue; }
    out.push({ url: u, title: title || '' });
  }
  return out.slice(0, MAX_LINKS);
}

async function scrapePost(url, { maxImages = 10 } = {}) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'Asia/Taipei',
      viewport: { width: 1280, height: 1800 },
    });
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    const status = resp ? resp.status() : 0;
    await page.waitForTimeout(2500);
    for (let k = 0; k < 4; k++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(1200);
    }
    const raw = await page.evaluate(() => {
      const meta = p => (document.querySelector(`meta[property="${p}"]`) || {}).content || '';
      // 「Related threads」以下是推薦內容，不要
      let limitY = Infinity;
      for (const el of document.querySelectorAll('span, div, h1, h2')) {
        if (el.childElementCount === 0 && el.textContent.trim() === 'Related threads') {
          limitY = el.getBoundingClientRect().top + window.scrollY;
          break;
        }
      }
      const above = el => el.getBoundingClientRect().top + window.scrollY < limitY;
      const timeEls = [...document.querySelectorAll('time[datetime]')].filter(above);
      const times = timeEls.map(t => t.getAttribute('datetime'));
      const links = timeEls.map(t => (t.closest('a') || {}).href || '');
      // 圖片從頁面內嵌的資料取得：每則貼文（用貼文 ID 對應）各自的圖片清單，不會把留言的圖混進本文
      const pick = cands => {
        const c = cands.filter(x => x && x.url && x.width).sort((x, y) => x.width - y.width);
        return (c.find(x => x.width >= 1080) || c[c.length - 1] || {}).url;
      };
      const media = {};
      const mediaType = {}; // 1 圖片、2 影片、8 輪播、19 純文字
      const postLinks = {};
      const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 80) return;
        if (typeof o.code === 'string' && (o.carousel_media || o.image_versions2)) {
          const items = o.carousel_media && o.carousel_media.length ? o.carousel_media : [o];
          const list = items
            .map(it => ({ src: pick(((it.image_versions2 || {}).candidates) || []), video: it.media_type === 2 || !!(it.video_versions && it.video_versions.length) }))
            .filter(m => m.src || m.video);
          // 同一則貼文可能出現好幾次，留圖片最多的那份
          if (!media[o.code] || list.length > media[o.code].length) media[o.code] = list;
          if (o.media_type != null) mediaType[o.code] = o.media_type;
        }
        // 每則貼文自己放的外部連結（連結預覽卡＋內文裡的連結）
        if (typeof o.code === 'string' && o.text_post_app_info) {
          const t = o.text_post_app_info;
          const list = postLinks[o.code] || (postLinks[o.code] = []);
          const add = (url, title) => url && !list.some(x => x.url === url) && list.push({ url, title: title || '' });
          if (t.link_preview_attachment) add(t.link_preview_attachment.url, t.link_preview_attachment.title);
          for (const f of ((t.text_fragments || {}).fragments || [])) if (f.link_fragment) add(f.link_fragment.uri, '');
        }
        if (Array.isArray(o)) o.forEach(x => walk(x, d + 1));
        else for (const k in o) walk(o[k], d + 1);
      };
      for (const sc of document.querySelectorAll('script[type="application/json"]')) {
        try { walk(JSON.parse(sc.textContent), 0); } catch {}
      }
      return {
        text: document.body ? document.body.innerText : '',
        times,
        links,
        media,
        mediaType,
        postLinks,
        ogDescription: meta('og:description'),
        ogTitle: meta('og:title'),
        ogImage: meta('og:image'),
      };
    });

    const segments = parseSegments(raw.text);
    if (raw.times.length === segments.length)
      segments.forEach((s, i) => {
        s.datetime = raw.times[i];
        s.link = (raw.links[i] || '').split('?')[0];
      });

    let main = segments[0];
    // 解析失敗時，退回網頁描述欄位
    if (!main || !main.text) {
      if (!raw.ogDescription) throw new Error(`抓不到貼文內容（HTTP ${status}）`);
      const handle = (url.match(/@([\w.]+)/) || [])[1] || '';
      main = { handle, text: raw.ogDescription, timeRaw: '', isAuthor: false };
      segments.splice(0, segments.length, main);
    }
    const chain = [];
    let k = 1;
    while (k < segments.length && segments[k].isAuthor && segments[k].handle === main.handle) chain.push(segments[k++]);
    const comments = segments.slice(k);
    const codeOf = link => ((link || '').match(/\/(?:post|t)\/([\w-]+)/) || [])[1];
    const mediaOf = code => (code && raw.media[code]) || [];
    const imagesOf = code => mediaOf(code).filter(m => m.src).map(m => ({ src: m.src }));
    const postId = codeOf(url);
    main.images = imagesOf(postId).slice(0, maxImages);
    // 沒登入時，有些貼文的圖片清單是空的：退回網頁預覽圖（通常是第一張）
    // 但預覽圖如果是大頭貼（網址是 t51.xxx-19），就代表真的拿不到圖片
    const isPostMedia = src => /\/t51\.\d+-15\//.test(src || '');
    if (!main.images.length && isPostMedia(raw.ogImage)) main.images = [{ src: raw.ogImage }];
    const type = raw.mediaType[postId];
    const imagesHidden = !main.images.length && [1, 8].includes(type);
    chain.forEach(c => (c.images = imagesOf(codeOf(c.link))));
    comments.forEach(c => (c.images = imagesOf(codeOf(c.link))));
    // 給 Gemini 看、或 SAVE_IMAGES 時要存的：本文＋作者串文的圖（不含留言）
    const images = [...main.images, ...chain.flatMap(c => c.images)];
    const hasVideo = [postId, ...chain.map(c => codeOf(c.link))].some(code => mediaOf(code).some(m => m.video));
    const links = collectLinks([postId, ...chain.map(c => codeOf(c.link))].map(code => raw.postLinks[code] || []).flat());
    return { status, main, chain, comments, images, hasVideo, imagesHidden, links, fallback: segments.length === 1 && !raw.times.length };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapePost, parseSegments };

// 直接執行時當作測試：node src/scrape.js <url>
if (require.main === module) {
  scrapePost(process.argv[2]).then(r => {
    console.log(JSON.stringify({ ...r, main: { ...r.main, text: r.main.text.slice(0, 120) },
      chain: r.chain.map(c => ({ ...c, text: c.text.slice(0, 60) })),
      comments: r.comments.map(c => ({ ...c, text: c.text.slice(0, 60) })),
      images: r.images.map(i => i.src.slice(0, 70)), links: r.links }, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}
