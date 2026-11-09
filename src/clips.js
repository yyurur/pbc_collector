// Threads 以外的收藏：直接傳的網址（文章或網站），以及直接貼的文字
const crypto = require('crypto');
const { readLinks } = require('./web');
const { analyzeText, analyzeLink, translateMarkdown } = require('./gemini');
const { classify, saveArticle, urlKey, langName, KEEP_LANGS } = require('./links');
const { buildWebsiteNote, buildTextNote, articleFileName } = require('./note');
const { isSimplified, s2t } = require('./zh');

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const webId = url => `web-${hash(urlKey(url))}`;
const textId = text => `text-${hash(String(text).replace(/\s+/g, ' ').trim())}`;
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const UNREADABLE = ['social', 'blocked', 'error', 'file'];

async function writeOrReplace(store, file, text, previous, suffix) {
  if (previous?.driveId) {
    try {
      return { file, driveId: (await store.replaceNote(previous.driveId, file, text)).id || previous.driveId };
    } catch (e) {
      console.log(`  覆蓋舊筆記失敗，改為新增：${e.message}`);
    }
  }
  if (await store.exists(file)) file = file.replace(/\.md$/, ` (${suffix}).md`);
  const r = await store.writeNote(file, text);
  return { file, driveId: r?.id || '' };
}

// 直接傳的網址：文章存全文，工具／網站存一份短筆記；讀不到的不建筆記（等使用者回覆全文）
async function processWeb({ url }, store, { useAi = true, previous, known = new Map(), log = console.log } = {}) {
  const [page] = await readLinks([{ url }], log);
  if (UNREADABLE.includes(page.kind)) {
    // error（逾時、網站暫時錯誤）之後會自動重試；被擋、要登入、檔案不重試
    return { kind: page.kind, title: page.title || '', status: page.kind === 'error' ? 'failed' : 'unreadable', reason: page.reason || '', url: page.url, noNote: true };
  }
  const entry = await classify(page, { useAi, context: '（使用者直接傳的連結）', log });
  if (entry.kind === 'article') {
    const prev = previous?.driveId ? [{ url: page.url, driveId: previous.driveId }] : [];
    const r = await saveArticle(page, entry, { useAi, articleStore: store, via: '', previous: prev, known, log });
    return { kind: 'article', title: r.displayTitle || page.title || url, file: r.file, driveId: r.driveId, status: r.status, translatedFrom: r.translatedFrom, reused: r.reused, url: page.url };
  }
  const status = entry.kind === 'video' || entry.ai ? 'complete' : 'unsummarized';
  const { title, text } = buildWebsiteNote({ link: entry, ai: entry.ai, status });
  const saved = await writeOrReplace(store, articleFileName(title), text, previous, hostOf(page.url) || webId(url));
  log(`存網站筆記：${saved.file}`);
  return { kind: entry.kind, title, ...saved, status, reason: entry.reason, url: page.url };
}

// 直接貼的文字：正文照存（必要時翻譯或簡轉繁），Gemini 只補標題、標籤等屬性
async function processText({ text }, store, { useAi = true, log = console.log } = {}) {
  let content = String(text).trim();
  let ai = null;
  if (useAi) {
    try {
      log(`Gemini 整理文字屬性（${content.length} 字）…`);
      ai = await analyzeText(content);
    } catch (e) {
      log(`Gemini 失敗：${e.message}`);
    }
  }
  const lang = String(ai?.language || '').toLowerCase().split(/[-_]/)[0];
  let status = ai ? 'complete' : 'unsummarized';
  let translatedFrom = '';
  let translationNote = '';
  if (useAi && lang && !KEEP_LANGS.includes(lang)) {
    try {
      content = await translateMarkdown(content, langName(lang), log);
      translatedFrom = langName(lang);
    } catch (e) {
      log(`翻譯失敗，改存原文：${e.message}`);
      translationNote = `Translation failed (${e.message.slice(0, 100)}). The original text is saved below.`;
      status = 'incomplete';
    }
  } else if (isSimplified(content)) {
    content = s2t(content);
    log('簡體轉繁體');
  }
  const firstLine = content.split('\n').find(l => l.trim()) || '文字筆記';
  const fallbackTitle = s2t(firstLine.replace(/^#+\s*/, '').trim().slice(0, 30));
  const { title, text: note } = buildTextNote({ ai, content, status, translatedFrom, translationNote, fallbackTitle });
  const id = textId(text);
  const saved = await writeOrReplace(store, articleFileName(title), note, null, id.replace(/^text-/, ''));
  log(`存文字筆記：${saved.file}`);
  return { kind: 'text', title, ...saved, status, translatedFrom, missing: translationNote ? '翻譯' : '' };
}

// 網站讀不到，使用者回覆貼上全文：存成文章筆記（保留原網址，照樣摘要、翻譯、簡轉繁）
async function processWebText({ url, title }, text, store, { useAi = true, log = console.log } = {}) {
  const content = String(text).trim();
  const firstLine = (content.split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').trim();
  const page = {
    kind: 'article', url, title: title || (firstLine.length <= 150 ? firstLine : ''), siteName: hostOf(url),
    content, markers: { ogType: '（使用者貼上的全文）', ldTypes: [] }, textLength: content.length,
  };
  const entry = { ...page };
  delete entry.content;
  if (useAi) {
    try {
      log(`Gemini 整理全文（${content.length} 字）…`);
      entry.ai = await analyzeLink(page, '（網站讀不到，使用者自己貼上全文）');
    } catch (e) {
      log(`Gemini 失敗：${e.message}`);
    }
  }
  if (!page.title) page.title = entry.ai?.translated_title || hostOf(url) || '文章';
  const r = await saveArticle(page, entry, { useAi, articleStore: store, via: '', previous: [], known: new Map(), log });
  return { kind: 'article', title: r.displayTitle || page.title, file: r.file, driveId: r.driveId, status: r.status, translatedFrom: r.translatedFrom, url };
}

module.exports = { processWeb, processWebText, processText, webId, textId, UNREADABLE };
