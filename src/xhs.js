// 小紅書：程式讀不到小紅書網頁（會被擋），改由使用者在 Telegram 用 /xhs 貼上文字和截圖
const crypto = require('crypto');
const telegram = require('./telegram');
const { analyzeXhs } = require('./gemini');
const { buildXhsNote, xhsFileName } = require('./note');

const XHS_URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:xhslink\.com|xiaohongshu\.com)\/[^\s<>"'）」』】]+/i;
// App 分享文字的固定句子，存檔時拿掉
const SHARE_NOISE = /复制后打开【小红书】查看笔记[！!]?|復製後打開【小紅書】查看筆記[！!]?|打开【小红书】.*?查看[^\n]*|快来看吧[！!]?\s*😆?/g;
const MAX_IMAGES = 10;

// 短網址轉成乾淨的貼文網址（不帶你的帳號 ID、分享追蹤參數）。只看轉址的位置，不打開頁面
async function cleanUrl(url) {
  let u = url.replace(/^http:/, 'https:');
  for (let i = 0; i < 4; i++) {
    const id = (u.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i) || [])[1];
    if (id) return { noteId: id, url: `https://www.xiaohongshu.com/explore/${id}` };
    try {
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const loc = r.headers.get('location');
      if (!loc) break;
      u = new URL(loc, u).href;
    } catch {
      break;
    }
  }
  return { noteId: '', url: url.split('?')[0] };
}

// 把 /xhs 這一組訊息整理成：文字、圖片 file_id、網址
function collect(messages) {
  const texts = [];
  const photos = [];
  let link = '';
  for (const m of messages) {
    let t = m.text || m.caption || '';
    t = t.replace(/^\/xhs(@\w+)?\s*/i, '');
    const found = t.match(XHS_URL_RE);
    if (found && !link) link = found[0];
    t = t.replace(XHS_URL_RE, '').replace(SHARE_NOISE, '').trim();
    if (t) texts.push(t);
    if (m.photo?.length) photos.push({ fileId: m.photo[m.photo.length - 1].file_id, uniqueId: m.photo[m.photo.length - 1].file_unique_id, mime: 'image/jpeg' });
    else if (m.document?.mime_type?.startsWith('image/')) photos.push({ fileId: m.document.file_id, uniqueId: m.document.file_unique_id, mime: m.document.mime_type });
  }
  return { text: texts.join('\n'), photos, link };
}

const extOf = mime => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] || 'jpg';

// 先算出 ID 和乾淨的網址（用來判斷是不是存過了）
async function prepare(task) {
  const { noteId, url } = task.link ? await cleanUrl(task.link) : { noteId: '', url: '' };
  return { ...task, id: xhsId(task, noteId), url };
}

// task：prepare() 的結果；previous：之前 unsummarized 的紀錄（重試時覆蓋同一篇）
async function processXhs(task, store, { useAi = true, previous, log = console.log } = {}) {
  const { id, url } = task;
  const images = [];
  const files = previous?.images || [];
  const saveFiles = !files.length;
  for (const [i, p] of task.photos.slice(0, MAX_IMAGES).entries()) {
    try {
      const buffer = await telegram.downloadFile(p.fileId);
      images.push({ mime: p.mime, buffer });
      if (saveFiles) {
        const name = `${id}-${i + 1}.${extOf(p.mime)}`;
        await store.writeAttachment(name, p.mime, buffer);
        files.push(name);
      }
    } catch (e) {
      log(`截圖 ${i + 1} 下載失敗：${e.message}`);
    }
  }
  log(`小紅書：文字 ${task.text.length} 字、截圖 ${images.length} 張${url ? `、網址 ${url}` : ''}`);
  let ai = null;
  let error;
  if (useAi) {
    try {
      log('Gemini 整理中…');
      ai = await analyzeXhs(task.text, images);
    } catch (e) {
      error = e.message;
      log(`Gemini 失敗：${e.message}`);
    }
  }
  const status = !ai ? 'unsummarized' : ai.complete ? 'complete' : 'incomplete';
  const { title, text } = buildXhsNote({ id, url, text: task.text, images: files, ai, status, error });
  const file = xhsFileName(title, id);
  let driveId = '';
  if (previous?.driveId) {
    try { driveId = (await store.replaceNote(previous.driveId, file, text)).id || previous.driveId; } catch (e) { log(`覆蓋舊筆記失敗，改為新增：${e.message}`); }
  }
  if (!driveId) driveId = (await store.writeNote(file, text))?.id || '';
  log(`完成：${status}`);
  return { id, title, file, driveId, status, missing: ai?.missing || '', url, images: files };
}

// 有貼文網址就用貼文 ID，沒有就用文字和截圖算出一個固定的 ID（同樣內容不會重複存）
function xhsId(task, noteId) {
  if (noteId) return `xhs-${noteId}`;
  const key = task.text.replace(/\s+/g, ' ').trim() + task.photos.map(p => p.uniqueId).join(',');
  return `xhs-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

module.exports = { processXhs, prepare, collect, cleanUrl };
