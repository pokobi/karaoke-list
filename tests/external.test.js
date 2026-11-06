import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentUrl, opensInBrowserApp } from '../js/external.js';

test('外のページの URL を、Android のインテントの URL にする', () => {
  const url = 'https://duckduckgo.com/?kl=jp-jp&q=%E9%9F%B3%E5%9F%9F';
  assert.equal(intentUrl(url),
    `intent://duckduckgo.com/?kl=jp-jp&q=%E9%9F%B3%E5%9F%9F#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(url)};end`);
  // 「#」以降はインテントの指定と重なるので使わない
  assert.match(intentUrl('https://example.com/a?b=1#top'), /^intent:\/\/example\.com\/a\?b=1#Intent;scheme=https;/);
  assert.match(intentUrl('http://example.com/'), /scheme=http;/);
  assert.equal(intentUrl('javascript:alert(1)'), null);
  assert.equal(intentUrl('not a url'), null);
});

test('ブラウザの外（テストの環境）では、インテントでは開かない', () => {
  assert.equal(opensInBrowserApp(), false);
});
