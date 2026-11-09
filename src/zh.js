// 簡體中文 → 繁體中文（只轉字形，不改用詞，所以不會改到原文的意思）
const OpenCC = require('opencc-js');

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
};

// 判斷是不是簡體：轉成繁體時變動的字，要明顯多於轉成簡體時變動的字
// （繁體文章轉繁體幾乎不會變；簡體文章轉繁體會變很多）
function isSimplified(text) {
  const sample = String(text || '').slice(0, 5000);
  const toTrad = diff(sample, s2t(sample));
  const toSimp = diff(sample, t2s(sample));
  return toTrad >= 5 && toTrad > toSimp * 2;
}

const toTraditional = text => (isSimplified(text) ? s2t(text) : text);

module.exports = { isSimplified, toTraditional, s2t };

if (require.main === module) {
  for (const x of ['这个软件的信息发布后，皇后很高兴。我们一起去学习吧，这是一个很长的句子。', '這個軟體的資訊發佈後，皇后很高興。我們一起去學習吧，這是一個很長的句子。'])
    console.log(isSimplified(x), toTraditional(x));
}
