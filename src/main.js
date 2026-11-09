// 主流程：Telegram 新訊息 → 抓貼文 → Gemini 整理 → 寫進 Google Drive → 回報
//
// 測試模式（不碰 Telegram 與 Google Drive，筆記寫到 ./out）：
//   node src/main.js --test <Threads 連結> [--no-ai]
const fs = require('fs');
const path = require('path');
const { scrapePost } = require('./scrape');
const { analyzePost, findMissingInComments, analyzeSupplement, diagnose, MODEL } = require('./gemini');
const { buildNote, appendSupplement, noteFileName, noteTitle } = require('./note');
const { processLinks, linkRecord, urlKey } = require('./links');
const { processWeb, processWebText, processText, webId, textId, UNREADABLE } = require('./clips');
const xhs = require('./xhs');
const { cleanUrl } = require('./web');
const telegram = require('./telegram');
const stateStore = require('./state');

const LINK_RE = /https?:\/\/(?:www\.)?threads\.(?:com|net)\/(?:@([\w.]+)\/post|t)\/([\w-]+)/g;
const ID_TAG_RE = /🆔 ([\w-]+)/;
const SHARE_RE = /https?:\/\/(?:www\.)?threads\.(?:com|net)\/share\/[\w-]+/g;

function extractLinks(text) {
  const out = [];
  for (const m of (text || '').matchAll(LINK_RE)) {
    const [, handle, id] = m;
    out.push({ id, url: handle ? `https://www.threads.com/@${handle}/post/${id}` : `https://www.threads.com/t/${id}` });
  }
  return out;
}

// Threads 分享到 Telegram 時，網址可能在文字、超連結或連結預覽裡
function messageLinks(m) {
  const sources = [m.text, m.caption];
  const txt = m.text || m.caption || '';
  for (const e of [...(m.entities || []), ...(m.caption_entities || [])]) {
    if (e.type === 'text_link' && e.url) sources.push(e.url);
    if (e.type === 'url') sources.push(txt.substr(e.offset, e.length));
  }
  if (m.link_preview_options?.url) sources.push(m.link_preview_options.url);
  const all = sources.filter(Boolean).join('\n');
  // 新版分享短網址：https://www.threads.com/share/XXXX（要先轉址才知道是哪篇）
  const shares = [...new Set([...all.matchAll(SHARE_RE)].map(x => x[0]))];
  // Threads 以外的網址
  const others = [...new Set([...all.matchAll(URL_RE)].map(x => x[0].replace(/[)\]}>.,;:!?'"，。、）」』】]+$/, '')))]
    .filter(u => !/^https?:\/\/(?:[\w-]+\.)*threads\.(?:com|net)\//i.test(u))
    .map(cleanUrl);
  return { links: extractLinks(all), shares, others: [...new Set(others)] };
}

const URL_RE = /https?:\/\/[^\s<>"'）」』】]+/g;
const XHS_RE = /(?:^|\.)(xhslink\.com|xiaohongshu\.com)$/i;
const isXhs = u => { try { return XHS_RE.test(new URL(u).hostname); } catch { return false; } };
// 超過 50 字（不含網址）就當成要存的文章文字
const TEXT_MIN = 50;
// 從瀏覽器或 App 分享網址時，通常是「網址＋一行標題」：不換行、200 字以內的，當成「傳網址」
const LINK_TEXT_MAX = 200;
const isLinkShare = plain => plain.length <= TEXT_MIN || (!plain.includes('\n') && plain.length <= LINK_TEXT_MAX);
// Telegram 會把超過 4,096 字的訊息拆成好幾則：前一則夠長、而且 10 秒內接著傳來的，就合併成同一篇
const SPLIT_MIN = 3500;
const MERGE_SECONDS = 10;
const isTextDoc = d => d && (/^text\/(plain|markdown|x-markdown)$/.test(d.mime_type || '') || /\.(txt|md|markdown)$/i.test(d.file_name || ''));

// 短網址會 302 轉到 /@帳號/post/貼文ID
async function resolveShare(shareUrl) {
  let u = shareUrl;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const loc = r.headers.get('location');
    if (!loc) break;
    u = new URL(loc, u).href;
    if (extractLinks(u).length) return extractLinks(u)[0];
  }
  throw new Error(`無法解析分享連結：${shareUrl}`);
}

const extOf = mime => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] || 'jpg';

async function fetchImage(src) {
  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { mime, buffer: Buffer.from(await r.arrayBuffer()) };
}

// 其他來源的資料夾：第一次存檔時才建立，建好後請搬到 vault 的 raw/articles 底下
const WEB_FOLDER = () => process.env.DRIVE_WEB_FOLDER || 'from-web';
const XHS_FOLDER = () => process.env.DRIVE_XHS_FOLDER || 'Xiaohongshu';
// /xhs 之後 5 分鐘內傳的截圖，都算同一篇小紅書
const XHS_WINDOW = 300;
const isCommand = (t, name) => new RegExp(`^/${name}(@\\w+)?(\\s|$)`, 'i').test(t || '');
const TEXT_FOLDER = () => process.env.DRIVE_TEXT_FOLDER || 'from-text';

// 本機測試用的儲存位置
function localStorage(root = process.env.LOCAL_OUT || 'out/Threads') {
  const att = path.join(root, 'attachments');
  fs.mkdirSync(att, { recursive: true });
  return {
    exists: async (name, inAtt) => fs.existsSync(path.join(inAtt ? att : root, name)),
    writeNote: async (name, text) => (fs.writeFileSync(path.join(root, name), text), { id: name }),
    findNote: async name => (fs.existsSync(path.join(root, name)) ? { id: name } : null),
    readNote: async id => (fs.existsSync(path.join(root, id)) ? { name: id, text: fs.readFileSync(path.join(root, id), 'utf-8') } : null),
    replaceNote: async (oldName, name, text) => (fs.rmSync(path.join(root, oldName), { force: true }), fs.writeFileSync(path.join(root, name), text), { id: name }),
    writeAttachment: async (name, mime, buf) => fs.writeFileSync(path.join(att, name), buf),
  };
}

// previous：之前存成「未摘要」或「失敗」的紀錄，有的話就覆蓋那篇筆記
async function saveNote(store, file, text, previous) {
  if (previous) {
    const old = previous.driveId ? { id: previous.driveId } : previous.file ? await store.findNote(previous.file) : null;
    if (old) {
      try {
        return (await store.replaceNote(old.id, file, text)).id;
      } catch (e) {
        console.log(`  覆蓋舊筆記失敗，改為新增：${e.message}`);
      }
    }
  }
  return (await store.writeNote(file, text))?.id;
}

// 文章資料夾：預設 from-threads，第一次另存文章時才建立；建好後請搬到 vault 的 raw/articles 底下
const ARTICLES_FOLDER = () => process.env.DRIVE_ARTICLES_FOLDER || 'from-threads';

// 處理紀錄裡已經存過的文章：網址 → { file, driveId, status }
function knownArticles(data) {
  const known = new Map();
  for (const rec of Object.values(data)) {
    for (const l of rec.links || []) if (l.file) known.set(urlKey(l.url), l);
    if (rec.type === 'web' && rec.kind === 'article' && rec.file) for (const u of [rec.url, rec.pageUrl]) if (u) known.set(urlKey(u), rec);
  }
  return known;
}

async function processLink({ id, url }, store, { useAi = true, previous, articleStore, known = new Map() } = {}) {
  const t0 = Date.now();
  const log = msg => console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  let post;
  try {
    log('打開貼文…');
    post = await scrapePost(url);
    log(`抓到：主文 ${post.main.text.length} 字、串文 ${post.chain.length} 則、留言 ${post.comments.length} 則、圖片 ${post.images.length} 張`);
  } catch (e) {
    log(`抓取失敗：${e.message}`);
    const { title, text } = buildNote({ id, url, status: 'failed', error: e.message });
    const file = noteFileName(title, id);
    const driveId = await saveNote(store, file, text, previous);
    return { title, file, driveId, status: 'failed', error: e.message };
  }

  // 預設只在筆記放圖片連結；圖片只暫時讀進記憶體給 Gemini 看，不存檔
  // 想把圖片存進 vault：在 GitHub Variables 設定 SAVE_IMAGES = true
  const saveImages = process.env.SAVE_IMAGES === 'true';
  const images = [];
  const embeds = new Map(); // 圖片網址 → 筆記裡的嵌入語法
  for (const [i, im] of post.images.entries()) {
    if (!saveImages && images.length >= 6) continue;
    try {
      log(`讀取圖片 ${i + 1}/${post.images.length}…`);
      const img = await fetchImage(im.src);
      if (saveImages) {
        const name = `${id}-${i + 1}.${extOf(img.mime)}`;
        await store.writeAttachment(name, img.mime, img.buffer);
        embeds.set(im.src, `![[${name}]]`);
      }
      if (images.length < 6) images.push(img);
    } catch (e) {
      console.log(`  圖片 ${i + 1} 讀取失敗：${e.message}${e.cause ? `（${e.cause.code || e.cause.message || e.cause}）` : ''}`);
    }
  }

  // 作者在留言裡附的照片（通常是補充資訊）：一律給 Gemini 看
  const loadImages = async (list, max) => {
    const out = [];
    for (const im of list) {
      if (out.length >= max) break;
      try { out.push(await fetchImage(im.src)); } catch (e) { console.log(`  留言圖片讀取失敗：${e.message}`); }
    }
    return out;
  };
  const authorCommentImgs = post.comments.filter(c => c.isAuthor && c.handle === post.main.handle).flatMap(c => c.images || []);
  const groups = [
    { label: '本文與作者串文的照片', images },
    { label: '作者在留言裡附的照片', images: await loadImages(authorCommentImgs, Math.max(0, 6 - images.length)) },
  ];
  const imgCount = groups.reduce((n, g) => n + g.images.length, 0);

  let ai = null;
  let error;
  if (useAi) {
    try {
      log(`Gemini 整理中（${MODEL()}，${imgCount} 張圖）…`);
      ai = await analyzePost(post, groups);
    } catch (e) {
      error = e.message;
      console.log(`  Gemini 失敗：${e.message}`);
    }
  }

  // 缺關鍵資訊時，才把其他人留言附的照片給 Gemini 看，專門找缺少的那項
  const otherComments = post.comments.filter(c => !(c.isAuthor && c.handle === post.main.handle) && c.images?.length);
  if (ai && !ai.complete && otherComments.length) {
    try {
      const others = [];
      let n = 0;
      for (const c of otherComments) {
        if (n >= 6) break;
        const imgs = await loadImages(c.images, 6 - n);
        n += imgs.length;
        if (imgs.length) others.push({ label: `@${c.handle} 留言附的照片`, images: imgs });
      }
      if (others.length) {
        log(`缺少「${ai.missing}」，查看其他人留言的照片（${n} 張）…`);
        const found = await findMissingInComments(post, ai, others);
        for (const d of found.details || []) {
          const who = String(d.source || '').replace(/^@/, '').trim();
          const value = `${d.value}（來自${who ? ` @${who} ` : ''}的留言照片）`;
          if (!ai.details.some(x => x.label === d.label && x.value.startsWith(d.value))) ai.details.push({ label: d.label, value });
        }
        if (found.resolved) { ai.complete = true; ai.missing = ''; }
        else if (found.still_missing) ai.missing = found.still_missing;
        log(found.resolved ? '從留言照片找到了缺少的資訊' : '留言照片裡也沒有找到');
      }
    } catch (e) {
      console.log(`  查看留言照片失敗（不影響筆記）：${e.message}`);
    }
  }
  // 照片因為沒登入拿不到時，不算 incomplete，只在筆記加註記
  if (ai && !ai.complete && post.imagesHidden) {
    ai.complete = true;
    ai.missing = '';
  }
  const status = !ai ? 'unsummarized' : ai.complete ? 'complete' : 'incomplete';
  const file = noteFileName(noteTitle({ url, post, ai }), id);

  // 第二層：貼文（本文＋作者串文）裡的外部連結
  let links = [];
  if (post.links?.length && articleStore) {
    try {
      links = await processLinks(post.links, { useAi, articleStore, via: file, context: noteTitle({ url, post, ai }), previous: previous?.links || [], known, log });
      for (const l of links) if (l.file && !l.reused) known.set(urlKey(l.url), linkRecord(l));
    } catch (e) {
      log(`處理連結失敗（不影響筆記）：${e.message}`);
    }
  }

  const embed = src => embeds.get(src) || `![](${src})`;
  const { title, text } = buildNote({ id, url, post, ai, status, embed, error, links });
  log('寫入 Google Drive…');
  const driveId = await saveNote(store, file, text, previous);
  log(`完成：${status}`);
  return { title, file, driveId, status, missing: ai?.missing, imagesHidden: !!post.imagesHidden, error, links };
}

async function processSupplement(id, info, msgs, store) {
  const images = [];
  const imageFiles = [];
  const texts = [];
  for (const m of msgs) {
    if (m.text || m.caption) texts.push(m.text || m.caption);
    const fileId = m.photo ? m.photo[m.photo.length - 1].file_id : m.document?.mime_type?.startsWith('image/') ? m.document.file_id : null;
    if (!fileId) continue;
    const buffer = await telegram.downloadFile(fileId);
    const mime = m.document?.mime_type || 'image/jpeg';
    const name = `${id}-supplement-${Date.now()}-${imageFiles.length + 1}.${extOf(mime)}`;
    await store.writeAttachment(name, mime, buffer);
    imageFiles.push(name);
    images.push({ mime, buffer });
  }
  const userText = texts.join('\n').trim();
  let ai = null;
  try {
    ai = await analyzeSupplement({ title: info.title, missing: info.missing, userText }, images);
  } catch (e) {
    console.log(`  Gemini 補充分析失敗：${e.message}`);
  }
  // 找到原筆記，把補充加在最下方（檔名維持你現在的名稱）
  const ref = info.driveId ? { id: info.driveId } : info.file ? await store.findNote(info.file) : null;
  const note = ref ? await store.readNote(ref.id).catch(() => null) : null;
  if (!note) throw new Error('找不到原本的筆記（可能被刪除了）');
  await store.replaceNote(ref.id, note.name, appendSupplement(note.text, { ai, userText, imageFiles }));
  return { found: ai?.found, resolved: !!ai?.resolved };
}

async function runTest(url, useAi) {
  const outDir = path.dirname(process.env.LOCAL_OUT || 'out/Threads');
  if (args.includes('--text')) {
    console.log(await processText({ text: fs.readFileSync(url, 'utf-8') }, localStorage(path.join(outDir, TEXT_FOLDER())), { useAi }));
    return;
  }
  const links = extractLinks(url);
  if (!links.length) {
    console.log(await processWeb({ url }, localStorage(path.join(outDir, WEB_FOLDER())), { useAi }));
    return;
  }
  const res = await processLink(links[0], localStorage(), { useAi, articleStore: localStorage(path.join(path.dirname(process.env.LOCAL_OUT || 'out/Threads'), ARTICLES_FOLDER())) });
  res.links = res.links?.map(linkRecord);
  console.log(res);
}

// 舊紀錄可能是中文狀態，一併視為需要重試
const RETRY_STATUS = ['unsummarized', 'failed', '未摘要', '失敗'];
const MAX_AUTO_RETRY = 3;

// 小紅書的紀錄：AI 整理失敗時，留下文字和截圖的 file_id，之後才能自動重試
function xhsRecord(task, r, retries) {
  return {
    type: 'xhs', title: r.title, file: r.file, driveId: r.driveId || '', status: r.status, missing: r.missing || '',
    url: r.url || '', images: r.images || [], messageId: task.messageId, retries, savedAt: new Date().toISOString(),
    ...(r.status === 'unsummarized' ? { retryTask: { text: task.text, photos: task.photos, link: task.link || '' } } : {}),
  };
}

function webRecord(task, r, retries) {
  return {
    type: 'web', kind: r.kind, title: r.title, file: r.file || '', driveId: r.driveId || '', status: r.status, missing: r.missing || '',
    ...(r.reason ? { reason: r.reason } : {}),
    url: task.url, pageUrl: r.url || '', messageId: task.messageId, retries, savedAt: new Date().toISOString(),
  };
}

// 每一步前面加上經過的秒數
function stepLog() {
  const t0 = Date.now();
  return msg => console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function record(task, r, retries) {
  return {
    title: r.title, file: r.file, driveId: r.driveId || '', status: r.status, missing: r.missing || '',
    url: task.url, messageId: task.messageId, retries, savedAt: new Date().toISOString(),
    ...(r.links?.length ? { links: r.links.map(linkRecord) } : {}),
  };
}

// 網址、文字的回報
const REPLY_HINT = '回覆這則訊息貼上全文（或傳 .txt／.md 檔），就會幫你存成文章。';
function clipReport(id, r) {
  const what = { article: '文章', text: '文字' }[r.kind] || '網站';
  if (r.noNote) {
    const head =
      r.kind === 'social' ? '🔒 這個網站要登入才看得到，沒有建立筆記'
      : r.kind === 'file' ? '📎 這是檔案，沒有下載，也沒有建立筆記'
      : r.kind === 'blocked' && /HTTP (404|410)/.test(r.reason || '') ? `❌ 找不到這個網頁（${r.reason}），沒有建立筆記`
      : r.kind === 'blocked' ? `❌ 這個網站擋掉了程式${r.reason ? `（${r.reason}）` : ''}，沒有建立筆記`
      : `❌ 讀取失敗${r.reason ? `（${r.reason}）` : ''}，下次整理時會自動重試，先不建立筆記`;
    return `${head}\n${r.title || r.url}\n${REPLY_HINT}\n🆔 ${id}`;
  }
  const head =
    r.status === 'incomplete' ? `⚠️ 已存${what}，但不完整${r.missing ? `：${r.missing}` : ''}`
    : r.status === 'unsummarized' ? `📝 已存${what}（AI 整理暫時失敗）`
    : `✅ 已存${what}`;
  return `${head}\n${r.title}${r.translatedFrom ? `（從${r.translatedFrom}翻譯）` : ''}\n🆔 ${id}`;
}

function reportText(id, r) {
  const head = {
    complete: '✅ 已存',
    incomplete: `⚠️ 已存，但缺：${r.missing || '部分資訊'}`,
    unsummarized: '📝 已存原文（AI 摘要暫時失敗，下次整理時會自動重試）',
    failed: '❌ 抓不到內容，只存了連結（下次整理時會自動重試）',
  }[r.status];
  const tail =
    r.status === 'incomplete' ? '\n回覆這則訊息並附上截圖或文字，就能補充。'
    : r.imagesHidden ? '\n📷 這篇的照片沒登入看不到。想補照片的話，回覆這則訊息並附上截圖。'
    : '';
  const links = (r.links || []).map(l =>
    l.kind === 'article' && l.file ? `📄 另存文章：${l.displayTitle || l.title}${l.translatedFrom ? `（從${l.translatedFrom}翻譯）` : ''}${l.reused ? '（之前存過）' : ''}${l.status === 'incomplete' ? '⚠️ 不完整' : ''}`
    : l.kind === 'website' ? `🔧 網站摘要：${l.ai?.name || l.title || l.url}`
    : l.kind === 'video' ? `▶️ 影片：${l.title || l.url}`
    : `🔗 無法讀取：${l.title || l.url}`);
  return `${head}\n${r.title}${links.length ? `\n${links.join('\n')}` : ''}\n🆔 ${id}${tail}`;
}

async function run() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('缺少 TELEGRAM_CHAT_ID');
  const updates = await telegram.getUpdates();
  const state = await stateStore.load();
  // 讀不到的網址清單（不建筆記，只記在這裡）
  const failed = await stateStore.load('state/fetch-failed.json', '更新讀取失敗清單');
  let failedDirty = false;
  const failedAdd = (url, info) => {
    const k = urlKey(url);
    const old = failed.data[k];
    failed.data[k] = { url, ...info, firstAt: old?.firstAt || new Date().toISOString(), lastAt: new Date().toISOString(), count: (old?.count || 0) + 1 };
    failedDirty = true;
  };
  const failedRemove = url => {
    if (failed.data[urlKey(url)]) { delete failed.data[urlKey(url)]; failedDirty = true; }
  };
  const logFailedLinks = (id, r) => {
    for (const l of r.links || []) if (UNREADABLE.includes(l.kind)) failedAdd(l.url, { title: l.title || '', kind: l.kind, reason: l.reason || '', source: `threads:${id}` });
  };
  // 舊版程式替讀不到的網址建的書籤筆記：移到垃圾桶，改成記在清單裡
  const legacy = Object.entries(state.data).filter(([, v]) => v.type === 'web' && UNREADABLE.includes(v.kind) && v.driveId);
  const legacyIds = new Set(legacy.map(([id]) => id));
  // 之前「未摘要」或「失敗」的貼文，每次執行自動重試，最多 MAX_AUTO_RETRY 次
  const pending = Object.entries(state.data).filter(([id, v]) => !legacyIds.has(id) &&
    (v.type === 'xhs' ? v.status === 'unsummarized' && v.retryTask : v.url && v.type !== 'text') && RETRY_STATUS.includes(v.status) && (v.retries || 0) < MAX_AUTO_RETRY);
  console.log(`收到 ${updates.length} 則新訊息，待自動重試 ${pending.length} 篇`);
  if (!updates.length && !pending.length && !legacy.length) return;

  const linkTasks = [];
  const webTasks = [];
  const textTasks = [];
  const supplements = new Map(); // id -> messages
  const replies = [];
  let lastText = null; // 最近一篇文字，用來合併被 Telegram 拆開的長訊息
  let lastSupp = null; // 最近一則回覆補充，長文被拆開時，後續也算同一則補充
  const xhsGroups = []; // 每組：{ messages, last, textLen }
  let xhsGroup = null;
  for (const u of updates) {
    const m = u.message;
    if (!m) continue;
    if (String(m.chat.id) !== String(chatId)) {
      console.log(`忽略不是你的聊天室傳來的訊息（chat id ${m.chat.id}）`);
      continue;
    }
    const replyTag = m.reply_to_message && ID_TAG_RE.exec(m.reply_to_message.text || '');
    const raw = m.text || m.caption || '';
    // 小紅書：/xhs 開頭，之後傳的截圖和文字都算同一篇
    if (isCommand(raw, 'xhs')) {
      xhsGroup = { messages: [m], last: m.date, textLen: raw.replace(/^\/xhs\S*\s*/i, '').length };
      xhsGroups.push(xhsGroup);
      lastText = null;
      continue;
    }
    if (xhsGroup && !replyTag && m.date - xhsGroup.last <= XHS_WINDOW) {
      const isImage = m.photo?.length || m.document?.mime_type?.startsWith('image/');
      // 文字：這組還沒有文字，或是長文被 Telegram 拆開的後續
      // Threads 連結、其他網址的分享不算（那是另一則收藏）；小紅書的分享文字算
      const ml = messageLinks(m);
      const otherShare = ml.links.length || ml.shares.length || (ml.others.some(u => !isXhs(u)) && isLinkShare(m.text.replace(URL_RE, '').trim()));
      const isText = m.text && !m.text.startsWith('/') && !otherShare && (!xhsGroup.textLen || (xhsGroup.textLen >= SPLIT_MIN && m.date - xhsGroup.last <= MERGE_SECONDS));
      if (isImage || isText) {
        xhsGroup.messages.push(m);
        xhsGroup.last = m.date;
        if (m.text || m.caption) xhsGroup.textLen = (m.text || m.caption).length;
        continue;
      }
    }
    xhsGroup = null;
    // 長文被拆開的後續部分：不管多短都接回前一段，不會漏掉
    if (!replyTag && lastSupp && m.text && !m.photo && !m.document && m.date - lastSupp.date <= MERGE_SECONDS && lastSupp.chunkLen >= SPLIT_MIN) {
      supplements.get(lastSupp.id).push(m);
      lastSupp.date = m.date;
      lastSupp.chunkLen = m.text.length;
      continue;
    }
    lastSupp = null;
    if (!replyTag && lastText && m.text && !m.photo && !m.document && m.date - lastText.date <= MERGE_SECONDS && lastText.chunkLen >= SPLIT_MIN) {
      lastText.task.text += `\n${m.text}`;
      lastText.task.parts++;
      lastText.date = m.date;
      lastText.chunkLen = m.text.length;
      continue;
    }
    lastText = null;
    const { links, shares, others } = messageLinks(m);
    const plain = raw.replace(URL_RE, '').trim();
    const threadsMsg = links.length || shares.length;
    for (const s of shares) {
      try {
        const l = await resolveShare(s);
        console.log(`分享連結 ${s} → ${l.url}`);
        if (!links.some(x => x.id === l.id)) links.push(l);
      } catch (e) {
        console.log(`  ${e.message}`);
        replies.push([m.message_id, `❌ 這個分享連結打不開：${s}\n可以改傳完整的貼文網址試試。`]);
      }
    }
    if (replyTag) {
      const id = replyTag[1];
      if (!supplements.has(id)) supplements.set(id, []);
      supplements.get(id).push(m);
      lastSupp = { id, date: m.date, chunkLen: raw.length };
    } else if (threadsMsg) {
      links.forEach(l => linkTasks.push({ ...l, messageId: m.message_id }));
    } else if (others.some(isXhs)) {
      console.log(`小紅書連結：${others.filter(isXhs).map(x => x.split('?')[0]).join(' ')}`);
      replies.push([m.message_id, '⚠️ 小紅書沒辦法自動讀取（小紅書會擋掉 GitHub 的網路）。\n請輸入 /xhs，後面貼上筆記的文字（連結可以一起貼），再傳截圖，我會幫你整理。']);
    } else if (isTextDoc(m.document)) {
      try {
        const text = (await telegram.downloadFile(m.document.file_id)).toString('utf-8');
        textTasks.push({ text, messageId: m.message_id, parts: 1, fileName: m.document.file_name });
      } catch (e) {
        replies.push([m.message_id, `❌ 檔案讀取失敗：${e.message}`]);
      }
    } else if (others.length && isLinkShare(plain)) {
      others.forEach(url => webTasks.push({ url, messageId: m.message_id }));
    } else if (plain.length > TEXT_MIN) {
      const task = { text: raw, messageId: m.message_id, parts: 1 };
      textTasks.push(task);
      lastText = { task, date: m.date, chunkLen: raw.length };
    } else {
      const ents = [...(m.entities || []), ...(m.caption_entities || [])].map(e => e.type).join(',');
      console.log(`無法辨識的訊息：text=${JSON.stringify((m.text || m.caption || '').slice(0, 120))} entities=[${ents}] 欄位=[${Object.keys(m).join(',')}]`);
      replies.push([m.message_id, '把 Threads 貼文連結、文章網址，或直接貼上文章文字（超過 50 字）傳給我，我會在每天 00:00 和 12:00 整理進 Obsidian。\n很長的文字也可以存成 .txt 或 .md 檔傳給我。\n小紅書：輸入 /xhs，後面貼上筆記的文字，再傳截圖。\n要補充某一篇的話，請「回覆」那篇的通知訊息，再附上截圖或文字。']);
    }
  }

  const { storage } = require('./drive');
  const xhsTasks = [];
  for (const g of xhsGroups) {
    const t = xhs.collect(g.messages);
    if (!t.text && !t.photos.length) {
      replies.push([g.messages[0].message_id, '請在 /xhs 後面貼上小紅書筆記的文字，再傳截圖（5 分鐘內傳的截圖都會算同一篇）。']);
      continue;
    }
    xhsTasks.push({ ...t, messageId: g.messages[0].message_id });
  }

  const needDrive = linkTasks.length || webTasks.length || textTasks.length || xhsTasks.length || supplements.size || pending.length || legacy.length;
  const store = needDrive ? await storage() : null;
  const articleStore = store ? await storage(ARTICLES_FOLDER(), { lazy: true }) : null;
  const webStore = store ? await storage(WEB_FOLDER(), { lazy: true }) : null;
  const textStore = store ? await storage(TEXT_FOLDER(), { lazy: true }) : null;
  const xhsStore = store ? await storage(XHS_FOLDER(), { lazy: true }) : null;
  const known = knownArticles(state.data);

  for (const [id, v] of legacy) {
    try {
      await webStore.trashNote(v.driveId);
      console.log(`移除只有連結的書籤筆記：${v.file}`);
    } catch (e) {
      console.log(`移除書籤筆記失敗（可能已經被刪除）：${e.message}`);
    }
    // 書籤的標題是用網址拼出來的，不是文章標題，清掉（之後回覆全文時改用全文的第一行）
    state.data[id] = { ...v, title: '', file: '', driveId: '', status: v.kind === 'error' ? 'failed' : 'unreadable' };
    failedAdd(v.url, { title: v.title || '', kind: v.kind, reason: v.reason || '', source: `web:${id}` });
    replies.push([v.messageId, `🗑️ 之前替這個網址建的書籤筆記（只有連結）已經移到垃圾桶。\n${REPLY_HINT}\n🆔 ${id}`]);
  }
  if (legacy.length) await state.save();
  const seen = new Set();

  for (const task of linkTasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const prev = state.data[task.id];
    const retry = prev && RETRY_STATUS.includes(prev.status);
    if (prev && !retry) {
      replies.push([task.messageId, `這篇之前存過了：${prev.title}`]);
      continue;
    }
    console.log(`${retry ? '重新處理' : '處理'} ${task.url}`);
    try {
      const r = await processLink(task, store, { previous: retry ? prev : undefined, articleStore, known });
      logFailedLinks(task.id, r);
      state.data[task.id] = record(task, r, 0);
      await state.save();
      replies.push([task.messageId, `${retry ? '🔄 重新整理：' : ''}${reportText(task.id, r)}`]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
      replies.push([task.messageId, `❌ 處理失敗：${e.message}\n🆔 ${task.id}`]);
    }
  }

  // 直接傳的網址
  for (const task of webTasks) {
    const id = webId(task.url);
    if (seen.has(id)) continue;
    seen.add(id);
    const prev = state.data[id];
    const retry = prev && (RETRY_STATUS.includes(prev.status) || prev.status === 'unreadable');
    const other = !prev && known.get(urlKey(task.url));
    if ((prev && !retry) || other) {
      replies.push([task.messageId, `這個網址之前存過了：${(prev || other).title}`]);
      continue;
    }
    console.log(`${retry ? '重新處理' : '處理'}網址 ${task.url}`);
    try {
      const r = await processWeb(task, webStore, { previous: retry ? prev : undefined, known, log: stepLog() });
      state.data[id] = webRecord(task, r, 0);
      if (r.noNote) failedAdd(task.url, { title: r.title, kind: r.kind, reason: r.reason, source: `web:${id}` });
      else failedRemove(task.url);
      if (r.kind === 'article' && r.file && !r.reused) known.set(urlKey(task.url), state.data[id]);
      await state.save();
      replies.push([task.messageId, clipReport(id, r)]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
      replies.push([task.messageId, `❌ 處理失敗：${e.message}`]);
    }
  }

  // 直接貼的文字
  for (const task of textTasks) {
    const id = textId(task.text);
    if (seen.has(id)) continue;
    seen.add(id);
    if (state.data[id]) {
      replies.push([task.messageId, `這段文字之前存過了：${state.data[id].title}`]);
      continue;
    }
    console.log(`處理文字（${task.text.length} 字${task.parts > 1 ? `，由 ${task.parts} 則訊息合併` : ''}${task.fileName ? `，檔案 ${task.fileName}` : ''}）`);
    try {
      const r = await processText(task, textStore, { log: stepLog() });
      state.data[id] = { type: 'text', title: r.title, file: r.file, driveId: r.driveId, status: r.status, missing: r.missing || '', messageId: task.messageId, savedAt: new Date().toISOString() };
      await state.save();
      replies.push([task.messageId, clipReport(id, r)]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
      replies.push([task.messageId, `❌ 處理失敗：${e.message}`]);
    }
  }

  // 小紅書（/xhs 貼的文字和截圖）
  for (const raw of xhsTasks) {
    const task = await xhs.prepare(raw);
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const prev = state.data[task.id];
    const retry = prev && prev.status === 'unsummarized';
    if (prev && !retry) {
      replies.push([task.messageId, `這篇小紅書之前存過了：${prev.title}`]);
      continue;
    }
    console.log(`處理小紅書 ${task.id}`);
    try {
      const r = await xhs.processXhs(task, xhsStore, { previous: retry ? prev : undefined, log: stepLog() });
      state.data[task.id] = xhsRecord(task, r, 0);
      await state.save();
      replies.push([task.messageId, reportText(task.id, r)]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
      replies.push([task.messageId, `❌ 處理失敗：${e.message}`]);
    }
  }

  // 自動重試之前沒整理成功的貼文（這次已經手動重傳的就跳過）
  for (const [id, prev] of pending) {
    if (seen.has(id)) continue;
    const tries = (prev.retries || 0) + 1;
    console.log(`自動重試（第 ${tries} 次） ${prev.url || id}`);
    try {
      if (prev.type === 'xhs') {
        const task = { ...prev.retryTask, id, url: prev.url, messageId: prev.messageId };
        const r = await xhs.processXhs(task, xhsStore, { previous: prev, log: stepLog() });
        state.data[id] = xhsRecord(task, r, tries);
        await state.save();
        if (r.status !== 'unsummarized') replies.push([prev.messageId, `🔄 自動重新整理：${reportText(id, r)}`]);
        else if (tries >= MAX_AUTO_RETRY) replies.push([prev.messageId, `⏸️ 已自動重試 ${tries} 次仍未成功，之後不再自動重試。\n🆔 ${id}`]);
        continue;
      }
      if (prev.type === 'web') {
        const r = await processWeb({ url: prev.url }, webStore, { previous: prev, known, log: stepLog() });
        state.data[id] = webRecord({ url: prev.url, messageId: prev.messageId }, r, tries);
        if (r.noNote) failedAdd(prev.url, { title: r.title, kind: r.kind, reason: r.reason, source: `web:${id}` });
        else failedRemove(prev.url);
        await state.save();
        if (!RETRY_STATUS.includes(r.status)) replies.push([prev.messageId, `🔄 自動重新整理：${clipReport(id, r)}`]);
        else if (tries >= MAX_AUTO_RETRY) replies.push([prev.messageId, `⏸️ 已自動重試 ${tries} 次仍未成功，之後不再自動重試。\n🆔 ${id}`]);
        continue;
      }
      const r = await processLink({ id, url: prev.url }, store, { previous: prev, articleStore, known });
      logFailedLinks(id, r);
      state.data[id] = record({ url: prev.url, messageId: prev.messageId }, r, tries);
      await state.save();
      // 還是沒成功就不另外通知，免得每次都吵你；成功了才回報
      if (!RETRY_STATUS.includes(r.status)) replies.push([prev.messageId, `🔄 自動重新整理：${reportText(id, r)}`]);
      else if (tries >= MAX_AUTO_RETRY) replies.push([prev.messageId, `⏸️ 已自動重試 ${tries} 次仍未成功，之後不再自動重試。\n想再試的話，把這個連結重新傳給我。\n🆔 ${id}`]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
    }
  }

  for (const [id, msgs] of supplements) {
    const info = state.data[id] || { title: id, missing: '' };
    // 讀不到的網址：回覆的全文直接存成文章
    if (info.type === 'web' && !info.driveId) {
      console.log(`網址 ${info.url} 收到全文`);
      try {
        const parts = [];
        for (const m of msgs) {
          if (m.text || m.caption) parts.push(m.text || m.caption);
          if (isTextDoc(m.document)) parts.push((await telegram.downloadFile(m.document.file_id)).toString('utf-8'));
        }
        const text = parts.join('\n').trim();
        if (text.length <= TEXT_MIN) {
          replies.push([msgs[0].message_id, `請回覆貼上文章全文（超過 ${TEXT_MIN} 字），或傳 .txt／.md 檔。`]);
          continue;
        }
        const r = await processWebText({ url: cleanUrl(info.url), title: info.title }, text, webStore, { log: stepLog() });
        state.data[id] = webRecord({ url: info.url, messageId: info.messageId }, r, info.retries || 0);
        known.set(urlKey(info.url), state.data[id]);
        failedRemove(info.url);
        await state.save();
        replies.push([msgs[0].message_id, clipReport(id, r)]);
      } catch (e) {
        console.log(`  失敗：${e.stack || e.message}`);
        replies.push([msgs[0].message_id, `❌ 存檔失敗：${e.message}`]);
      }
      continue;
    }
    console.log(`補充 ${id}`);
    try {
      // 補充的截圖存到那篇筆記所在資料夾的 attachments
      const target = { xhs: xhsStore, web: webStore, text: textStore }[info.type] || store;
      const r = await processSupplement(id, info, msgs, target);
      const nowComplete = r.resolved && info.status === 'incomplete';
      if (nowComplete && state.data[id]) {
        state.data[id].status = 'complete';
        state.data[id].missing = '';
        await state.save();
      }
      replies.push([msgs[0].message_id, `✅ 已補充到「${info.title}」${r.found ? `\n${r.found}` : ''}${nowComplete ? '\n資訊補齊了，狀態已改成 complete。' : ''}`]);
    } catch (e) {
      console.log(`  失敗：${e.stack || e.message}`);
      replies.push([msgs[0].message_id, `❌ 補充失敗：${e.message}`]);
    }
  }

  if (failedDirty) {
    try { await failed.save(); } catch (e) { console.log(`更新讀取失敗清單失敗：${e.message}`); }
  }

  for (const [replyTo, text] of replies) {
    try { await telegram.send(chatId, text, replyTo); } catch (e) { console.log(`回報失敗：${e.message}`); }
  }
  if (updates.length) await telegram.confirm(updates[updates.length - 1].update_id);
  console.log('完成');
}

const args = process.argv.slice(2);
const main = args[0] === '--test' ? runTest(args[1], !args.includes('--no-ai')) : args[0] === '--diagnose' ? diagnose() : run();
main.catch(e => {
  console.error(e);
  process.exit(1);
});
