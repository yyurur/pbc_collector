// 「哪些貼文處理過了」記在 GitHub repo 的 state/processed.json（不放在 Google Drive）
// 讀不到的網址另外記在 state/fetch-failed.json
const fs = require('fs');
const path = require('path');

function local(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  return { data, save: async () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); } };
}

async function load(PATH = 'state/processed.json', message = '更新處理紀錄') {
  const repo = process.env.GITHUB_REPOSITORY;
  const tok = process.env.GITHUB_TOKEN;
  if (!repo || !tok) return local(PATH === 'state/processed.json' ? process.env.LOCAL_STATE || 'out/processed.json' : path.join('out', path.basename(PATH)));
  const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' };
  const url = `https://api.github.com/repos/${repo}/contents/${PATH}`;
  let sha;
  let data = {};
  const r = await fetch(url, { headers });
  if (r.ok) {
    const j = await r.json();
    sha = j.sha;
    data = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
  } else if (r.status !== 404) {
    throw new Error(`讀取處理紀錄失敗：HTTP ${r.status}`);
  }
  return {
    data,
    save: async () => {
      const body = {
        message,
        content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'),
        ...(sha ? { sha } : {}),
      };
      const w = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!w.ok) throw new Error(`寫入處理紀錄失敗：HTTP ${w.status} ${(await w.text()).slice(0, 200)}`);
      sha = (await w.json()).content.sha;
    },
  };
}

module.exports = { load };
