// 検索・比較用の文字列正規化。
// 全角半角・大文字小文字・ひらがなカタカナの違いを吸収する。

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchTerms(query) {
  return normalize(query).split(' ').filter(Boolean);
}

export const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
