// Google Drive：只用 drive.file 權限，程式只看得到、也只會動到它自己建立的檔案
const FOLDER_MIME = 'application/vnd.google-apps.folder';
let cachedToken = null;

async function accessToken() {
  if (cachedToken) return cachedToken;
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'])
    if (!process.env[k]) throw new Error(`缺少 ${k}`);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google 授權失敗：${j.error} ${j.error_description || ''}（refresh token 可能失效，請重新取得）`);
  cachedToken = j.access_token;
  return cachedToken;
}

async function api(path, opts = {}) {
  const r = await fetch(`https://www.googleapis.com${path}`, {
    signal: AbortSignal.timeout(60000),
    ...opts,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Google Drive HTTP ${r.status}：${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function find(name, parentId, folder = false) {
  let q = `name = '${esc(name)}' and trashed = false`;
  if (folder) q += ` and mimeType = '${FOLDER_MIME}'`;
  if (parentId) q += ` and '${parentId}' in parents`;
  // 同時搜尋「我的雲端硬碟」和「共用雲端硬碟」
  const params = new URLSearchParams({
    q, fields: 'files(id,name)', pageSize: '10',
    corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
  });
  const j = await api(`/drive/v3/files?${params}`);
  return j.files[0] || null;
}

async function createFolder(name, parentId) {
  return api('/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
}

async function upload(name, mime, buffer, parentId) {
  const boundary = 'threadscollector' + Date.now();
  const meta = JSON.stringify({ name, parents: [parentId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return api('/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function replace(fileId, name, mime, buffer) {
  const boundary = 'threadscollector' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return api(`/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name&supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

// 移到垃圾桶（30 天內可以從雲端硬碟救回來）；只會用在 bot 自己建立的檔案
async function trash(fileId) {
  return api(`/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

async function getText(fileId) {
  const meta = await api(`/drive/v3/files/${fileId}?fields=id,name,trashed&supportsAllDrives=true`);
  if (meta.trashed) return null;
  const r = await fetch(`https://www.googleapis.com${`/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`讀取筆記失敗：HTTP ${r.status}`);
  return { name: meta.name, text: await r.text() };
}

// 第一次執行時，在「我的雲端硬碟」最上層建立資料夾；之後你把它搬進 vault，程式一樣找得到
// lazy：等到第一次要寫入時才建立資料夾（文章資料夾用，沒有文章就不會多出空資料夾）
async function storage(rootName = process.env.DRIVE_FOLDER_NAME || 'Threads', { lazy = false } = {}) {
  let root = null;
  const rootFolder = async () => (root ||= (await find(rootName, null, true)) || (await createFolder(rootName)));
  if (!lazy) await rootFolder();
  // attachments 資料夾只在需要存圖時才建立（補充截圖，或開啟 SAVE_IMAGES）
  let att = null;
  const attFolder = async () => (att ||= (await find('attachments', (await rootFolder()).id, true)) || (await createFolder('attachments', (await rootFolder()).id)));
  return {
    exists: async (name, inAttachments = false) => !!(await find(name, inAttachments ? (await attFolder()).id : (await rootFolder()).id)),
    writeNote: async (name, text) => upload(name, 'text/markdown', Buffer.from(text, 'utf-8'), (await rootFolder()).id),
    // 只會用在 bot 自己建立、狀態是「未摘要」或「失敗」的筆記
    findNote: async name => find(name, (await rootFolder()).id),
    readNote: fileId => getText(fileId),
    replaceNote: (fileId, name, text) => replace(fileId, name, 'text/markdown', Buffer.from(text, 'utf-8')),
    writeAttachment: async (name, mime, buffer) => upload(name, mime, buffer, (await attFolder()).id),
    trashNote: fileId => trash(fileId),
  };
}

module.exports = { storage };
