// 組出 Obsidian 筆記（沿用 Web Clipper 的屬性格式，最上面加 AI 整理）
const ymd = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const q = s => JSON.stringify(String(s ?? '')); // YAML 雙引號字串
const quote = text => text.split('\n').map(l => `> ${l}`).join('\n');

function safeFileName(s, max = 60, fallback = 'Threads 貼文') {
  return String(s).replace(/[\\/:*?"<>|#^[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || fallback;
}

const noteTitle = ({ url, post, ai }) =>
  `Threads: ${ai?.title || (post?.main ? post.main.text.replace(/\s+/g, ' ').slice(0, 20) : `@${(url.match(/@([\w.]+)/) || [])[1] || 'unknown'}`)}`;

const langEn = code => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};

// 沒有標題時，用「網站 - 路徑」當名稱，例如「x.com - OpenAIDevs status 2112…」
const urlLabel = u => {
  try {
    const x = new URL(u);
    const p = decodeURIComponent(x.pathname).split('/').filter(Boolean).join(' ');
    return `${x.hostname.replace(/^www\./, '')}${p ? ` - ${p}` : ''}`;
  } catch { return u; }
};

// 筆記裡「讀不到」的原因用英文（Telegram 通知和紀錄維持中文）
const reasonEn = l =>
  l.kind === 'social' ? 'login required'
  : l.kind === 'file' ? 'file, not downloaded'
  : l.kind === 'blocked' ? (/HTTP \d+/.test(l.reason || '') ? l.reason : 'bot check')
  : l.kind === 'error' ? 'error while loading'
  : '';

const fmtStars = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const linkText = s => String(s || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

// Threads 筆記裡的「## Links」：每個外部連結一小段
function linksSection(links) {
  const out = ['## Links', ''];
  for (const l of links) {
    const name = linkText(l.ai?.name && l.kind === 'website' ? l.ai.name : l.displayTitle || l.title) || l.url;
    out.push(`### [${name}](${l.url})`, '');
    if (l.kind === 'article') {
      out.push(`- **Type**: Article${l.siteName ? ` · ${l.siteName}` : ''}${l.translatedFrom && l.ai?.language ? ` · translated from ${langEn(l.ai.language)}` : ''}`);
      if (l.file) out.push(`- **Full text**: [[${l.file.replace(/\.md$/, '')}]]`);
      if (l.ai) out.push(`- **Summary**: ${l.ai.one_liner}`);
    } else if (l.kind === 'website') {
      const repo = l.repo ? ` · ⭐ ${fmtStars(l.repo.stars)}${l.repo.license ? ` · ${l.repo.license}` : ''}` : '';
      out.push(`- **Type**: ${l.source === 'github' ? 'GitHub repo' : 'Website / tool'}${repo}`);
      if (l.ai) {
        out.push(`- **Summary**: ${l.ai.summary}`);
        if (l.ai.features?.length) out.push('- **Features**:', ...l.ai.features.map(f => `    - ${f}`));
      } else if (l.description) out.push(`- **Summary**: ${l.description}`);
    } else if (l.kind === 'video') {
      out.push(`- **Type**: Video${l.siteName ? ` · ${l.siteName}` : ''}${l.author ? ` · ${l.author}` : ''}`);
    } else {
      out.push(`- **Type**: Could not read${reasonEn(l) ? ` (${reasonEn(l)})` : ''}`);
    }
    out.push('');
  }
  return out;
}

function buildNote({ id, url, post, ai, status, embed = src => `![](${src})`, error, links = [] }) {
  const now = new Date();
  const main = post?.main;
  const title = noteTitle({ url, post, ai });
  const tags = ['clippings', 'threads', ...(ai?.tags || [])].map(t => t.replace(/[#\s]/g, ''));
  const fm = [
    '---',
    `title: ${q(title)}`,
    `source: ${q(url)}`,
    `author:\n  - ${q(`[[@${main?.handle || (url.match(/@([\w.]+)/) || [])[1] || ''}]]`)}`,
    `published: ${main?.datetime ? ymd(main.datetime) : '""'}`,
    `created: ${ymd(now)}`,
    `description: ${q(ai?.one_liner || '')}`,
    `tags:\n${[...new Set(tags)].map(t => `  - ${q(t)}`).join('\n')}`,
    `status: ${q(status)}`,
    ...(status === 'incomplete' && ai?.missing ? [`missing: ${q(ai.missing)}`] : []),
    `threads_id: ${q(id)}`,
    '---',
    '',
  ];
  const out = [fm.join('\n')];

  if (status === 'failed') {
    out.push(`> [!failure] Could not fetch this post\n> ${error || ''}\n> Open the source link above to view the original.`);
    return { title, text: out.join('\n') + '\n' };
  }

  if (ai) {
    out.push('## Summary', '', ai.summary, '');
    if (ai.key_points?.length) out.push('### Key Points', '', ...ai.key_points.slice(0, 3).map(p => `- ${p}`), '');
    if (ai.details?.length) out.push('### Details', '', ...ai.details.map(d => `- **${d.label}**: ${d.value}`), '');
    if (status === 'incomplete') out.push(`> [!warning] Incomplete: ${ai.missing || 'key information missing'}\n> Reply to this post's Telegram notification with a screenshot or text to add it to this note.`, '');
  } else {
    out.push(`> [!note] No AI summary yet (${error || 'Gemini did not respond'}). The original post is saved; it will be retried automatically.`, '');
  }

  if (links.length) out.push(...linksSection(links));

  out.push('## Post', '', main.text, '');
  if (main.images?.length) out.push(...main.images.map(im => embed(im.src)), '');
  if (post.imagesHidden) out.push('> [!info] This post has photos that cannot be loaded without logging in. Open the source link to see them, or reply to its Telegram notification with screenshots to add them to this note.', '');
  if (post.hasVideo) out.push('> [!info] This post contains a video. Open the source link to watch it.', '');

  if (post.chain.length) {
    out.push('## Thread', '');
    post.chain.forEach(c => out.push(c.text, '', ...(c.images || []).map(im => embed(im.src)), ...(c.images?.length ? [''] : []), '---', ''));
    out.pop(); out.pop();
    out.push('');
  }

  if (post.comments.length) {
    out.push('## Comments', '');
    for (const c of post.comments) {
      const date = c.datetime ? (c.link ? `[${ymd(c.datetime)}](${c.link})` : ymd(c.datetime)) : '';
      const who = `**@${c.handle}**${c.isAuthor ? ' (author)' : ''}${date ? ` · ${date}` : ''}`;
      // 留言附的圖片放在該則留言裡，縮小顯示，跟本文的圖分開
      const pics = (c.images || []).map(im => `![|200](${im.src})`).join(' ');
      out.push(quote(`${who}\n${c.text}${pics ? `\n${pics}` : ''}`), '');
    }
  }

  return { title, text: out.join('\n') };
}

// 補充：附加在原筆記最下方。補齊了缺少的資訊時，順便把 status 改成 complete、拿掉 Incomplete 提示
function appendSupplement(noteText, { ai, userText, imageFiles }) {
  let text = noteText.replace(/\s+$/, '');
  if (ai?.resolved) {
    text = text
      .replace(/^status: "incomplete"$/m, 'status: "complete"')
      .replace(/^missing: .*\n/m, '')
      .replace(/^> \[!warning\] Incomplete:.*\n> .*\n\n?/m, '');
  }
  const out = [''];
  if (!/^## Supplement$/m.test(text)) out.push('## Supplement', '');
  out.push(`### ${ymd(new Date())}`, '');
  if (ai) {
    if (ai.found) out.push(ai.found, '');
    if (ai.details?.length) out.push(...ai.details.map(d => `- **${d.label}**: ${d.value}`), '');
  }
  if (userText) out.push('**My notes**', '', userText, '');
  if (imageFiles.length) out.push(...imageFiles.map(f => `![[${f}]]`), '');
  return text + '\n' + out.join('\n');
}

// 從貼文連結另存的文章（存到 raw/articles 底下）
function buildArticleNote({ link, ai, content, status, missing, via, translatedFrom, translationNote }) {
  const tags = ['clippings', 'article', ...(ai?.tags || [])].map(t => t.replace(/[#\s]/g, ''));
  const title = link.displayTitle || link.title || link.url;
  const fm = [
    '---',
    `title: ${q(title)}`,
    `source: ${q(link.url)}`,
    `author:${link.author ? `\n  - ${q(link.author)}` : ' []'}`,
    `site: ${q(link.siteName || '')}`,
    `published: ${link.published && !isNaN(new Date(link.published)) ? ymd(link.published) : '""'}`,
    `created: ${ymd(new Date())}`,
    `description: ${q(ai?.one_liner || link.description || '')}`,
    `tags:\n${[...new Set(tags)].map(t => `  - ${q(t)}`).join('\n')}`,
    ...(ai?.language ? [`language: ${q(ai.language)}`] : []),
    ...(translatedFrom ? [`original_title: ${q(link.title || '')}`, 'translated: true'] : []),
    `status: ${q(status)}`,
    ...(status === 'incomplete' && missing ? [`missing: ${q(missing)}`] : []),
    ...(via ? [`via: ${q(`[[${via.replace(/\.md$/, '')}]]`)}`] : []),
    `clip_type: ${q(via ? 'threads-link' : 'link')}`,
    '---',
    '',
  ];
  const out = [fm.join('\n')];
  if (ai) {
    out.push('## Summary', '', ai.summary, '');
    if (ai.key_points?.length) out.push('### Key Points', '', ...ai.key_points.slice(0, 3).map(p => `- ${p}`), '');
  } else {
    out.push('> [!note] No AI summary (Gemini did not respond). The full text is saved below.', '');
  }
  if (translatedFrom && !translationNote) out.push(`> [!info] Translated from ${langEn(ai?.language || '') || translatedFrom} by AI. Original: [${linkText(link.title) || link.url}](${link.url})`, '');
  if (translationNote) out.push(`> [!warning] ${translationNote}`, '');
  if (link.paywalled) out.push('> [!warning] Incomplete: paywalled article, only the free preview could be read. Open the source link for the full text.', '');
  if (link.truncated) out.push('> [!info] This article is very long; only the first part is saved. Open the source link for the rest.', '');
  out.push('## Content', '', content, '');
  return { title, text: out.join('\n') };
}

// 直接傳網址、但不是文章（工具、產品、網站）：存一份短筆記
function buildWebsiteNote({ link, ai, status }) {
  const name = linkText(ai?.name || link.title) || urlLabel(link.url);
  const tags = ['clippings', 'website', ...(ai?.tags || [])].map(t => t.replace(/[#\s]/g, ''));
  const fm = [
    '---',
    `title: ${q(name)}`,
    `source: ${q(link.url)}`,
    `site: ${q(link.siteName || '')}`,
    `created: ${ymd(new Date())}`,
    `description: ${q(ai?.one_liner || link.description || '')}`,
    `tags:\n${[...new Set(tags)].map(t => `  - ${q(t)}`).join('\n')}`,
    `status: ${q(status)}`,
    `clip_type: ${q('link')}`,
    '---',
    '',
  ];
  const out = [fm.join('\n')];
  if (link.repo) {
    const r = link.repo;
    out.push(`> [!info] GitHub repo · ⭐ ${fmtStars(r.stars)}${r.license ? ` · ${r.license}` : ''}${r.language ? ` · ${r.language}` : ''}${r.homepage ? ` · [Homepage](${r.homepage})` : ''}`, '');
  }
  if (['social', 'blocked', 'error', 'file'].includes(link.kind)) {
    out.push(`> [!failure] Could not read this page${reasonEn(link) ? ` (${reasonEn(link)})` : ''}. Open the source link above to view it.`, '');
    if (link.title) out.push(`**${linkText(link.title)}**`, '');
    return { title: name, text: out.join('\n') };
  }
  if (ai) {
    out.push('## Summary', '', ai.summary, '');
    if (ai.features?.length) out.push('### Features', '', ...ai.features.map(f => `- ${f}`), '');
    if (ai.key_points?.length) out.push('### Key Points', '', ...ai.key_points.slice(0, 3).map(p => `- ${p}`), '');
  } else {
    out.push('> [!note] No AI summary (Gemini did not respond).', '');
    if (link.description) out.push(link.description, '');
  }
  if (link.kind === 'video') out.push(`> [!info] Video${link.author ? ` by ${link.author}` : ''}. Open the source link to watch it.`, '');
  return { title: name, text: out.join('\n') };
}

// 直接貼的文字：正文照存，只補屬性
function buildTextNote({ ai, content, status, translatedFrom, translationNote, fallbackTitle }) {
  const title = linkText(ai?.title) || fallbackTitle;
  const tags = ['clippings', 'text', ...(ai?.tags || [])].map(t => t.replace(/[#\s]/g, ''));
  const fm = [
    '---',
    `title: ${q(title)}`,
    `source: ${q(ai?.source_url || '')}`,
    `author:${ai?.author ? `\n  - ${q(ai.author)}` : ' []'}`,
    `published: ${ai?.published && !isNaN(new Date(ai.published)) ? ymd(ai.published) : '""'}`,
    `created: ${ymd(new Date())}`,
    `description: ${q(ai?.one_liner || '')}`,
    `tags:\n${[...new Set(tags)].map(t => `  - ${q(t)}`).join('\n')}`,
    ...(ai?.language ? [`language: ${q(ai.language)}`] : []),
    ...(translatedFrom ? ['translated: true'] : []),
    `status: ${q(status)}`,
    `clip_type: ${q('text')}`,
    '---',
    '',
  ];
  const out = [fm.join('\n')];
  if (!ai) out.push('> [!note] No AI metadata (Gemini did not respond). The text is saved as-is.', '');
  if (translatedFrom && !translationNote) out.push(`> [!info] Translated from ${langEn(ai?.language || '') || translatedFrom} by AI.`, '');
  if (translationNote) out.push(`> [!warning] ${translationNote}`, '');
  out.push('## Content', '', content, '');
  return { title, text: out.join('\n') };
}

// 小紅書：使用者貼的文字＋截圖，最上面加 AI 整理（格式跟 Threads 筆記一樣）
function buildXhsNote({ id, url, text, images, ai, status, error }) {
  const firstLine = (text || '').split('\n').find(l => l.trim()) || '截圖';
  const title = `小紅書: ${ai?.title || firstLine.trim().slice(0, 20)}`;
  const tags = ['clippings', 'xiaohongshu', ...(ai?.tags || [])].map(t => t.replace(/[#\s]/g, ''));
  const fm = [
    '---',
    `title: ${q(title)}`,
    `source: ${q(url || '')}`,
    `created: ${ymd(new Date())}`,
    `description: ${q(ai?.one_liner || '')}`,
    `tags:\n${[...new Set(tags)].map(t => `  - ${q(t)}`).join('\n')}`,
    `status: ${q(status)}`,
    ...(status === 'incomplete' && ai?.missing ? [`missing: ${q(ai.missing)}`] : []),
    `xhs_id: ${q(id)}`,
    '---',
    '',
  ];
  const out = [fm.join('\n')];
  if (ai) {
    out.push('## Summary', '', ai.summary, '');
    if (ai.key_points?.length) out.push('### Key Points', '', ...ai.key_points.slice(0, 3).map(p => `- ${p}`), '');
    if (ai.details?.length) out.push('### Details', '', ...ai.details.map(d => `- **${d.label}**: ${d.value}`), '');
    if (status === 'incomplete') out.push(`> [!warning] Incomplete: ${ai.missing || 'key information missing'}\n> Reply to this note's Telegram notification with a screenshot or text to add it to this note.`, '');
  } else {
    out.push(`> [!note] No AI summary yet (${error || 'Gemini did not respond'}). The text and screenshots are saved; it will be retried automatically.`, '');
  }
  out.push('## Post', '');
  if (text) out.push(text, '');
  if (images.length) out.push(...images.map(f => `![[${f}]]`), '');
  return { title, text: out.join('\n') };
}

const xhsFileName = (title, id) => `${safeFileName(title.replace(/^小紅書:\s*/, '小紅書 - '))} (${id.replace(/^xhs-/, '')}).md`;

const articleFileName = (title, suffix = '') => `${safeFileName(title, 80, 'Article')}${suffix ? ` (${suffix})` : ''}.md`;

// 檔名不能有冒號（Windows、Obsidian 都不允許），所以「Threads: xxx」在檔名裡寫成「Threads - xxx」
const noteFileName = (title, id) => `${safeFileName(title.replace(/^Threads:\s*/, 'Threads - '))} (${id}).md`;

module.exports = { buildNote, buildArticleNote, buildWebsiteNote, buildTextNote, buildXhsNote, xhsFileName, appendSupplement, safeFileName, noteFileName, noteTitle, articleFileName };
