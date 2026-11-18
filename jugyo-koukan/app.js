/* 授業交換ナビ UI */
(function () {
  'use strict';
  const { addDays, dow, fmtMD, dateRange, diffDays } = JK.util;
  const KEY = 'jugyo-koukan-v1';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const DAYN = ['', '月', '火', '水', '木', '金'];

  /* ---------- 状態 ---------- */
  function fresh() {
    const D = JSON.parse(JSON.stringify(window.DEFAULT_DATA));
    return { teachers: D.teachers, lessons: D.lessons, unavailable: D.unavailable, lockedSubjects: D.lockedSubjects, subRoles: D.subRoles || [], events: [], absences: [], history: [], settings: JK.defaultSettings(), tables: [], tablePeriods: [] };
  }
  // A案(別の時間割)を取り込み、期間指定の枠を用意する。既存データ(履歴・欠勤など)はそのまま。
  function ensureTables(s) {
    const D = JSON.parse(JSON.stringify(window.DEFAULT_DATA));
    if (!Array.isArray(s.tables)) s.tables = [];
    if (!Array.isArray(s.tablePeriods)) s.tablePeriods = [];
    for (const t of D.altTables || []) if (!s.tables.some((x) => x.id === t.id)) {
      for (const tt of D.altTeachers || []) if (!s.teachers.some((x) => x.id === tt.id || x.name === tt.name)) s.teachers.push(tt);
      for (const r0 of D.altSubRoles || []) if (!s.subRoles.some((x) => x.tid === r0.tid && x.subj === r0.subj && x.cls === r0.cls)) s.subRoles.push(r0);
      s.tables.push(t);
    }
    return s;
  }
  // クラス指定のない副担当(旧形式)を、その先生がその科目を教えている各クラスの指定に展開する
  function normSub(s) {
    s.subRoles = s.subRoles || [];
    if (!s.subRoles.some((r) => !r.cls)) return;
    const out = [];
    for (const r of s.subRoles) {
      if (r.cls) { out.push(r); continue; }
      [...new Set(s.lessons.filter((l) => l.t === r.tid && l.s === r.subj).map((l) => l.c))].forEach((c) => out.push({ tid: r.tid, subj: r.subj, cls: c }));
    }
    s.subRoles = out;
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.teachers && s.lessons) { if (!s.subRoles) s.subRoles = JSON.parse(JSON.stringify(window.DEFAULT_DATA.subRoles || [])); normSub(s); ensureTables(s); s.settings = Object.assign(JK.defaultSettings(), s.settings || {}); s.settings.weights = Object.assign(JK.defaultSettings().weights, s.settings.weights || {}); return s; } } catch (e) { /* ignore */ }
    return ensureTables(fresh());
  }
  let S = load();
  if (!S.teachers.length) setTimeout(() => { ui.tab = 'settings'; render(); }, 0);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } };
  const ui = { tab: 'plan', today: todayStr(), plans: null, month: todayStr().slice(0, 7), selDate: todayStr(), cell: null, sel: new Set(), absForm: null, mr: { mode: 'swap', a: '', bDate: '', bPeriod: '', lid: '', by: '', msg: '', bad: false }, nk: { fy: (() => { const d = new Date(); return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1; })(), text: '', items: null, msg: '' } };
  const ukey = (u) => u.date + '|' + u.period + '|' + u.cls; // 要対応コマの識別子(チェックの保存に使う)
  const tName = (id) => { const t = S.teachers.find((x) => x.id === id); return t ? t.name : id; };
  const tShort = (id) => tName(id).split(' ')[0];
  function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2400); }

  /* ---------- タブ ---------- */
  const TABS = [['plan', '交換案'], ['absence', '欠勤登録'], ['calendar', 'カレンダー・行事'], ['lessons', '授業一覧・変更可否'], ['history', '履歴・バランス'], ['settings', '設定']];
  // 時間割データが入っていないとき(公開用ビルドの初回起動など)の案内
  const emptyNotice = () => `<div class="card"><h2>データがまだ入っていません</h2><p>このアプリには、先生の名前や時間割は入っていません。いつも使っているPC(またはブラウザ)の授業交換ナビで「設定」→「データを表示(コピー用)」を押し、出てきた文字列をコピーして、この端末の「設定」タブの一番下の欄に貼り付け、「貼り付けから読み込む(全て置き換え)」を押してください。データはこの端末の中にだけ保存されます。</p><div class="row"><button class="b" data-tab="settings">設定タブを開く</button></div></div>`;
  function render() {
    $('#tabs').innerHTML = TABS.map(([k, n]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${n}</button>`).join('');
    // 再描画しても、表示位置(ページと表のスクロール)を保つ。保存や選択のたびに先頭へ戻らないようにする。
    const keep = { x: window.scrollX, y: window.scrollY, tab: render.tab, sc: [...document.querySelectorAll('.scroll')].map((e) => [e.scrollLeft, e.scrollTop]) };
    const v = (!S.teachers.length && ui.tab !== 'settings') ? emptyNotice() : { plan: vPlan, absence: vAbsence, calendar: vCalendar, lessons: vLessons, history: vHistory, settings: vSettings }[ui.tab]();
    $('#view').innerHTML = v;
    if (keep.tab === ui.tab) {
      document.querySelectorAll('.scroll').forEach((e, i) => { if (keep.sc[i]) { e.scrollLeft = keep.sc[i][0]; e.scrollTop = keep.sc[i][1]; } });
      try { window.scrollTo(keep.x, keep.y); } catch (e) { /* ignore */ }
    }
    render.tab = ui.tab;
  }

  /* ---------- 共通部品 ---------- */
  const slotTxt = (d, p) => `${fmtMD(d)}${p}限`;
  const unitTxt = (u) => u.lessons.map((l) => `${esc(l.subj)}(${esc(tShort(l.tid))}${l.sub ? '・副' : ''})`).join('・');
  const periodsHtml = (name, sel) => [1, 2, 3, 4, 5, 6].map((p) => `<label class="inl"><input type="checkbox" name="${name}" value="${p}" ${sel && sel.includes(p) ? 'checked' : ''}>${p}</label>`).join('');
  const teacherOpts = (sel) => S.teachers.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  /* ---------- 交換案 ---------- */
  function vPlan() {
    const st = S.settings;
    const ctx = JK.makeCtx(S);
    const units = JK.affectedUnits(ctx, ui.today);
    const absCount = S.absences.filter((a) => a.date >= ui.today).length;
    let h = ui.copyText ? `<div class="card"><h2>コピー用テキスト</h2><textarea id="copybox" rows="8" style="width:100%">${esc(ui.copyText)}</textarea><div class="mut">選択してコピーしてください。</div></div>` : '';
    h += `<div class="card"><h2>1. 条件</h2>
      <div class="row">
        <label>基準日(これ以前は対象外)<input type="date" id="today" value="${ui.today}"></label>
        <label>交換期間(授業日以内)<input type="number" min="0" max="60" id="s-win" value="${st.windowDays}"></label>
        <label class="inl"><input type="checkbox" id="s-learn" ${st.learn ? 'checked' : ''}>履歴から交換の傾向を学習して反映する</label>
        <label class="inl"><input type="checkbox" id="s-chain" ${st.chain ? 'checked' : ''}>他の授業も交換して成立させる(連鎖交換)</label>
        <label class="inl"><input type="checkbox" id="s-before" ${st.allowBefore ? 'checked' : ''}>欠勤日より前の授業とも交換する</label>
        <label>交換できないとき<select id="s-cover">
          <option value="swap" ${st.coverMode === 'swap' ? 'selected' : ''}>交換のみ(補欠なし)</option>
          <option value="fallback" ${st.coverMode === 'fallback' ? 'selected' : ''}>交換不可のときだけ補欠・合同</option>
          <option value="equal" ${st.coverMode === 'equal' ? 'selected' : ''}>補欠・合同も交換と同列で比較</option></select></label>
        <label>交換する週<select id="s-week">
          <option value="prefer" ${st.weekMode === 'prefer' ? 'selected' : ''}>同じ週(月〜金)の中を優先</option>
          <option value="only" ${st.weekMode === 'only' ? 'selected' : ''}>同じ週の中だけ</option>
          <option value="off" ${st.weekMode === 'off' ? 'selected' : ''}>週は気にしない</option></select></label>
        <label>同じ日に同じクラスで同じ科目が重なる交換<select id="s-same">
          <option value="forbid" ${st.sameDay === 'forbid' ? 'selected' : ''}>しない(候補から外す)</option>
          <option value="penalty" ${st.sameDay === 'penalty' ? 'selected' : ''}>避けるが、他に無ければ可(減点)</option>
          <option value="allow" ${st.sameDay === 'allow' ? 'selected' : ''}>気にしない</option></select></label>
      </div>
      <div class="mut">${learnStatus()}</div>
      <div class="mut">欠勤は「欠勤登録」、行事による授業なし・日課変更は「カレンダー・行事」、動かせない授業や先生は「授業一覧・変更可否」で設定します。</div></div>`;
    const skip = new Set(S.skipUnits || []);
    const nOn = units.filter((u) => !skip.has(ukey(u))).length;
    h += `<div class="card"><h2>2. 要対応の授業 <span class="mut">(${units.length}コマ中 ${nOn}コマを変更する)</span></h2>
      ${units.length ? '<div class="mut">授業変更が必要なコマにチェックを入れてください。チェックを外したコマ(自習・他の先生が対応済みなど)は交換案の対象にしません。</div><div class="row"><button class="b sm sec" data-act="unitsAll">すべてチェック</button><button class="b sm sec" data-act="unitsNone">すべて外す</button></div>' : ''}`;
    if (!absCount) h += `<p class="mut">基準日以降の欠勤が未登録です。「欠勤登録」から追加してください。</p>`;
    else if (!units.length) h += `<p class="ok">欠勤日に授業はありません(行事で授業なし、または交換・補欠済み)。</p>`;
    else h += units.map((u) => { const ins = ctx.slot(u.date, u.period).filter((x) => x.cls === u.cls); return `<div style="${skip.has(ukey(u)) ? 'opacity:.55' : ''}"><label class="inl" style="display:inline-flex"><input type="checkbox" data-unit="${esc(ukey(u))}" ${skip.has(ukey(u)) ? '' : 'checked'}><span class="slot abs">${slotTxt(u.date, u.period)}</span></label> ${esc(u.cls)} ${ins.map((x) => `${esc(x.subj)} <span class="${ctx.isAbsent(x.tid, u.date, u.period) ? 'bad' : ''}">${esc(tShort(x.tid))}${ctx.isAbsent(x.tid, u.date, u.period) ? '(欠勤)' : ''}</span>`).join('、')}</div>`; }).join('');
    h += `<div class="row"><button class="b" data-act="propose" ${nOn ? '' : 'disabled'}>交換案を${st.maxPlans}つ作る</button></div></div>`;
    if (ui.plans) {
      h += `<h2 style="margin:6px 2px">3. 交換案</h2>`;
      if (!ui.plans.length) h += `<div class="card">案がありません。</div>`;
      else {
        // 左側: 従来のスコア順。右側: 同じ案を、交換される先生(欠勤の先生を除く)の空き時間が多い順に並べ替える。
        const order = ui.plans.map((_, i) => i).sort((a, b) => {
          const fa = ui.plans[a].stats.free, fb = ui.plans[b].stats.free;
          return ((fb.list.length ? fb.avg : -1) - (fa.list.length ? fa.avg : -1)) || (ui.plans[a].cost - ui.plans[b].cost);
        });
        h += `<div class="sides"><div class="side"><h3 class="sidehead">左側: スコアが小さい順(従来)</h3><div class="mut">近い日・少ない交換・先生の負担の少なさを総合した点数で並べています。</div>`
          + ui.plans.map((pl, i) => planCard(pl, i, { n: i + 1, label: `第${pl.rank}案` })).join('')
          + `</div><div class="side"><h3 class="sidehead">右側: 交換される先生の空き時間が多い順</h3><div class="mut">左側と同じ案を、交換で授業を受け持つ先生(欠勤の先生は除く)のその日の空きコマの平均が多い順に並べ替えています。</div>`
          + order.map((i, n) => planCard(ui.plans[i], i, { n: n + 1, label: `右 第${n + 1}位 <span class="mut">(左側では第${ui.plans[i].rank}案)</span>` })).join('')
          + '</div></div>';
      }
    }
    return h;
  }
  function learnStatus() {
    const lp = JK.learnProfile(S);
    if (!S.settings.learn) return '履歴からの学習: オフ';
    if (lp.n < 3) return `履歴からの学習: 履歴の交換が${lp.n}件のため、まだ使っていません(3件以上で反映します)。`;
    return `履歴からの学習: 過去の交換${lp.n}件の傾向を反映しています(反映の強さ ${Math.round(lp.conf * 100)}%。10件で最大)。各案の「履歴との近さ」が高いほど、これまでのやり方に近い案です。`;
  }
  function planCard(pl, i, side) {
    side = side || { n: i + 1, label: `第${pl.rank}案` };
    const s = pl.stats;
    const fr = s.free;
    const freeLine = fr.list.length
      ? `<div class="res">交換される先生の空き時間(交換前→後): 平均 <b>${fr.avg.toFixed(1)}</b>→${fr.avgAfter.toFixed(1)}コマ ／ ${fr.list.map((f) => `${esc(tShort(f.tid))} ${fmtMD(f.date)} ${f.before}→${f.after}`).join('、')}</div>` : '';
    const chips = [`交換${s.swaps}件` + (s.chain ? `(うち連鎖の前提${s.chain}件)` : ''), s.swaps ? (s.crossWeek ? `別の週へ${s.crossWeek}件` : '全て同じ週内') : '', s.covers ? `補欠${s.covers}件` : '', s.merges ? `合同${s.merges}件` : '', s.swaps ? `平均${s.avgDays.toFixed(1)}授業日差(最大${s.maxDays})` : '', `関わる先生${s.teachers.length}名`].filter(Boolean).map((c) => `<span class="chip">${c}</span>`).join('');
    const bad = s.unresolved ? `<span class="chip a">未解決${s.unresolved}件(手動調整が必要)</span>` : '';
    let h = `<div class="card plan p${side.n}"><h2>${side.label}<span class="score">スコア ${pl.cost}</span></h2><div>${chips}${bad}</div>${freeLine}`;
    pl.items.forEach((it, n) => {
      const a = it.a;
      h += `<div class="item"><b>${n + 1}.</b> ${it.aux ? `<span class="chip">連鎖の前提交換</span> <span class="slot">${slotTxt(a.date, a.period)}</span> ${esc(a.cls)} ${unitTxt(a)}` : `<span class="slot abs">${slotTxt(a.date, a.period)}</span> ${esc(a.cls)} ${unitTxt(a)}<span class="bad">(${it.absTids.map(tShort).join('・')} 欠勤)</span>`}`;
      if (it.kind === 'swap') {
        const b = it.b;
        h += `<span class="arrow">⇄</span><span class="slot">${slotTxt(b.date, b.period)}</span> ${unitTxt(b)} と交換
          <div class="res">→ ${slotTxt(a.date, a.period)}は ${unitTxt(b)} / ${slotTxt(b.date, b.period)}は ${unitTxt(a)} を実施(${it.dayDist === 0 ? '同日' : it.dayDist + '授業日差'})${it.learn != null ? ` / 履歴との近さ ${it.learn}%` : ''}</div>${it.aux ? `<div class="res">※ ${it.aux.frees.map(tShort).join('・')}先生を${slotTxt(it.aux.date, it.aux.period)}に空け、次の交換を成立させるための交換です</div>` : ''}${it.dup ? '<div class="res warn">⚠ 同じ日に同じクラスで同じ科目が2コマになります</div>' : ''}`;
      } else if (it.kind === 'cover') h += `<div class="res">→ 補欠: <b>${esc(tName(it.by))}</b> が担当(授業の移動なし)</div>`;
      else if (it.kind === 'merge') h += `<div class="res">→ 合同: 同じコマの <b>${it.partners.map(tName).join('・')}</b> が両グループを担当(移動なし)</div>`;
      else h += `<div class="res bad">→ 条件に合う交換・補欠がありません。期間・変更可否・補欠設定を見直してください。</div>`;
      h += `</div>`;
    });
    h += `<div class="row"><button class="b" data-act="adopt" data-i="${i}">この案を採用して履歴に残す</button><button class="b sec" data-act="copy" data-i="${i}">文章をコピー</button></div></div>`;
    return h;
  }
  function planText(pl) {
    return `【授業交換案 第${pl.rank}案】\n` + pl.items.map((it, n) => {
      const a = it.a; const h = `${n + 1}. ${slotTxt(a.date, a.period)} ${a.cls} ${a.lessons.map((l) => l.subj + '(' + tName(l.tid) + ')').join('・')}(${it.absTids.map(tName).join('・')} 欠勤)`;
      if (it.kind === 'swap') return `${h}\n   ⇄ ${slotTxt(it.b.date, it.b.period)} ${it.b.lessons.map((l) => l.subj + '(' + tName(l.tid) + ')').join('・')} と交換`;
      if (it.kind === 'cover') return `${h}\n   → 補欠: ${tName(it.by)}`;
      if (it.kind === 'merge') return `${h}\n   → 合同: ${it.partners.map(tName).join('・')}`;
      return `${h}\n   → 未解決`;
    }).join('\n');
  }

  /* ---------- 欠勤登録 ---------- */
  function vAbsence() {
    const f = ui.absForm || { tid: (S.teachers[0] || {}).id, from: ui.today, to: '', all: true, periods: [] };
    const ctx = JK.makeCtx(S);
    const sorted = S.absences.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let h = `<div class="card"><h2>欠勤の登録</h2>
      <div class="row">
        <label>先生<select id="af-t">${teacherOpts(f.tid)}</select></label>
        <label>開始日<input type="date" id="af-from" value="${f.from}"></label>
        <label>終了日(1日だけなら空)<input type="date" id="af-to" value="${f.to}"></label>
      </div>
      <div class="row">
        <label class="inl"><input type="radio" name="af-m" value="all" ${f.all ? 'checked' : ''}>終日(1日ごと)</label>
        <label class="inl"><input type="radio" name="af-m" value="per" ${f.all ? '' : 'checked'}>時限を指定(1時間ごと)</label>
        <span class="pers">${periodsHtml('af-p', f.periods)}</span>
      </div>
      <div class="row"><label>メモ<input id="af-note" size="30" placeholder="年休・出張など(任意)"></label><button class="b" data-act="addAbs">欠勤を追加</button></div>
      <div class="mut">期間を指定した場合は、授業のある平日(祝日・行事で授業なしの日を除く)ごとに1件ずつ登録されます。</div></div>`;
    h += `<div class="card"><h2>登録済みの欠勤 <span class="mut">(${sorted.length}件)</span></h2>`;
    if (!sorted.length) h += '<p class="mut">まだありません。</p>';
    else {
      h += '<table><tr><th>日付</th><th>先生</th><th>範囲</th><th>該当する授業</th><th>メモ</th><th></th></tr>';
      for (const a of sorted) {
        const ps = a.periods && a.periods.length ? a.periods : [1, 2, 3, 4, 5, 6];
        const ls = []; ps.forEach((p) => ctx.slot(a.date, p).forEach((x) => { if (x.tid === a.tid) ls.push(`${p}限 ${esc(x.cls)} ${esc(x.subj)}`); }));
        h += `<tr><td>${fmtMD(a.date)}</td><td>${esc(tName(a.tid))}</td><td>${a.periods && a.periods.length ? a.periods.join('・') + '限' : '終日'}</td><td>${ls.join('<br>') || '<span class="mut">授業なし</span>'}</td><td>${esc(a.note || '')}</td><td><button class="b del" data-act="delAbs" data-id="${a.id}">削除</button></td></tr>`;
      }
      h += '</table>';
    }
    return h + '</div>';
  }

  /* ---------- カレンダー・行事 ---------- */
  const EVT = { cancel: '授業なし', dayswap: '日課変更(他曜日の時間割)', note: 'メモのみ' };
  function vCalendar() {
    const ctx = JK.makeCtx(S);
    const [y, m] = ui.month.split('-').map(Number);
    const first = `${ui.month}-01`;
    const startOff = (dow(first) + 6) % 7; // 月曜始まり
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let h = `<div class="card"><div class="row"><button class="b sec sm" data-act="mprev">◀</button><b style="font-size:17px">${y}年${m}月</b><button class="b sec sm" data-act="mnext">▶</button><button class="b sec sm" data-act="mtoday">今月</button><span class="mut kbhint">キーボード: ←→ 日 / ↑↓ 週 / PageUp・PageDown 月 / Home 今日</span></div>`;
    const histDates = new Set();
    S.history.forEach((e) => (e.moves || []).forEach((m) => [m.fromDate, m.toDate, m.date].forEach((d) => { if (d) histDates.add(d); })));
    h += '<div class="cal">' + ['月', '火', '水', '木', '金', '土', '日'].map((d) => `<div class="h">${d}</div>`).join('');
    for (let i = 0; i < startOff; i++) h += '<div></div>';
    for (let d = 1; d <= days; d++) {
      const ds = `${ui.month}-${String(d).padStart(2, '0')}`;
      const info = ctx.dayInfo(ds);
      const off = info.w === 0;
      const na = new Set(S.absences.filter((a) => a.date === ds).map((a) => a.tid)).size;
      h += `<div class="d ${off ? 'off' : ''} ${ds === ui.selDate ? 'sel' : ''} ${ds === todayStr() ? 'today' : ''}" data-date="${ds}"><b>${d}</b>`
        + (info.holiday ? '<span class="ev h">祝日</span>' : '')
        + info.events.map((e) => `<span class="ev ${e.type === 'cancel' ? 'x' : ''}">${esc(e.title || EVT[e.type])}</span>`).join('')
        + (na ? `<span class="ev x">欠勤${na}名</span>` : '') + (histDates.has(ds) ? '<span class="ev">交換あり</span>' : '') + '</div>';
    }
    h += '</div></div>';
    h += mrCard(ctx);
    h += nkCard();
    h += dayPanel(ctx);
    return h;
  }
  /* ---------- 過去の交換・補欠の記録(カレンダーの選択日から) ---------- */
  const PROB = { 'teacher-dup': '先生の授業が重なっています', 'room-dup': '教室が重なっています', 'absent-has-lesson': '欠勤の先生に授業が残っています', unavailable: '勤務なしの時間に授業が入っています', 'class-dup': '移動先に同じクラスの授業も入っています' };
  function mrCard(ctx) {
    const m = ui.mr, ds = ui.selDate, info = ctx.dayInfo(ds);
    let h = `<div class="card"><h2>過去の交換・補欠を記録 <span class="mut">(${fmtMD(ds)}を基準に)</span></h2>
      <div class="mut">上のカレンダーで、休みの先生の授業があった日をクリックして選び、その授業と、入れ替えた相手の授業を指定します。記録すると履歴と負担のバランスに加わり、時間割にも反映されます(取り消しは「履歴・バランス」から)。</div>`;
    if (info.w === 0) return h + `<p class="mut">${info.holiday ? '祝日' : '休日'}のため授業がありません。授業のある日を選んでください。</p></div>`;
    const units = [], seen = new Set();
    for (let p = 1; p <= 6; p++) for (const x of ctx.slot(ds, p)) { const k = p + '|' + x.cls; if (seen.has(k)) continue; seen.add(k); units.push({ p, cls: x.cls, ins: ctx.slot(ds, p).filter((y) => y.cls === x.cls) }); }
    const uLabel = (u) => `${u.p}限 ${u.cls} ${u.ins.map((x) => x.subj + '(' + tShort(x.tid) + ')').join('・')}`;
    h += `<div class="row"><label class="inl"><input type="radio" name="mr-mode" data-mr="mode" value="swap" ${m.mode === 'swap' ? 'checked' : ''}>授業を入れ替えた</label><label class="inl"><input type="radio" name="mr-mode" data-mr="mode" value="cover" ${m.mode === 'cover' ? 'checked' : ''}>補欠に入った</label><label class="inl"><input type="radio" name="mr-mode" data-mr="mode" value="move" ${m.mode === 'move' ? 'checked' : ''}>移動</label></div>`;
    if (m.mode === 'move') {
      // 移動は同じクラスでもまとめず、授業(先生)ごとに選ぶ
      const flat = []; units.forEach((u) => u.ins.forEach((x) => flat.push({ p: u.p, x })));
      const sel = flat.find((f) => f.p + '|' + f.x.lid === m.a) || null;
      const au = sel ? { p: sel.p, cls: sel.x.cls } : null;
      const bd = m.bDate || ds;
      let popts = '';
      if (au && ctx.dayInfo(bd).w >= 1) for (let p = 1; p <= 6; p++) if (!(bd === ds && p === au.p)) { const ex = ctx.slot(bd, p).filter((x) => x.cls === au.cls); popts += `<option value="${p}" ${String(m.bPeriod) === String(p) ? 'selected' : ''}>${p}限(${ex.length ? esc(au.cls) + 'の授業あり: ' + ex.map((x) => esc(x.subj) + '(' + esc(tShort(x.tid)) + ')').join('・') : esc(au.cls) + 'の授業なし'})</option>`; }
      h += `<div class="row"><label>移動する授業(${fmtMD(ds)})<select data-mr="a"><option value="">選んでください</option>${flat.map((f) => `<option value="${esc(f.p + '|' + f.x.lid)}" ${m.a === f.p + '|' + f.x.lid ? 'selected' : ''}>${f.p}限 ${esc(f.x.cls)} ${esc(f.x.subj)}(${esc(tShort(f.x.tid))})${f.x.room ? ' ' + esc(f.x.room) : ''}</option>`).join('')}</select></label>
        <label>移動先の日付<input type="date" data-mr="bDate" value="${bd}"></label>
        <label>移動先の時限<select data-mr="bPeriod"><option value="">${!au ? '先に左の授業を選んでください' : ctx.dayInfo(bd).w < 1 ? '授業日ではありません' : popts ? '選んでください' : '空いている時限がありません'}</option>${popts}</select></label></div>`;
    } else if (m.mode === 'swap') {
      const au = units.find((u) => u.p + '|' + u.cls === m.a) || null;
      let bopts = '';
      const bd = m.bDate || ds; // 未入力なら休みの先生の授業日。日付ピッカーも今日ではなくこの日の月で開く
      if (au && bd) { for (let p = 1; p <= 6; p++) { const ins = ctx.slot(bd, p).filter((x) => x.cls === au.cls); if (ins.length && !(bd === ds && p === au.p)) bopts += `<option value="${p}" ${String(m.bPeriod) === String(p) ? 'selected' : ''}>${p}限 ${esc(au.cls)} ${ins.map((x) => esc(x.subj) + '(' + esc(tShort(x.tid)) + ')').join('・')}</option>`; } }
      h += `<div class="row"><label>休みの先生の授業(${fmtMD(ds)})<select data-mr="a"><option value="">選んでください</option>${units.map((u) => `<option value="${u.p}|${esc(u.cls)}" ${m.a === u.p + '|' + u.cls ? 'selected' : ''}>${esc(uLabel(u))}</option>`).join('')}</select></label>
        <label>入れ替えた相手の日付(交換授業日)<input type="date" data-mr="bDate" value="${bd}"></label>
        <label>相手の授業(同じクラス)<select data-mr="bPeriod"><option value="">${au && bd ? (bopts ? '選んでください' : '同じクラスの授業がありません') : '先に左の2つを選んでください'}</option>${bopts}</select></label></div>`;
    } else {
      const flat = []; units.forEach((u) => u.ins.forEach((x) => flat.push({ p: u.p, x })));
      h += `<div class="row"><label>補欠になった授業(${fmtMD(ds)})<select data-mr="lid"><option value="">選んでください</option>${flat.map((f) => `<option value="${esc(f.p + '|' + f.x.lid)}" ${m.lid === f.p + '|' + f.x.lid ? 'selected' : ''}>${f.p}限 ${esc(f.x.cls)} ${esc(f.x.subj)}(${esc(tShort(f.x.tid))})</option>`).join('')}</select></label>
        <label>補欠に入った先生<select data-mr="by"><option value="">選んでください</option>${S.teachers.map((t) => `<option value="${t.id}" ${m.by === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label></div>`;
    }
    h += `<div class="row"><button class="b" data-act="mrAdd">履歴に記録する</button></div>${m.msg ? `<div class="${m.bad ? 'warn' : 'ok'}">${esc(m.msg)}</div>` : ''}</div>`;
    return h;
  }

  /* ---------- 年間行事のPDF取り込み ---------- */
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  function loadScript(src) { return new Promise((ok, ng) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ng(new Error('読み込み用の部品を取得できませんでした(オンラインで開いてください)')); document.head.appendChild(s); }); }
  async function loadPdfJs() {
    if (window.pdfjsLib) return;
    await loadScript(PDFJS + 'pdf.min.js');
    await loadScript(PDFJS + 'pdf.worker.min.js'); // 先に読み込んでおくと、別のWorkerを作らずに動く
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  }
  async function readPdf(file) {
    const n = ui.nk;
    n.msg = 'PDFを読み込んでいます…'; render();
    try {
      await loadPdfJs();
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const lines = [];
      for (let p = 1; p <= pdf.numPages; p++) { const tc = await (await pdf.getPage(p)).getTextContent(); lines.push(...NK.itemsToLines(tc.items)); }
      n.text = lines.join('\n');
      n.items = lines.length ? NK.parseText(n.text, n.fy) : null;
      n.msg = lines.length ? `${pdf.numPages}ページから${lines.length}行の文字を取り出しました。` : '文字を取り出せませんでした(画像だけのPDFの可能性があります)。文字を貼り付けて読み取ることもできます。';
    } catch (e) { n.msg = 'PDFを読み込めませんでした: ' + (e && e.message ? e.message : e) + ' 文字を下の欄に貼り付けて「読み取る」を押すこともできます。'; }
    render();
  }
  function nkCard() {
    const n = ui.nk;
    const sel = (i, f, v, opts) => `<select data-nk="${i}|${f}">${opts.map(([val, lab]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${lab}</option>`).join('')}</select>`;
    let h = `<div class="card"><h2>年間行事をPDFから読み込む</h2>
      <div class="mut">年間行事予定のPDF(文字が入っているもの)を選ぶと、日付と行事名を読み取って一覧にします。内容を確認・修正してから、カレンダーに追加します。画像だけのPDFや読み取れないときは、下の欄に文字を貼り付けて「読み取る」を押してください。</div>
      <div class="row"><label>年度(4月の年)<input type="number" id="nk-fy" min="2000" max="2100" value="${n.fy}"></label><label>PDFファイル<input type="file" id="nk-file" accept=".pdf,application/pdf"></label></div>
      ${n.msg ? `<div class="mut">${esc(n.msg)}</div>` : ''}
      <label>PDFから取り出した文字(貼り付けも可。「4/8 始業式」「4月8日(水) 入学式」のように行の先頭に日付があると読み取れます)<textarea id="nk-text" rows="6" style="width:100%">${esc(n.text)}</textarea></label>
      <div class="row"><button class="b sm" data-act="nkParse">読み取る</button></div>`;
    if (n.items) {
      if (!n.items.length) h += '<p class="warn">行事を読み取れませんでした。日付が行の先頭にある形に整えてみてください。</p>';
      else {
        const on = n.items.filter((x) => x.include).length;
        h += `<h3>読み取った行事 <span class="mut">(${n.items.length}件中 ${on}件を追加)</span></h3>
          <div class="mut">種類は行事名から自動で推定しています。授業がなくなるものは「授業なし」にしてください。祝日は自動で授業なしになるため、初期状態では外してあります。</div>
          <div class="row"><button class="b sm sec" data-act="nkAll">すべて選ぶ</button><button class="b sm sec" data-act="nkNone">すべて外す</button><button class="b sm" data-act="nkAdd" ${on ? '' : 'disabled'}>選んだ行事をカレンダーに追加</button></div>
          <div class="scroll" style="max-height:60vh"><table><tr><th>追加</th><th>日付</th><th>終了日</th><th>行事名</th><th>種類</th><th>対象</th><th>授業なしの時限</th></tr>`
          + n.items.map((it, i) => `<tr><td><input type="checkbox" data-nk="${i}|include" ${it.include ? 'checked' : ''}></td><td><input type="date" data-nk="${i}|date" value="${it.date}"></td><td><input type="date" data-nk="${i}|endDate" value="${it.endDate || ''}"></td><td><input data-nk="${i}|title" value="${esc(it.title)}" size="26"></td>`
            + `<td>${sel(i, 'type', it.type, [['cancel', '授業なし'], ['dayswap', '日課変更'], ['note', 'メモのみ'], ['holiday', '祝日(追加しない)']])}${it.type === 'dayswap' ? ' ' + sel(i, 'swapDay', it.swapDay || 1, [1, 2, 3, 4, 5].map((d) => [d, DAYN[d] + '曜の時間割'])) : ''}</td>`
            + `<td>${sel(i, 'scope', it.scope || 'all', [['all', '全校'], ['1', '1年'], ['2', '2年'], ['3', '3年']])}</td><td><input data-nk="${i}|periods" size="6" value="${(it.periods || []).join(',')}" placeholder="終日"></td></tr>`).join('')
          + '</table></div>';
      }
    }
    return h + '</div>';
  }
  function dayPanel(ctx) {
    const ds = ui.selDate; const info = ctx.dayInfo(ds); const evs = info.events;
    let h = `<div class="card"><h2>${fmtMD(ds)} の行事・日課</h2>`;
    h += evs.length ? evs.map((e) => `<div class="row"><span class="chip ${e.type === 'cancel' ? 'a' : ''}">${EVT[e.type]}</span><b>${esc(e.title)}</b><span class="mut">${e.date}${e.endDate ? '〜' + e.endDate : ''} / 対象:${e.scope === 'all' || !e.scope ? '全体' : esc(e.scope)}${e.type === 'cancel' ? ' / ' + (e.periods && e.periods.length ? e.periods.join('・') + '限' : '終日') : ''}${e.type === 'dayswap' ? ' / ' + DAYN[e.swapDay] + '曜日の時間割' : ''}</span><button class="b del" data-act="delEv" data-id="${e.id}">削除</button></div>`).join('') : '<p class="mut">この日の行事は未登録です。</p>';
    h += `<h3>行事を追加</h3><div class="row">
      <label>種類<select id="ev-type"><option value="cancel">授業なし(学校行事・考査など)</option><option value="dayswap">日課変更(別の曜日の時間割で実施)</option><option value="note">メモのみ</option></select></label>
      <label>名称<input id="ev-title" placeholder="例: 文化祭"></label>
      <label>開始日<input type="date" id="ev-from" value="${ds}"></label>
      <label>終了日(空=1日)<input type="date" id="ev-to"></label>
      <label>対象<select id="ev-scope"><option value="all">全校</option><option value="1">1年</option><option value="2">2年</option><option value="3">3年</option>${['2-1', '2-2', '3-1', '3-2'].map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>使う曜日の時間割(日課変更)<select id="ev-sd">${[1, 2, 3, 4, 5].map((i) => `<option value="${i}">${DAYN[i]}曜</option>`).join('')}</select></label></div>
      <div class="row"><span class="mut">授業なしにする時限(未選択=終日):</span><span class="pers">${periodsHtml('ev-p', [])}</span><button class="b" data-act="addEv">行事を追加</button></div>`;
    h += '</div>';
    // 当日の実際の時間割(先生×時限)
    h += `<div class="card"><h2>${fmtMD(ds)} の時間割(行事・欠勤・交換履歴を反映) <span class="chip">${esc(TNAME(info.table))}</span></h2>`;
    if (info.w === 0) h += `<p class="mut">${info.holiday ? '祝日' : '休日'}のため授業なし。</p>`;
    else {
      h += `<div class="mut">${info.swapped ? '日課変更: ' + DAYN[info.w] + '曜日の時間割で実施。' : ''} 赤=欠勤 / グレー=勤務なし / 斜線=授業なし(行事) / 青枠=交換・補欠済み</div><div class="scroll"><table><tr><th></th>${S.teachers.map((t) => `<th>${esc(tShort(t.id))}</th>`).join('')}</tr>`;
      for (let p = 1; p <= 6; p++) {
        const sl = ctx.slot(ds, p);
        h += `<tr><th>${p}限</th>` + S.teachers.map((t) => {
          const xs = sl.filter((x) => x.tid === t.id);
          const ab = ctx.isAbsent(t.id, ds, p), un = ctx.isUnavail(t.id, ds, p);
          const cls = ab ? 'abs' : un ? 'gray' : '';
          const txt = xs.map((x) => `<div class="s">${esc(x.subj)}${x.moved || x.covered ? ' ⇄' : ''}</div><div class="c">${esc(x.cls)}${x.room ? ' ' + esc(x.room) : ''}</div>`).join('');
          return `<td class="${cls}">${txt}</td>`;
        }).join('') + '</tr>';
      }
      h += '</table></div>';
    }
    return h + '</div>';
  }

  /* ---------- 授業一覧・変更可否 ---------- */
  const subOf = (l) => S.subRoles.some((r) => r.tid === l.t && r.subj === l.s && (!r.cls || r.cls === l.c));
  // 副担当はクラス単位。on=true で副担当に、false で担当に戻す。
  function setSub(tid, subj, cls, on) { normSub(S); S.subRoles = S.subRoles.filter((r) => !(r.tid === tid && r.subj === subj && r.cls === cls)); if (on) S.subRoles.push({ tid, subj, cls }); }
  // 同じコマを複数の先生で受け持つ組(科目×先生の組み合わせ)を一覧し、担当/副担当を選べる表
  function teamTable() {
    const isSub = (t, g) => S.subRoles.some((r) => r.tid === t && r.subj === g.subj && (!r.cls || r.cls === g.cls));
    const units = new Map();
    for (const l of S.lessons.concat(...(S.tables || []).map((q) => q.lessons))) { const k = (/^[A-Za-z]+:/.test(l.id) ? l.id.split(':')[0] : 'B') + l.d + '-' + l.p + '-' + l.c; if (!units.has(k)) units.set(k, []); units.get(k).push(l); }
    const groups = new Map();
    for (const arr of units.values()) {
      const by = new Map();
      arr.forEach((l) => { if (!by.has(l.s)) by.set(l.s, []); by.get(l.s).push(l); });
      for (const [subj, ls] of by) {
        const tids = [...new Set(ls.map((l) => l.t))].sort((a, b) => S.teachers.findIndex((t) => t.id === a) - S.teachers.findIndex((t) => t.id === b));
        if (tids.length < 2) continue;
        const k = subj + '|' + arr[0].c + '|' + tids.join(',');
        if (!groups.has(k)) groups.set(k, { subj, tids, cls: arr[0].c, n: 0 });
        groups.get(k).n++;
      }
    }
    if (!groups.size) return '<p class="mut">複数の先生で受け持つ授業はありません。</p>';
    const rows = [...groups.values()].sort((a, b) => a.subj.localeCompare(b.subj, 'ja') || a.cls.localeCompare(b.cls, 'ja')).map((g) => {
      const subs = g.tids.filter((t) => isSub(t, g)).length;
      return `<tr><td>${esc(g.subj)}</td><td>${esc(g.cls)}</td><td>週${g.n}コマ</td>` + g.tids.map((t) => {
        const sub = isSub(t, g);
        return `<td>${esc(tShort(t))} <select data-subsel="${t}|${esc(g.subj)}|${esc(g.cls)}"><option value="m" ${sub ? '' : 'selected'}>担当</option><option value="s" ${sub ? 'selected' : ''}>副担当</option></select></td>`;
      }).join('') + (subs >= g.tids.length ? '<td class="warn">全員が副担当だと全員を担当として扱います</td>' : '<td></td>') + '</tr>';
    }).join('');
    return `<div class="scroll"><table><tr><th>科目</th><th>クラス</th><th>コマ数</th><th colspan="3">先生ごとの担当区分</th></tr>${rows}</table></div>`;
  }
  const TL = () => (!ui.editTable || ui.editTable === 'B' ? S : (S.tables.find((t) => t.id === ui.editTable) || S)); // 表示・編集中の時間割(B案=S自身)
  const TNAME = (id) => (id === 'B' ? 'B案' : ((S.tables.find((t) => t.id === id) || {}).name || id));
  function tablesCard() {
    const ids = ['B'].concat(S.tables.map((t) => t.id)); const cur = ui.editTable || 'B';
    const pf = ui.pf || { table: (S.tables[0] || {}).id || 'B', from: '', to: '' };
    const opt = (v) => ids.map((i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${esc(TNAME(i))}</option>`).join('');
    const today = todayStr(), nowT = JK.makeCtx(S).dayInfo(today).table;
    let h = `<div class="card"><h2>時間割の切り替え(A案・B案)</h2><div class="mut">普段はB案を使い、A案を使う期間を指定します。期間外はB案です。期間が重なったときは、あとから追加したものを優先します。履歴・欠勤・行事はそのまま残り、日付ごとにその日の時間割で交換案を作ります。今日(${fmtMD(today)})の時間割: <b>${esc(TNAME(nowT))}</b></div>`;
    h += `<div class="row"><label>下の表に表示・編集する時間割<select id="edit-table">${opt(cur)}</select></label></div>`;
    h += (S.tablePeriods.length ? '<table><tr><th>時間割</th><th>開始日</th><th>終了日</th><th></th></tr>' + S.tablePeriods.map((q) => `<tr><td>${esc(TNAME(q.table))}</td><td>${q.from}</td><td>${q.to || '(以降ずっと)'}</td><td><button class="b del" data-act="delPeriod" data-id="${q.id}">削除</button></td></tr>`).join('') + '</table>' : '<p class="mut">使用期間はまだ指定されていません(いまはB案だけを使っています)。</p>');
    h += `<div class="row"><label>使う時間割<select id="pf-table">${opt(pf.table)}</select></label><label>開始日<input type="date" id="pf-from" value="${pf.from}"></label><label>終了日(空=以降ずっと)<input type="date" id="pf-to" value="${pf.to}"></label><button class="b" data-act="addPeriod">使用期間を追加</button></div></div>`;
    return h;
  }
  function vLessons() {
    const lk = new Set(S.lockedSubjects);
    const L = (tid, d, p) => TL().lessons.filter((l) => l.t === tid && l.d === d && l.p === p);
    let h = tablesCard() + `<div class="card"><h2>授業一覧(${esc(TNAME(ui.editTable || 'B'))})</h2><div class="mut">コマをクリックすると、科目・クラス・教室の編集と「変更不可(交換で動かさない)」の設定ができます。Ctrlキー(Macはcommandキー)を押しながらクリックすると複数のコマを選べ、同じ操作をまとめて行えます。空きコマはクリックで授業の追加や「勤務なし」の設定ができます。オレンジ枠=変更不可、グレー=勤務なし。</div>
      <div class="scroll" style="max-height:70vh"><table><tr><th colspan="2"></th>${S.teachers.map((t) => `<th>${esc(t.name)}${t.locked ? ' 🔒' : ''}</th>`).join('')}</tr>`;
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= 6; p++) {
      h += `<tr>${p === 1 ? `<th rowspan="6" class="dayh">${DAYN[d]}</th>` : ''}<th>${p}</th>` + S.teachers.map((t) => {
        const xs = L(t.id, d, p);
        const un = (TL().unavailable[t.id] || []).includes(d + '-' + p);
        const sel = ui.sel.has(t.id + '|' + d + '|' + p);
        const locked = xs.some((l) => l.k || lk.has(l.s)) || t.locked;
        return `<td class="cell ${un ? 'gray' : ''} ${xs.length && locked ? 'lk' : ''} ${sel ? 'sel' : ''}" data-cell="${t.id}|${d}|${p}">${xs.map((l) => `<div class="s">${l.k ? '🔒' : ''}${esc(l.s)}${subOf(l) ? '<span class="mut">(副)</span>' : ''}</div><div class="c">${esc(l.c)}${l.r ? ' ' + esc(l.r) : ''}</div>`).join('')}</td>`;
      }).join('') + '</tr>';
    }
    h += '</table></div></div>';
    if (ui.sel.size > 1) h += bulkEditor(); else if (ui.cell) h += cellEditor();
    h += `<div class="card"><h2>横並び(複数の先生)の授業のメイン設定</h2>
      <div class="mut">2人以上で同じコマを受け持つとき、副担当にした先生は交換の判定(空き・重複・負担・欠勤)に含めません。メインの先生だけを動かせば授業が成立する扱いです。担当と副担当はクラスごとに選べます(同じ科目でも、クラスによってメインが違って構いません)。コマをクリックして「横並びの副担当」にチェックすると、そのクラスだけが副担当になります。</div>
      ${teamTable()}</div>
    <div class="card"><h2>変更できない科目・先生の設定</h2>
      <label>変更不可の科目(カンマ区切り。その科目の授業は交換で動かしません)<input id="lk-subj" size="50" value="${esc(S.lockedSubjects.join(','))}"></label>
      <div class="row"><button class="b sm" data-act="saveSubj">科目を保存</button></div>
      <h3>先生ごと</h3><table><tr><th>先生</th><th>教科</th><th>授業を動かせない</th><th>補欠に入れない</th><th></th></tr>
      ${S.teachers.map((t) => `<tr><td>${esc(t.name)}</td><td><input size="8" data-tdept="${t.id}" value="${esc(t.dept || '')}"></td><td><input type="checkbox" data-tlock="${t.id}" ${t.locked ? 'checked' : ''}></td><td><input type="checkbox" data-tnc="${t.id}" ${t.noCover ? 'checked' : ''}></td><td><button class="b del" data-act="delT" data-id="${t.id}">削除</button></td></tr>`).join('')}</table>
      <div class="row"><label>先生を追加<input id="nt-name" placeholder="氏名"></label><label>教科<input id="nt-dept" size="8"></label><button class="b sm" data-act="addT">追加</button></div></div>`;
    return h;
  }
  /* 複数選択(Ctrl+クリック)したコマへの一括操作 */
  const selCells = () => [...ui.sel].map((k) => { const [tid, d, p] = k.split('|'); return { tid, d: +d, p: +p }; });
  const selLessons = () => TL().lessons.filter((l) => ui.sel.has(l.t + '|' + l.d + '|' + l.p));
  function syncCell() { if (ui.sel.size === 1) { const [tid, d, p] = [...ui.sel][0].split('|'); ui.cell = { tid, d: +d, p: +p }; } else ui.cell = null; }
  function bulkEditor() {
    const ls = selLessons();
    const names = [...new Set(ls.map((l) => l.s))];
    return `<div class="card"><h2>${ui.sel.size}コマを選択中 <span class="mut">(授業${ls.length}件${names.length ? ': ' + names.slice(0, 6).map(esc).join('・') + (names.length > 6 ? ' ほか' : '') : ''})</span></h2>
      <div class="mut">Ctrlキー(Macはcommandキー)+クリックで追加・解除できます。選んだコマすべてに同じ操作をします。</div>
      <div class="row"><button class="b sm" data-act="bLock">変更不可にする</button><button class="b sm sec" data-act="bUnlock">変更不可を解除</button>
        <button class="b sm" data-act="bSub">副担当にする</button><button class="b sm sec" data-act="bUnsub">担当に戻す</button>
        <button class="b sm" data-act="bUn">勤務なしにする</button><button class="b sm sec" data-act="bUnOff">勤務ありに戻す</button>
        <button class="b del" data-act="bDel">授業を削除</button><button class="b sm sec" data-act="bClear">選択を解除</button></div>
      <h3>まとめて書き換え(空欄は変更しません)</h3>
      <div class="row"><label>科目<input id="be-s" size="10"></label><label>クラス/選択ブロック<input id="be-c" size="8"></label><label>教室<input id="be-r" size="8"></label><button class="b sm" data-act="bEdit">反映</button></div></div>`;
  }
  function cellEditor() {
    const { tid, d, p } = ui.cell;
    const ls = TL().lessons.filter((l) => l.t === tid && l.d === d && l.p === p);
    const un = (TL().unavailable[tid] || []).includes(d + '-' + p);
    let h = `<div class="card"><h2>${esc(tName(tid))} ${DAYN[d]}曜${p}限</h2>`;
    for (const l of ls) {
      h += `<div class="row" data-lid="${l.id}"><label>科目<input data-f="s" value="${esc(l.s)}" size="10"></label><label>クラス/選択ブロック<input data-f="c" value="${esc(l.c)}" size="8"></label><label>教室<input data-f="r" value="${esc(l.r)}" size="8"></label>
        <label class="inl"><input type="checkbox" data-f="k" ${l.k ? 'checked' : ''}>この授業は変更不可</label><label class="inl"><input type="checkbox" data-f="sub" ${subOf(l) ? 'checked' : ''}>横並びの副担当(交換で考えない)</label><button class="b sm" data-act="saveL" data-id="${l.id}">保存</button><button class="b del" data-act="delL" data-id="${l.id}">授業を削除</button></div>`;
    }
    if (!ls.length) h += `<div class="row"><label>科目<input id="nl-s" size="10"></label><label>クラス/選択ブロック<input id="nl-c" size="8" placeholder="2-1 / 3allD"></label><label>教室<input id="nl-r" size="8"></label><button class="b sm" data-act="addL">授業を追加</button></div>`;
    h += `<div class="row"><label class="inl"><input type="checkbox" id="un-chk" ${un ? 'checked' : ''}>この時間は勤務なし(非常勤など。交換先・補欠に使わない)</label><button class="b sm sec" data-act="saveUn">反映</button></div></div>`;
    return h;
  }

  /* ---------- 履歴・バランス ---------- */
  function vHistory() {
    const sg = S.settings, from = sg.balanceFrom || '', to = sg.balanceTo || '';
    const st = JK.stats(S);
    const nowD = new Date(), curFy = nowD.getMonth() + 1 >= 4 ? nowD.getFullYear() : nowD.getFullYear() - 1, bfy = ui.balFy || curFy;
    const yr = JK.stats(S, { from: `${bfy}-04-01`, to: `${bfy + 1}-03-31` });
    const rows = [...st.values()].filter((r) => !(S.teachers.find((t) => t.id === r.tid) || {}).noCover || r.load || yr.get(r.tid).load);
    rows.sort((x, y) => y.load - x.load || yr.get(y.tid).load - yr.get(x.tid).load);
    const balTable = (src, rs, head) => {
      const mx = Math.max(1, ...rs.map((r) => src.get(r.tid).load)), sm = (f) => rs.reduce((n, r) => n + src.get(r.tid)[f], 0);
      return `<div class="scroll"><table><tr><th>先生</th><th>${head}</th><th>交換先</th><th>補欠・合同</th><th>巻き込み</th><th>欠勤で交換</th></tr>`
        + rs.map((r) => { const q = src.get(r.tid); return `<tr><td>${esc(tName(r.tid))}</td><td><span class="bar" style="width:${Math.round(q.load / mx * 90)}px"></span> ${q.load}</td><td>${q.partner}</td><td>${q.cover}</td><td>${q.involved}</td><td>${q.absent}</td></tr>`; }).join('')
        + `<tr><th>合計</th><th>${sm('load')}</th><th>${sm('partner')}</th><th>${sm('cover')}</th><th>${sm('involved')}</th><th>${sm('absent')}</th></tr></table></div>`;
    };
    const inR = (e) => JK.inRange(e, from, to);
    const cnt = (list) => { const c = { n: list.length, swap: 0, cover: 0, merge: 0, move: 0 }; list.forEach((e) => (e.items || []).forEach((it) => { if (c[it.kind] != null) c[it.kind]++; })); return c; };
    const cr = cnt(S.history.filter(inR)), ca = cnt(S.history);
    const fmtC = (c) => `${c.n}件(変更${c.swap}・補欠${c.cover}・合同${c.merge}・移動${c.move})`;
    const y = nowD.getFullYear(), mo = nowD.getMonth() + 1, fy = curFy;
    const pad = (n) => String(n).padStart(2, '0'), ym = `${y}-${pad(mo)}`;
    const lastDay = new Date(y, mo, 0).getDate();
    let h = `<div class="card"><h2>交換先・補欠のバランス</h2>
      <div class="row"><label>集計の開始日<input type="date" id="bal-from" value="${from}"></label><label>集計の終了日<input type="date" id="bal-to" value="${to}"></label>
        <button class="b sm sec" data-act="balPeriod" data-from="" data-to="">全期間</button>
        <button class="b sm sec" data-act="balPeriod" data-from="${ym}-01" data-to="${ym}-${pad(lastDay)}">今月</button>
        <button class="b sm sec" data-act="balPeriod" data-from="${fy}-04-01" data-to="${fy + 1}-03-31">今年度(4月〜3月)</button></div>
      <div class="mut">負担 = 交換先として授業を受け持った回数 + 補欠・合同の回数。この期間の負担が、交換案の優先順位(負担が少ない先生を優先)にも使われます。期間は空欄で制限なしです。</div>
      <p><b>期間内の記録:</b> ${fmtC(cr)}${from || to ? ` <span class="mut">／ 全体: ${fmtC(ca)}</span>` : ''}</p>
      <div class="row" style="align-items:flex-start;gap:16px">
        <div style="flex:1 1 440px;min-width:0"><h3 style="margin-top:0">${from || to ? '集計期間内' : '全期間'}の回数</h3>${balTable(st, rows, '負担(期間内)')}</div>
        <div style="flex:1 1 440px;min-width:0"><div class="row" style="margin:0 0 4px"><button class="b sm sec" data-act="fyPrev">◀</button><h3 style="margin:0">${bfy}年度(4月〜3月)の回数</h3><button class="b sm sec" data-act="fyNext">▶</button></div>${balTable(yr, rows, '負担(年度)')}</div>
      </div></div>`;
    h += learnCard();
    h += `<div class="card"><h2>交換履歴 <span class="mut">(${S.history.length}件)</span></h2>`;
    if (!S.history.length) h += '<p class="mut">採用した交換案がここに残ります。削除すると、その交換は無かったことになり時間割・バランスも元に戻ります。</p>';
    S.history.slice().reverse().forEach((e) => {
      h += `<div class="item"><div class="row"><b>${esc(e.date ? fmtMD(e.date) : '')}</b><span class="mut">採用 ${esc((e.createdAt || '').replace('T', ' ').slice(0, 16))}${(from || to) && !inR(e) ? ' / 集計期間外' : ''}</span><button class="b del" data-act="delH" data-id="${e.id}">削除(取り消し)</button></div>`
        + e.items.map((it) => {
          const a = it.a; const base = `${slotTxt(a.date, a.period)} ${esc(a.cls)} ${unitTxt(a)}`;
          if (it.kind === 'swap') return `<div>${base} ⇄ ${slotTxt(it.b.date, it.b.period)} ${unitTxt(it.b)}</div>`;
          if (it.kind === 'move') return `<div>${base} → ${slotTxt(it.to.date, it.to.period)}へ移動</div>`;
          if (it.kind === 'cover') return `<div>${base} → 補欠 ${esc(tName(it.by))}</div>`;
          return `<div>${base} → 合同 ${it.partners.map((t) => esc(tName(t))).join('・')}</div>`;
        }).join('') + '</div>';
    });
    return h + '</div>';
  }

  function learnCard() {
    const lp = JK.learnProfile(S), m = lp.summary, pc = (x) => Math.round(x * 100) + '%';
    let h = `<div class="card"><h2>学習した交換の傾向</h2><div class="mut">${learnStatus()}</div>`;
    if (!m.n && !m.others) return h + '<p class="mut">履歴に交換を追加すると、ここに傾向が表示されます。</p></div>';
    h += `<table><tr><th>項目</th><th>これまでの傾向</th></tr>
      <tr><td>交換の件数</td><td>交換${m.n}件、補欠・合同${m.others}件(補欠・合同の割合 ${pc(m.coverRate)})</td></tr>`;
    if (m.n) {
      h += `<tr><td>日数の離れ方</td><td>平均 ${m.avgDist.toFixed(1)}授業日 / 同じ日の交換 ${pc(m.sameDayRate)}</td></tr>
        <tr><td>同じ週の中での交換</td><td>${pc(m.sameWeekRate)}</td></tr>
        <tr><td>同じ教科どうしの交換</td><td>${pc(m.sameDeptRate)}</td></tr>
        <tr><td>相手の授業の時限</td><td>${m.periods.map((p) => `${p.period}限(${p.count}件)`).join('、') || '-'}</td></tr>
        <tr><td>よくある組み合わせ</td><td>${m.pairs.map((p) => `${esc(tShort(p.a))}先生が休み → ${esc(tShort(p.b))}先生と交換(${p.count}件)`).join('<br>') || '-'}</td></tr>`;
    }
    return h + '</table></div>';
  }

  /* ---------- 設定 ---------- */
  function vSettings() {
    const st = S.settings, w = st.weights;
    const W = [['swap', '交換1件の基本点'], ['day', '1日離れるごと'], ['teacher', '巻き込む先生1名ごと'], ['balance', '負担が多い先生(1回差ごと)'], ['load', '1日の授業数オーバー(1コマごと)'], ['cover', '補欠の基本点'], ['mismatch', '補欠が別教科の先生'], ['merge', '合同授業'], ['dup', '同じ日に同じ科目が重なる'], ['chain', '連鎖交換(前提の交換1件ごと)'], ['week', '別の週の授業と交換(1件ごと)'], ['learn', '履歴の傾向から外れる(最大点)']];
    return `<div class="card"><h2>交換のルール</h2><div class="row">
      <label>交換期間(授業日以内)<input type="number" id="c-win" min="0" max="60" value="${st.windowDays}"></label>
      <label class="inl"><input type="checkbox" id="c-before" ${st.allowBefore ? 'checked' : ''}>欠勤日より前も可</label>
      <label>前は何授業日まで<input type="number" id="c-bd" min="0" max="30" value="${st.beforeDays}"></label>
      <label>1日の授業数の目安<input type="number" id="c-max" min="1" max="6" value="${st.maxPerDay}"></label>
      <label class="inl"><input type="checkbox" id="c-learn" ${st.learn ? 'checked' : ''}>履歴から交換の傾向を学習して反映する</label>
      <label class="inl"><input type="checkbox" id="c-chain" ${st.chain ? 'checked' : ''}>連鎖交換を使う</label>
      <label>連鎖で先に交換する他コマの最大数<input type="number" id="c-chmax" min="1" max="3" value="${st.chainMax}"></label>
      <label class="inl"><input type="checkbox" id="c-hol" ${st.holidays ? 'checked' : ''}>祝日は授業なし</label>
      <label>交換する週<select id="c-week"><option value="prefer" ${st.weekMode === 'prefer' ? 'selected' : ''}>同じ週を優先</option><option value="only" ${st.weekMode === 'only' ? 'selected' : ''}>同じ週のみ</option><option value="off" ${st.weekMode === 'off' ? 'selected' : ''}>気にしない</option></select></label>
      <label>同じ日に同じクラスで同じ科目が重なる交換<select id="c-same"><option value="forbid" ${st.sameDay === 'forbid' ? 'selected' : ''}>しない</option><option value="penalty" ${st.sameDay === 'penalty' ? 'selected' : ''}>減点</option><option value="allow" ${st.sameDay === 'allow' ? 'selected' : ''}>気にしない</option></select></label>
      <label class="inl"><input type="checkbox" id="c-re" ${st.avoidReswap ? 'checked' : ''}>交換・補欠済みの授業は再度動かさない</label>
      <label>バランス集計の開始日(空=制限なし)<input type="date" id="c-bf" value="${st.balanceFrom || ''}"></label><label>終了日(空=制限なし)<input type="date" id="c-bt" value="${st.balanceTo || ''}"></label></div>
      <h3>優先度の重み(点数が小さい案ほど上位)</h3><div class="row">${W.map(([k, n]) => `<label>${n}<input type="number" min="0" max="999" data-w="${k}" value="${w[k]}"></label>`).join('')}</div>
      <div class="row"><button class="b" data-act="saveSet">保存</button><button class="b sec" data-act="resetW">重みを初期値に戻す</button></div></div>
      <div class="card"><h2>データ</h2><div class="row"><button class="b sec" data-act="export">データを表示(コピー用)</button><label>ファイルから読み込み<input type="file" id="imp" accept=".json"></label><button class="b del" data-act="reset">授業一覧PDFの初期状態に戻す</button></div>
      <label style="margin-top:8px">データのコピー/貼り付け欄(貼り付けて「貼り付けから読み込む」)<textarea id="impbox" rows="4">${esc(ui.exportText || '')}</textarea></label><div class="row"><button class="b sm sec" data-act="importText">貼り付けから読み込む(全て置き換え)</button><button class="b sm" data-act="importHist">履歴だけを追加する(重複は無視)</button></div>
      <div class="mut">スマホで使うとき: このページのURLをスマホのブラウザ(またはClaudeアプリ)で開き、ブラウザのメニューから「ホーム画面に追加」を選ぶと、アプリのように起動できます。スマホとPCはデータが別々なので、PCの「データを表示(コピー用)」の文字列をスマホの下の欄に貼り付けて移してください。</div>
      <div class="mut">別のPCやブラウザで使っていたデータを移すとき: 元の画面で「データを表示(コピー用)」を押し、出てきた文字列をコピーして、この欄に貼り付けてください。「履歴だけを追加する」は、いまの欠勤・行事・設定を消さずに、交換履歴だけを足します(同じ履歴は二重に入りません)。</div>
      <div class="mut">データはこのブラウザ内(localStorage)にのみ保存されます。複数端末で使うときは書き出し/読み込みを使ってください。</div></div>`;
  }

  /* ---------- イベント ---------- */
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]'); if (tab) { ui.tab = tab.dataset.tab; render(); return; }
    const dEl = e.target.closest('[data-date]'); if (dEl) { ui.selDate = dEl.dataset.date; ui.mr.bDate = ''; ui.mr.bPeriod = ''; render(); return; }
    const cEl = e.target.closest('[data-cell]');
    if (cEl) {
      const k = cEl.dataset.cell;
      if (e.ctrlKey || e.metaKey) { if (ui.sel.has(k)) ui.sel.delete(k); else ui.sel.add(k); } else ui.sel = new Set([k]);
      syncCell(); render(); return;
    }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act, id = b.dataset.id;
    // 埋め込み表示では confirm() が使えないため、同じボタンを2回押して確定する
    const sure = (m) => { if (b.dataset.armed) return true; b.dataset.armed = '1'; b.textContent = m + ' もう一度押すと実行'; clearTimeout(sure.h); sure.h = setTimeout(render, 4000); return false; };
    const val = (q) => { const el = $(q); return el ? el.value : ''; };
    const checked = (n) => [...document.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => +x.value);
    if (a === 'propose') {
      ui.plans = JK.propose(S, { today: ui.today, skip: S.skipUnits || [] }).plans; render(); toast(ui.plans.length + '案を作成しました');
    } else if (a === 'adopt') {
      const pl = ui.plans[+b.dataset.i]; if (!pl) return;
      if (pl.stats.unresolved && !sure('未解決あり。')) return;
      S.history.push(JK.makeHistoryEntry(pl)); save(); ui.plans = null; render(); toast('履歴に残しました(時間割に反映されます)');
    } else if (a === 'copy') {
      const t = planText(ui.plans[+b.dataset.i]); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('コピーしました'), () => { ui.copyText = t; render(); });
    } else if (a === 'addAbs') {
      const from = val('#af-from'), to = val('#af-to') || from, tid = val('#af-t');
      const all = (document.querySelector('input[name="af-m"]:checked') || {}).value !== 'per'; const periods = all ? null : checked('af-p');
      ui.absForm = { tid, from, to: val('#af-to'), all, periods: periods || [] };
      if (!from || to < from) { toast('日付を確認してください'); return; }
      if (!all && !periods.length) { toast('時限を選んでください'); return; }
      const ctx = JK.makeCtx(S); let n = 0;
      for (const d of dateRange(from, to)) { if (ctx.dayInfo(d).w === 0) continue; S.absences.push({ id: uid('a'), tid, date: d, periods, note: val('#af-note') }); n++; }
      save(); ui.plans = null; render(); toast(n ? n + '日分の欠勤を登録しました' : '授業のある日がありませんでした');
    } else if (a === 'delAbs') { S.absences = S.absences.filter((x) => x.id !== id); save(); ui.plans = null; render();
    } else if (a === 'mprev' || a === 'mnext') { const [y, m] = ui.month.split('-').map(Number); const n = new Date(Date.UTC(y, m - 1 + (a === 'mnext' ? 1 : -1), 1)); ui.month = n.getUTCFullYear() + '-' + String(n.getUTCMonth() + 1).padStart(2, '0'); render();
    } else if (a === 'mtoday') { ui.month = todayStr().slice(0, 7); ui.selDate = todayStr(); render();
    } else if (a === 'addEv') {
      const from = val('#ev-from'), to = val('#ev-to'); const type = val('#ev-type');
      if (!from || (to && to < from)) { toast('日付を確認してください'); return; }
      const ev = { id: uid('e'), date: from, type, title: val('#ev-title') || EVT[type], scope: val('#ev-scope') };
      if (to && to !== from) ev.endDate = to;
      if (type === 'cancel') ev.periods = checked('ev-p');
      if (type === 'dayswap') ev.swapDay = +val('#ev-sd');
      S.events.push(ev); save(); ui.plans = null; render(); toast('行事を追加しました');
    } else if (a === 'delEv') { S.events = S.events.filter((x) => x.id !== id); save(); ui.plans = null; render();
    } else if (a === 'saveL' || a === 'delL') {
      const l = TL().lessons.find((x) => x.id === id); if (!l) return;
      if (a === 'delL') TL().lessons = TL().lessons.filter((x) => x.id !== id);
      else { const row = b.closest('[data-lid]'); const oldS = l.s, oldC = l.c; l.s = $('[data-f=s]', row).value.trim(); l.c = $('[data-f=c]', row).value.trim(); l.r = $('[data-f=r]', row).value.trim(); l.k = $('[data-f=k]', row).checked || undefined; if (oldS !== l.s || oldC !== l.c) setSub(l.t, oldS, oldC, false); setSub(l.t, l.s, l.c, $('[data-f=sub]', row).checked); }
      save(); ui.plans = null; render(); toast('保存しました');
    } else if (a === 'addL') {
      const s = val('#nl-s').trim(), c = val('#nl-c').trim(); if (!s || !c) { toast('科目とクラスを入力してください'); return; }
      const { tid, d, p } = ui.cell; TL().lessons.push({ id: (ui.editTable && ui.editTable !== 'B' ? ui.editTable + ':' : '') + `${tid}-${d}-${p}`, t: tid, d, p, s, c, r: val('#nl-r').trim() }); save(); ui.plans = null; render();
    } else if (a === 'saveUn') {
      const { tid, d, p } = ui.cell; const k = d + '-' + p; const arr = (TL().unavailable[tid] || []).filter((x) => x !== k);
      if ($('#un-chk').checked) arr.push(k); TL().unavailable[tid] = arr; save(); ui.plans = null; render(); toast('反映しました');
    } else if (a === 'bLock' || a === 'bUnlock') { const on = a === 'bLock'; const ls = selLessons(); ls.forEach((l) => { l.k = on || undefined; }); save(); ui.plans = null; render(); toast(ls.length + '件を' + (on ? '変更不可にしました' : '変更可にしました'));
    } else if (a === 'bSub' || a === 'bUnsub') { const on = a === 'bSub'; const ls = selLessons(); ls.forEach((l) => setSub(l.t, l.s, l.c, on)); save(); ui.plans = null; render(); toast(ls.length + '件を' + (on ? '副担当にしました' : '担当に戻しました'));
    } else if (a === 'bUn' || a === 'bUnOff') {
      const on = a === 'bUn';
      for (const { tid, d, p } of selCells()) { const k = d + '-' + p; const arr = (TL().unavailable[tid] || []).filter((x) => x !== k); if (on) arr.push(k); TL().unavailable[tid] = arr; }
      save(); ui.plans = null; render(); toast(ui.sel.size + 'コマを' + (on ? '勤務なしにしました' : '勤務ありに戻しました'));
    } else if (a === 'bDel') {
      if (!sure(selLessons().length + '件の授業を削除。')) return;
      const ids = new Set(selLessons().map((l) => l.id)); TL().lessons = TL().lessons.filter((l) => !ids.has(l.id)); save(); ui.plans = null; render(); toast('授業を削除しました');
    } else if (a === 'unitsAll' || a === 'unitsNone') {
      const us = JK.affectedUnits(JK.makeCtx(S), ui.today).map(ukey);
      S.skipUnits = a === 'unitsAll' ? (S.skipUnits || []).filter((k) => !us.includes(k)) : [...new Set((S.skipUnits || []).concat(us))];
      save(); ui.plans = null; render();
    } else if (a === 'mrAdd') {
      const m = ui.mr; let spec;
      if (m.mode === 'swap') {
        const [p, cls] = (m.a || '').split('|');
        spec = { kind: 'swap', a: { date: ui.selDate, period: +p, cls }, b: { date: m.bDate || ui.selDate, period: +m.bPeriod } };
      } else if (m.mode === 'move') {
        const [p, cls] = (m.a || '').split('|');
        spec = { kind: 'move', a: { date: ui.selDate, period: +p, lid: cls }, to: { date: m.bDate || ui.selDate, period: +m.bPeriod } };
      } else {
        const [p, lid] = (m.lid || '').split('|');
        spec = { kind: 'cover', a: { date: ui.selDate, period: +p, lid }, by: m.by };
      }
      const r = JK.makeManualEntry(S, spec);
      if (r.error) { m.msg = r.error; m.bad = true; render(); return; }
      S.history.push(r.entry); save(); ui.plans = null;
      m.bDate = ''; m.bPeriod = ''; m.a = ''; m.lid = '';
      m.msg = '履歴に記録しました。' + (r.problems.length ? '注意: ' + [...new Set(r.problems.map((x) => PROB[x.type] + '(' + fmtMD(x.date) + x.period + '限)'))].join('、') + '。実際の運用と合わない場合は「履歴・バランス」で取り消してください。' : '');
      m.bad = r.problems.length > 0; render(); toast('履歴に記録しました');
    } else if (a === 'nkParse') {
      ui.nk.text = val('#nk-text'); ui.nk.fy = +val('#nk-fy') || ui.nk.fy; ui.nk.items = NK.parseText(ui.nk.text, ui.nk.fy); ui.nk.msg = ''; render();
    } else if (a === 'nkAll' || a === 'nkNone') { (ui.nk.items || []).forEach((x) => { x.include = a === 'nkAll'; }); render();
    } else if (a === 'nkAdd') {
      let n = 0, dup = 0;
      for (const it of ui.nk.items || []) {
        if (!it.include || !it.date || !it.title) continue;
        if (S.events.some((e) => e.date === it.date && e.title === it.title)) { dup++; continue; }
        S.events.push(NK.toEvent(it, uid('e'))); n++;
      }
      save(); ui.plans = null; ui.nk.items = null; ui.nk.msg = n + '件の行事を追加しました' + (dup ? `(同じ日付・名称の${dup}件は重複のため追加していません)` : '') + '。'; render(); toast(n + '件を追加しました');
    } else if (a === 'bClear') { ui.sel = new Set(); ui.cell = null; render();
    } else if (a === 'bEdit') {
      const ns = val('#be-s').trim(), nc = val('#be-c').trim(), nr = val('#be-r').trim();
      if (!ns && !nc && !nr) { toast('書き換える項目を入力してください'); return; }
      const ls = selLessons();
      ls.forEach((l) => { const oS = l.s, oC = l.c, was = subOf(l); if (ns) l.s = ns; if (nc) l.c = nc; if (nr) l.r = nr; if (oS !== l.s || oC !== l.c) { setSub(l.t, oS, oC, false); if (was) setSub(l.t, l.s, l.c, true); } });
      save(); ui.plans = null; render(); toast(ls.length + '件を書き換えました');
    } else if (a === 'saveSubj') { S.lockedSubjects = val('#lk-subj').split(/[,、\s]+/).filter(Boolean); save(); ui.plans = null; render(); toast('保存しました');
    } else if (a === 'addT') { const name = val('#nt-name').trim(); if (!name) return; S.teachers.push({ id: uid('t'), name, dept: val('#nt-dept').trim(), locked: false, noCover: false }); save(); render();
    } else if (a === 'delT') { if (!sure('授業・欠勤も削除。')) return; S.teachers = S.teachers.filter((t) => t.id !== id); S.lessons = S.lessons.filter((l) => l.t !== id); S.tables.forEach((q) => { q.lessons = q.lessons.filter((l) => l.t !== id); delete q.unavailable[id]; }); S.absences = S.absences.filter((x) => x.tid !== id); delete S.unavailable[id]; save(); ui.plans = null; render();
    } else if (a === 'fyPrev' || a === 'fyNext') { const n = new Date(); const cur = ui.balFy || (n.getMonth() + 1 >= 4 ? n.getFullYear() : n.getFullYear() - 1); ui.balFy = cur + (a === 'fyNext' ? 1 : -1); render();
    } else if (a === 'balPeriod') { S.settings.balanceFrom = b.dataset.from; S.settings.balanceTo = b.dataset.to; save(); ui.plans = null; render();
    } else if (a === 'addPeriod') {
      ui.pf = { table: val('#pf-table'), from: val('#pf-from'), to: val('#pf-to') };
      if (!ui.pf.from) { toast('開始日を入力してください'); return; }
      if (ui.pf.to && ui.pf.to < ui.pf.from) { toast('終了日が開始日より前です'); return; }
      S.tablePeriods.push({ id: uid('tp'), table: ui.pf.table, from: ui.pf.from, to: ui.pf.to }); save(); ui.plans = null; render(); toast('使用期間を追加しました');
    } else if (a === 'delPeriod') { S.tablePeriods = S.tablePeriods.filter((q) => q.id !== id); save(); ui.plans = null; render();
    } else if (a === 'delH') { if (!sure('取り消し。')) return; S.history = S.history.filter((x) => x.id !== id); save(); ui.plans = null; render();
    } else if (a === 'saveSet') { readSettings(); save(); ui.plans = null; render(); toast('保存しました');
    } else if (a === 'resetW') { S.settings.weights = JK.defaultSettings().weights; save(); render();
    } else if (a === 'export') { ui.exportText = JSON.stringify(S); render();
    } else if (a === 'importHist') {
      try {
        if (!val('#impbox').trim()) throw new Error('貼り付け欄が空です');
        const o = JSON.parse(val('#impbox')); const list = Array.isArray(o) ? o : o.history;
        if (!Array.isArray(list)) throw new Error('履歴が見つかりません(「データを表示」でコピーした文字列を貼り付けてください)');
        const have = new Set(S.history.map((x) => x.id)); let add = 0, dup = 0, bad = 0;
        for (const e of list) { if (!e || !e.id || !Array.isArray(e.items)) { bad++; continue; } if (have.has(e.id)) { dup++; continue; } e.moves = e.moves || []; S.history.push(e); have.add(e.id); add++; }
        S.history.sort((x, y) => ((x.date || '') > (y.date || '') ? 1 : (x.date || '') < (y.date || '') ? -1 : 0));
        save(); ui.plans = null; render(); toast(`履歴を${add}件追加しました` + (dup ? `(重複${dup}件は無視)` : '') + (bad ? `(読めない${bad}件)` : ''));
      } catch (er) { toast('取り込めません: ' + er.message); }
    } else if (a === 'importText') {
      try { const o = JSON.parse(val('#impbox')); if (!o.teachers || !o.lessons) throw new Error('形式が違います'); S = ensureTables(Object.assign(fresh(), o)); normSub(S); save(); ui.plans = null; ui.exportText = ''; render(); toast('読み込みました'); } catch (er) { toast('読み込めません: ' + er.message); }
    } else if (a === 'reset') { if (!sure('全データを初期化。')) return; S = fresh(); save(); ui.plans = null; ui.cell = null; ui.sel = new Set(); render();
    }
  });
  function readSettings() {
    const st = S.settings, g = (id) => document.getElementById(id);
    st.windowDays = Math.max(0, +g('c-win').value || 0); st.allowBefore = g('c-before').checked; st.beforeDays = Math.max(0, +g('c-bd').value || 0);
    st.maxPerDay = Math.max(1, +g('c-max').value || 5); st.holidays = g('c-hol').checked; st.avoidReswap = g('c-re').checked; st.balanceFrom = g('c-bf').value; st.balanceTo = g('c-bt').value; st.sameDay = g('c-same').value; st.weekMode = g('c-week').value; st.learn = g('c-learn').checked; st.chain = g('c-chain').checked; st.chainMax = Math.max(1, +g('c-chmax').value || 1);
    document.querySelectorAll('[data-w]').forEach((el) => { st.weights[el.dataset.w] = Math.max(0, +el.value || 0); });
  }
  /* カレンダー: 矢印キーで日付を移動(←→=前後の日 / ↑↓=前後の週 / PageUp・PageDown=前後の月 / Home=今日) */
  document.addEventListener('keydown', (e) => {
    if (ui.tab !== 'calendar' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    let d = ui.selDate;
    const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (mv) d = addDays(d, mv);
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + (e.key === 'PageDown' ? 1 : -1), 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      d = t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(Math.min(dd, last)).padStart(2, '0');
    } else if (e.key === 'Home') d = todayStr();
    else return;
    e.preventDefault();
    ui.selDate = d; ui.month = d.slice(0, 7); ui.mr.bDate = ''; ui.mr.bPeriod = ''; render();
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'today') { ui.today = t.value || todayStr(); ui.plans = null; render(); }
    else if (t.dataset.unit) { const k = t.dataset.unit; const set = new Set(S.skipUnits || []); if (t.checked) set.delete(k); else set.add(k); S.skipUnits = [...set]; save(); ui.plans = null; render(); }
    else if (t.id === 's-win') { S.settings.windowDays = Math.max(0, +t.value || 0); save(); ui.plans = null; }
    else if (t.dataset.subsel) { const p = t.dataset.subsel.split('|'); setSub(p[0], p.slice(1, -1).join('|'), p[p.length - 1], t.value === 's'); save(); ui.plans = null; render(); }
    else if (t.id === 's-chain') { S.settings.chain = t.checked; save(); ui.plans = null; }
    else if (t.id === 's-before') { S.settings.allowBefore = t.checked; save(); ui.plans = null; }
    else if (t.dataset.mr) { const f = t.dataset.mr; ui.mr[f] = t.value; if (f === 'a' || f === 'bDate') ui.mr.bPeriod = ''; if (f === 'mode') { ui.mr.a = ''; ui.mr.bPeriod = ''; } ui.mr.msg = ''; render(); }
    else if (t.dataset.nk) {
      const [i, f] = t.dataset.nk.split('|'); const it = ui.nk.items[+i]; if (!it) return;
      if (f === 'include') { it.include = t.checked; render(); }
      else if (f === 'periods') it.periods = t.value.split(/[,、・\s]+/).map(Number).filter((p) => p >= 1 && p <= 6);
      else if (f === 'swapDay') it.swapDay = +t.value;
      else if (f === 'endDate') it.endDate = t.value || undefined;
      else if (f === 'type') { it.type = t.value; if (t.value === 'dayswap' && !it.swapDay) it.swapDay = 1; if (t.value === 'holiday') it.include = false; render(); }
      else it[f] = t.value;
    }
    else if (t.id === 'nk-fy') { ui.nk.fy = +t.value || ui.nk.fy; if (ui.nk.items) { ui.nk.items = NK.parseText(ui.nk.text, ui.nk.fy); render(); } }
    else if (t.id === 'nk-text') ui.nk.text = t.value;
    else if (t.id === 'nk-file' && t.files[0]) readPdf(t.files[0]);
    else if (t.id === 's-learn') { S.settings.learn = t.checked; save(); ui.plans = null; render(); }
    else if (t.id === 's-week') { S.settings.weekMode = t.value; save(); ui.plans = null; }
    else if (t.id === 'bal-from' || t.id === 'bal-to') { S.settings[t.id === 'bal-from' ? 'balanceFrom' : 'balanceTo'] = t.value; save(); ui.plans = null; render(); }
    else if (t.id === 'edit-table') { ui.editTable = t.value; ui.cell = null; ui.sel = new Set(); render(); }
    else if (t.id === 's-same') { S.settings.sameDay = t.value; save(); ui.plans = null; }
    else if (t.id === 's-cover') { S.settings.coverMode = t.value; save(); ui.plans = null; }
    else if (t.dataset.tlock) { S.teachers.find((x) => x.id === t.dataset.tlock).locked = t.checked; save(); ui.plans = null; render(); }
    else if (t.dataset.tnc) { S.teachers.find((x) => x.id === t.dataset.tnc).noCover = t.checked; save(); ui.plans = null; }
    else if (t.dataset.tdept) { S.teachers.find((x) => x.id === t.dataset.tdept).dept = t.value.trim(); save(); }
    else if (t.id === 'imp' && t.files[0]) {
      const r = new FileReader(); r.onload = () => { try { const o = JSON.parse(r.result); if (!o.teachers || !o.lessons) throw new Error('形式が違います'); S = ensureTables(Object.assign(fresh(), o)); normSub(S); save(); ui.plans = null; render(); toast('読み込みました'); } catch (er) { toast('読み込めません: ' + er.message); } }; r.readAsText(t.files[0]);
    }
  });
  /* ---------- 利用コード(入口) ----------
   * 簡易的な入口です。コードは画面のソースに直接は書かず、照合用の値だけを持ちます(本格的な認証ではありません)。 */
  const ACCESS_KEY = 'jugyo-koukan-access', ACCESS_HASH = '4bhq1aihkc';
  const hash53 = (str) => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
  const unlocked = () => { try { return localStorage.getItem(ACCESS_KEY) === ACCESS_HASH; } catch (e) { return false; } };
  function showGate(msg) {
    $('#tabs').innerHTML = '';
    $('#view').innerHTML = `<div class="card" style="max-width:420px;margin:30px auto"><h2>利用コードを入力してください</h2><div class="mut">利用コードを知っている方だけが使えます。</div>
      <div class="row"><label>利用コード<input type="password" id="gate-code" autocomplete="off" autofocus></label><button class="b" id="gate-ok">開く</button></div>${msg ? `<div class="bad">${esc(msg)}</div>` : ''}</div>`;
    const go = () => { const v = ($('#gate-code').value || '').trim(); if (hash53(v) === ACCESS_HASH) { try { localStorage.setItem(ACCESS_KEY, ACCESS_HASH); } catch (e) { /* 保存できなくても今回は開く */ } gateOpen = true; render(); } else showGate('利用コードが違います。'); };
    $('#gate-ok').onclick = go; $('#gate-code').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    setTimeout(() => { const el = $('#gate-code'); if (el) el.focus(); }, 0);
  }
  let gateOpen = false;
  const render0 = render;
  render = function () { if (gateOpen || unlocked()) { gateOpen = true; render0(); } else showGate(); };
  render();
})();
