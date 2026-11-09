// 貼文裡的外部連結：打開 → 判斷類型 → 文章另存一份筆記（必要時先翻譯），工具／網站只寫摘要
const { readLinks } = require('./web');
const { analyzeLink, translateMarkdown } = require('./gemini');
const { buildArticleNote, articleFileName } = require('./note');
const { isSimplified, s2t } = require('./zh');

// 這些語言的文章照原文存，其他語言先翻譯成繁體中文
const KEEP_LANGS = ['zh', 'en', 'ko'];
const MAX_TRANSLATE = 60000; // 超過這個長度只翻譯前段
const MIN_ARTICLE = 800; // 正文太短就不算文章

const langEn = code => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};
const langName = code => {
  try { return new Intl.DisplayNames(['zh-TW'], { type: 'language' }).of(code) || code; } catch { return code; }
};
const urlKey = u => String(u || '').replace(/^http:/, 'https:').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// options：
//   useAi        是否呼叫 Gemini
//   articleStore 文章資料夾（Google Drive 或本機）
//   via          Threads 筆記的檔名（文章筆記會連回去）
//   context      Threads 筆記標題，給 Gemini 參考
//   previous     這篇貼文上次處理時的連結紀錄（重新整理時覆蓋同一份文章筆記）
//   known        其他貼文已經存過的文章（網址 → { file, driveId }），不重複存
async function processLinks(links, { useAi = true, articleStore, via, context = '', previous = [], known = new Map(), log = console.log }) {
  if (!links?.length) return [];
  log(`打開貼文裡的 ${links.length} 個連結…`);
  const pages = await readLinks(links, msg => log(msg));
  const out = [];
  for (const page of pages) {
    const entry = await classify(page, { useAi, context, log });
    try {
      if (entry.kind === 'article') Object.assign(entry, await saveArticle(page, entry, { useAi, articleStore, via, previous, known, log }));
    } catch (e) {
      log(`連結處理失敗（不影響貼文筆記）：${e.message}`);
      entry.reason = entry.reason || e.message.slice(0, 120);
    }
    out.push(entry);
  }
  return out;
}

// Gemini 整理並決定類型：GitHub repo 一律是工具；其他以 Gemini 的判斷為準，沒有就用網頁標記；太短的不算文章
async function classify(page, { useAi = true, context = '', log = console.log }) {
  const entry = { ...page };
  delete entry.content;
  if (useAi && page.content && ['article', 'website', 'text'].includes(page.kind)) {
    try {
      log(`Gemini 整理連結：${page.title || page.url}`);
      entry.ai = await analyzeLink(page, context);
    } catch (e) {
      log(`Gemini 整理連結失敗：${e.message}`);
    }
  }
  if (page.source === 'github') entry.kind = 'website';
  else if (['article', 'website', 'text'].includes(page.kind)) entry.kind = entry.ai?.kind || (page.kind === 'text' ? 'website' : page.kind);
  if (entry.kind === 'article' && (page.content || '').length < MIN_ARTICLE) entry.kind = 'website';
  return entry;
}

async function saveArticle(page, entry, { useAi, articleStore, via, previous, known, log }) {
  const ai = entry.ai;
  const lang = String(ai?.language || '').toLowerCase().split(/[-_]/)[0];
  let content = page.content;
  let translatedFrom = '';
  let translationNote = '';
  let status = ai ? 'complete' : 'unsummarized';
  let missing = '';
  if (useAi && lang && !KEEP_LANGS.includes(lang)) {
    const name = langName(lang);
    try {
      const cut = content.lastIndexOf('\n\n', MAX_TRANSLATE);
      const part = content.length > MAX_TRANSLATE ? content.slice(0, cut > 0 ? cut : MAX_TRANSLATE) : content;
      content = await translateMarkdown(part, name, log);
      translatedFrom = name;
      if (part.length < page.content.length) {
        translationNote = `Translated from ${langEn(lang)} by AI. The article is very long, so only the first part was translated and saved. Original: ${page.url}`;
      }
    } catch (e) {
      log(`翻譯失敗，改存原文：${e.message}`);
      translationNote = `Translation from ${langEn(lang)} failed (${e.message.slice(0, 100)}). The original text is saved below.`;
      status = 'incomplete';
      missing = '翻譯';
    }
  }
  // 簡體中文的文章轉成繁體（只轉字形）
  let converted = false;
  if (!translatedFrom && isSimplified(content)) {
    content = s2t(content);
    converted = true;
    log('簡體轉繁體');
  }
  if (page.paywalled) {
    status = 'incomplete';
    missing = missing ? `${missing}、付費全文` : '付費全文（只有試閱段落）';
  }
  const displayTitle = translatedFrom && ai?.translated_title ? ai.translated_title : converted ? s2t(page.title || '') : page.title;
  const link = { ...page, displayTitle };

  // 其他貼文已經存過這篇文章：直接連過去，不重複存
  const prev = previous.find(p => urlKey(p.url) === urlKey(page.url) && p.driveId);
  const other = !prev && known.get(urlKey(page.url));
  if (other) {
    log(`這篇文章之前存過了：${other.file}`);
    return { displayTitle, translatedFrom, file: other.file, driveId: other.driveId, status: other.status, reused: true };
  }
  const { text } = buildArticleNote({ link, ai, content, status, missing, via, translatedFrom, translationNote });
  let file = articleFileName(displayTitle);
  if (prev) {
    try {
      const r = await articleStore.replaceNote(prev.driveId, file, text);
      log(`更新文章筆記：${file}`);
      return { displayTitle, translatedFrom, file, driveId: r.id || prev.driveId, status };
    } catch (e) {
      log(`覆蓋舊文章筆記失敗，改為新增：${e.message}`);
    }
  }
  // 同名檔案已存在（不同文章剛好同標題）時，檔名加上網站名稱
  if (await articleStore.exists(file)) file = articleFileName(displayTitle, hostOf(page.url));
  const r = await articleStore.writeNote(file, text);
  log(`另存文章：${file}${translatedFrom ? `（從${translatedFrom}翻譯）` : ''}`);
  return { displayTitle, translatedFrom, file, driveId: r?.id || '', status };
}

// 存進處理紀錄的精簡版本
const linkRecord = l => ({ url: l.url, kind: l.kind, title: l.displayTitle || l.title || '', ...(l.file ? { file: l.file, driveId: l.driveId || '', status: l.status } : {}) });

module.exports = { processLinks, classify, saveArticle, linkRecord, urlKey, langName, KEEP_LANGS };
