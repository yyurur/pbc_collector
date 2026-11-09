// Telegram Bot API：拿新訊息、回報結果、下載使用者傳的圖片
const token = () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('缺少 TELEGRAM_BOT_TOKEN');
  return process.env.TELEGRAM_BOT_TOKEN;
};

async function call(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method} 失敗：${j.description}`);
  return j.result;
}

// Telegram 會保留未確認的訊息 24 小時
const getUpdates = () => call('getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message'] });

// 確認已處理到 lastId，之後就不會再收到這些訊息
const confirm = lastId => call('getUpdates', { offset: lastId + 1, limit: 1, timeout: 0 });

// 靜音通知，半夜不會吵
const send = (chatId, text, replyTo) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    disable_notification: true,
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });

async function downloadFile(fileId) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${token()}/${f.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`下載 Telegram 檔案失敗：HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { getUpdates, confirm, send, downloadFile };
