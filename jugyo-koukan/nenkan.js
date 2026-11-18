/* 年間行事の文字列(PDFから取り出したテキスト)を、カレンダーの行事に変換する。UI非依存。
 * ブラウザでは window.NK、Node では module.exports として公開。
 *
 * 読み取れる書き方
 *   1) 日付が行頭にある行:  「4/8 始業式」「4月8日(水) 入学式」「10/21~10/23 文化祭」「5月1日~5日 中間考査」
 *   2) 月の見出し + 日・曜日の行(カレンダー表を文字にしたもの):  「4月」の次に「8 水 始業式」
 * 年は年度の開始年(4月始まり)から決める: 4〜12月は開始年、1〜3月は翌年。
 */
(function (root) {
  'use strict';
  const WD = '月火水木金土日';
  const pad = (n) => String(n).padStart(2, '0');
  const validDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  const yearOf = (fy, m) => (m >= 4 ? fy : fy + 1);
  const ymd = (fy, m, d) => { const y = yearOf(fy, m); return validDate(y, m, d) ? y + '-' + pad(m) + '-' + pad(d) : null; };

  const normalize = (s) => String(s).normalize('NFKC').replace(/[〜~–—−]/g, '~').replace(/[ 　\t]+/g, ' ');

  // 授業がなくなる行事を示す語(初期値の推定。取り込み画面で変更できる)
  const CANCEL_RE = /休業|休校|休み|始業式|終業式|入学式|卒業式|修了式|離任式|着任式|開講式|文化祭|学園祭|学校祭|体育祭|運動会|球技大会|スポーツ大会|考査|試験|テスト|遠足|校外学習|修学旅行|研修旅行|宿泊|講演会|進路|説明会|健康診断|身体測定|避難訓練|芸術鑑賞|表彰|生徒総会|三者面談|面談|保護者会|大掃除|マラソン|持久走|インターンシップ|職場体験|オリエンテーション|模試|合唱/;
  const HOLIDAY_RE = /^(元日|成人の日|建国記念|天皇誕生日|春分の日|昭和の日|憲法記念日|みどりの日|こどもの日|海の日|山の日|敬老の日|秋分の日|スポーツの日|体育の日|文化の日|勤労感謝の日|振替休日|国民の休日|祝日)/;

  function classify(title) {
    const t = normalize(title);
    const sw = t.match(/([月火水木金])曜(?:日)?(?:課|時間割|授業)/);
    if (sw) return { type: 'dayswap', swapDay: WD.indexOf(sw[1]) + 1 };
    if (HOLIDAY_RE.test(t)) return { type: 'holiday' };
    if (CANCEL_RE.test(t)) return { type: 'cancel' };
    return { type: 'note' };
  }
  function scopeOf(title) {
    const ys = [...new Set([...normalize(title).matchAll(/([123])\s*年/g)].map((m) => m[1]))];
    return ys.length === 1 ? ys[0] : 'all';
  }
  function periodsOf(title) {
    const t = normalize(title);
    let m = t.match(/([1-6])\s*~\s*([1-6])\s*限/);
    if (m) { const r = []; for (let p = +m[1]; p <= +m[2]; p++) r.push(p); return r; }
    m = t.match(/([1-6](?:\s*[・,、]\s*[1-6])*)\s*限/);
    return m ? m[1].split(/[・,、]/).map((x) => +x.trim()) : [];
  }

  const DATE_AT_START = /^[\s・•●○◎■□▲△*※\-]*(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*日?\s*(?:[(（][月火水木金土日祝][)）])?\s*(?:~\s*(?:(\d{1,2})\s*(?:月|\/)\s*)?(\d{1,2})\s*日?\s*(?:[(（][月火水木金土日祝][)）])?)?/;
  const DAY_ROW = /^(\d{1,2})\s*[(（]?\s*([月火水木金土日])\s*[)）]?(?:\s+(.*))?$/;
  const MONTH_HEAD = /^(\d{1,2})\s*月\s*$/;

  function parseText(text, fy) {
    const out = [];
    let curMonth = 0;
    const lines = normalize(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const push = (date, endDate, title, line) => {
      title = title.replace(/^[\s:：\-・]+/, '').replace(/\s+/g, ' ').trim();
      if (!date || !title) return;
      const c = classify(title);
      const it = { date, title, type: c.type, scope: scopeOf(title), periods: [], include: c.type !== 'holiday', line };
      if (endDate && endDate > date) it.endDate = endDate;
      if (c.swapDay) it.swapDay = c.swapDay;
      if (c.type === 'cancel') it.periods = periodsOf(title);
      out.push(it);
    };
    for (const line of lines) {
      const mh = line.match(MONTH_HEAD);
      if (mh && +mh[1] >= 1 && +mh[1] <= 12) { curMonth = +mh[1]; continue; }
      const m = line.match(DATE_AT_START);
      if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
        const mo = +m[1];
        const date = ymd(fy, mo, +m[2]);
        let end = null;
        if (m[4]) { const em = m[3] ? +m[3] : mo; end = ymd(fy, em, +m[4]); }
        push(date, end, line.slice(m[0].length), line);
        curMonth = mo;
        continue;
      }
      const dr = curMonth && line.match(DAY_ROW);
      if (dr && +dr[1] >= 1 && +dr[1] <= 31) push(ymd(fy, curMonth, +dr[1]), null, dr[3] || '', line);
    }
    return out;
  }

  // 取り込み画面の1行を、アプリの行事データに変換する
  function toEvent(it, id) {
    const type = it.type === 'holiday' ? 'note' : it.type;
    const ev = { id, date: it.date, type, title: it.title, scope: it.scope || 'all' };
    if (it.endDate && it.endDate > it.date) ev.endDate = it.endDate;
    if (type === 'cancel') ev.periods = it.periods || [];
    if (type === 'dayswap') ev.swapDay = it.swapDay || 1;
    return ev;
  }

  // pdf.js の getTextContent().items(文字片と座標)を、行ごとの文字列にする
  function itemsToLines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5] / 3) * 3, x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, w: it.width || 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const p of r.parts) { if (end !== null && p.x - end > 3) s += ' '; s += p.s; end = p.x + p.w; }
      return s.trim();
    }).filter(Boolean);
  }

  const api = { parseText, toEvent, classify, itemsToLines, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NK = api;
})(typeof window !== 'undefined' ? window : globalThis);
