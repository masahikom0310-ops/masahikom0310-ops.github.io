/* 授業交換エンジン(UI非依存の純粋ロジック)
 * ブラウザでは window.JK、Node では module.exports として公開。
 *
 * 用語
 *  lesson   : 基本時間割の1コマ {id,t(教師id),d(曜日1-5),p(時限),s(科目),c(クラス/選択ブロック),r(教室),k(個別ロック)}
 *  instance : ある日付に実際に行われる授業 {lid,tid,subj,cls,room,date,period,moved,covered}
 *  unit     : 同じ日付・時限・クラスキー(c)の instance の集まり。TT・少人数分割・選択ブロックは丸ごと1単位として動かす
 *  swap     : 欠勤の unit(A) と、同じクラスキーの別コマ unit(B) をそっくり入れ替える1対1交換
 */
(function (root) {
  'use strict';
  const PERIODS = 6;
  const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

  /* ---------- 日付ユーティリティ (YYYY-MM-DD, UTC計算でタイムゾーン非依存) ---------- */
  const toMs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromMs = (ms) => { const t = new Date(ms); return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0'); };
  const addDays = (s, n) => fromMs(toMs(s) + n * 86400000);
  const dow = (s) => new Date(toMs(s)).getUTCDay();
  const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);
  const fmtMD = (s) => { const [, m, d] = s.split('-').map(Number); return m + '/' + d + '(' + DAY_NAMES[dow(s)] + ')'; };
  const dateRange = (a, b) => { const r = []; for (let d = a; d <= b; d = addDays(d, 1)) r.push(d); return r; };

  /* 国民の祝日 2026-2027 (振替休日・国民の休日を含む) */
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
    '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22', '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05',
    '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23',
  ]);

  function defaultSettings() {
    return {
      windowDays: 10,       // 交換期間: 欠勤日から何日以内の授業と交換するか
      allowBefore: false,   // 欠勤日より前の授業とも交換してよいか
      beforeDays: 5,        // allowBefore時、何日前まで
      holidays: true,       // 祝日は授業なし
      coverMode: 'fallback', // swap=交換のみ / fallback=交換できない時だけ補欠 / equal=補欠も同列で比較
      maxPerDay: 5,         // 1日の授業数の目安(超えると加点)
      learn: true,          // 履歴から交換の傾向を学習して、案のスコアに反映する
      weekMode: 'prefer',  // 交換先を同じ週(月〜金)に限る: prefer=同じ週を優先(他の週は減点) / only=同じ週のみ / off=気にしない
      sameDay: 'forbid',   // 同じ日に同じクラスへ同じ科目が重なる交換: forbid=除外 / penalty=減点 / allow=気にしない
      chain: true,          // 連鎖交換: 先生の重複を、他のコマも交換して解消する
      chainMax: 2,          // 1つの交換につき、先に交換する他コマの最大数
      avoidReswap: true,    // 交換・補欠済みのコマは再度動かさない
      balanceFrom: '',      // バランス集計の開始日(空=制限なし)
      balanceTo: '',        // バランス集計の終了日(空=制限なし)
      maxPlans: 5,
      weights: { swap: 10, day: 3, teacher: 4, balance: 4, load: 8, cover: 16, mismatch: 5, merge: 8, dup: 12, chain: 6, week: 20, learn: 12, unresolved: 500 },
    };
  }

  /* ---------- コンテキスト(時間割+行事+履歴から日付ごとの実授業を組み立てる) ---------- */
  function makeCtx(state, opts) {
    opts = opts || {};
    const S = Object.assign(defaultSettings(), state.settings || {});
    S.weights = Object.assign(defaultSettings().weights, (state.settings || {}).weights || {});
    const teachers = new Map(state.teachers.map((t) => [t.id, t]));
    // 時間割は複数持てる: 'B'=state.lessons(既定)、その他=state.tables。日付ごとに state.tablePeriods で使う時間割を決める(期間外は 'B')。
    const tables = new Map();
    for (const td of [{ id: 'B', lessons: state.lessons, unavailable: state.unavailable }].concat(state.tables || [])) {
      const byWP = new Map(); // `${w}-${p}` -> lessons
      for (const l of td.lessons) { const k = l.d + '-' + l.p; if (!byWP.has(k)) byWP.set(k, []); byWP.get(k).push(l); }
      const unav = new Map();
      for (const [tid, arr] of Object.entries(td.unavailable || {})) unav.set(tid, new Set(arr));
      tables.set(td.id, { byWP, unav });
    }
    const lessons = new Map(); // 全時間割の授業(履歴の移動が、どの時間割の授業でも辿れるように)
    for (const ls of [state.lessons].concat((state.tables || []).map((t) => t.lessons))) for (const l of ls) lessons.set(l.id, l);
    const periods = state.tablePeriods || [];
    const tableOf = (date) => { for (let i = periods.length - 1; i >= 0; i--) { const q = periods[i]; if (tables.has(q.table) && q.from && q.from <= date && (!q.to || date <= q.to)) return q.table; } return 'B'; };
    const lockedSubj = new Set(state.lockedSubjects || []);
    // 欠勤: `${tid}|${date}` -> null(終日) | Set(periods)
    const abs = new Map();
    for (const a of state.absences || []) {
      const k = a.tid + '|' + a.date;
      if (!a.periods || !a.periods.length) abs.set(k, null);
      else if (abs.get(k) !== null) { const s = abs.get(k) || new Set(); a.periods.forEach((p) => s.add(p)); abs.set(k, s); }
    }
    const events = state.events || [];
    const dateCache = new Map();

    const scopeMatch = (scope, cls) => !scope || scope === 'all' || (/^\d$/.test(scope) ? cls[0] === scope : cls === scope);
    const evOn = (date) => events.filter((e) => e.date <= date && date <= (e.endDate || e.date));

    function dayInfo(date) {
      const evs = evOn(date);
      const swap = evs.find((e) => e.type === 'dayswap');
      let w = dow(date);
      if (w === 0 || w === 6) w = 0;
      let holiday = false;
      if (swap) w = Number(swap.swapDay);
      else if (S.holidays && HOLIDAYS.has(date)) { holiday = true; w = 0; }
      return { date, w, holiday, events: evs, swapped: !!swap, table: tableOf(date) };
    }

    function build(date) {
      if (dateCache.has(date)) return dateCache.get(date);
      const info = dayInfo(date);
      const slots = [null];
      for (let p = 1; p <= PERIODS; p++) slots.push([]);
      const cancels = info.events.filter((e) => e.type === 'cancel');
      if (info.w >= 1 && info.w <= 5) {
        for (let p = 1; p <= PERIODS; p++) {
          for (const l of tables.get(info.table).byWP.get(info.w + '-' + p) || []) {
            const cancelled = cancels.some((e) => (!e.periods || !e.periods.length || e.periods.includes(p)) && scopeMatch(e.scope, l.c));
            if (cancelled) continue;
            slots[p].push(mkInst(l, date, p));
          }
        }
      }
      for (const h of state.history || []) {
        for (const m of h.moves || []) {
          if (m.kind === 'move') {
            if (m.fromDate === date) { const i = slots[m.fromPeriod].findIndex((x) => x.lid === m.lid); if (i >= 0) slots[m.fromPeriod].splice(i, 1); }
            if (m.toDate === date) { const l = lessons.get(m.lid); if (l) { const o = mkInst(l, date, m.toPeriod); o.moved = true; slots[m.toPeriod].push(o); } }
          } else if (m.kind === 'cover' && m.date === date) {
            const x = slots[m.period].find((q) => q.lid === m.lid);
            if (x) { x.origTid = x.tid; x.tid = m.by; x.covered = true; }
          } else if (m.kind === 'merge' && m.date === date) {
            const i = slots[m.period].findIndex((x) => x.lid === m.lid);
            if (i >= 0) slots[m.period].splice(i, 1);
          }
        }
      }
      dateCache.set(date, { info, slots });
      return dateCache.get(date);
    }
    function mkInst(l, date, p) {
      return { lid: l.id, tid: l.t, subj: l.s, cls: l.c, room: l.r || '', date, period: p, moved: false, covered: false };
    }
    const slot = (date, p) => build(date).slots[p];
    const isAbsent = (tid, date, p) => { const k = tid + '|' + date; if (!abs.has(k)) return false; const v = abs.get(k); return v === null || v.has(p); };
    const isUnavail = (tid, date, p) => { const inf = build(date).info; const u = tables.get(inf.table).unav.get(tid); if (!u) return false; return u.has(inf.w + '-' + p); };
    const instLocked = (i) => { const l = lessons.get(i.lid); const t = teachers.get(i.tid); const o = teachers.get(i.origTid || i.tid); return !!((l && l.k) || lockedSubj.has(i.subj) || (t && t.locked) || (o && o.locked)); };
    // 横並び(複数教師)の授業では、副担当は交換・欠勤・重複の判定に含めない。メイン=副担当でない教師。
    // 副担当はクラス単位で指定する({tid,subj,cls})。cls を省略した指定は、その科目の全クラスに適用する。
    const subRoles = new Set((state.subRoles || []).map((r) => r.tid + '|' + r.subj + '|' + (r.cls || '*')));
    const isSubRole = (x) => { const t = x.origTid || x.tid; return subRoles.has(t + '|' + x.subj + '|' + x.cls) || subRoles.has(t + '|' + x.subj + '|*'); };
    // arr: 同じ日・時限・クラスの授業(unit)。副担当を除く。全員が副担当指定なら全員をメインとみなす。
    const mains = (arr) => { const m = arr.filter((x) => !isSubRole(x)); return m.length ? m : arr; };
    const isMainIn = (arr, x) => mains(arr).includes(x);
    const unitLocked = (arr) => arr.some((x) => { const l = lessons.get(x.lid); return !!((l && l.k) || lockedSubj.has(x.subj)); }) || mains(arr).some(instLocked);
    const isSpecialRoom = (r) => !!r && !/^\d-\d$/.test(r);
    return { S, state, teachers, lessons, slot, build, dayInfo, isAbsent, isUnavail, instLocked, unitLocked, mains, isMainIn, isSubRole, isSpecialRoom, evOn, tableOf };
  }

  /* ---------- 欠勤による「要対応コマ」の抽出 ---------- */
  function affectedUnits(ctx, today) {
    const units = new Map();
    const seen = new Set();
    for (const a of ctx.state.absences || []) {
      if (today && a.date < today) continue;
      const k0 = a.tid + '|' + a.date;
      if (seen.has(k0)) continue; seen.add(k0);
      for (let p = 1; p <= PERIODS; p++) {
        if (!ctx.isAbsent(a.tid, a.date, p)) continue;
        const sl = ctx.slot(a.date, p);
        for (const x of sl) {
          if (x.tid !== a.tid) continue;
          if (!ctx.isMainIn(sl.filter((y) => y.cls === x.cls), x)) continue; // 副担当の欠勤は授業に影響しない
          const key = a.date + '|' + p + '|' + x.cls;
          if (!units.has(key)) units.set(key, { date: a.date, period: p, cls: x.cls });
        }
      }
    }
    return [...units.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
  }

  /* ---------- 履歴からの負担集計(交換先バランス) ---------- */
  // range: {from,to}(省略時は設定の balanceFrom / balanceTo)。{from:'',to:''} で全期間。
  function inRange(h, from, to) { return !(h.date && ((from && h.date < from) || (to && h.date > to))); }
  function stats(state, range) {
    const S = Object.assign(defaultSettings(), state.settings || {});
    const from = range ? range.from : S.balanceFrom, to = range ? range.to : S.balanceTo;
    const rows = new Map(state.teachers.map((t) => [t.id, { tid: t.id, partner: 0, cover: 0, involved: 0, absent: 0 }]));
    const bump = (tid, f) => { const r = rows.get(tid); if (r) r[f]++; };
    for (const h of state.history || []) {
      if (!inRange(h, from, to)) continue;
      for (const it of h.items || []) {
        (it.absTids || []).forEach((t) => bump(t, 'absent'));
        if (it.kind === 'swap') {
          it.b.tids.forEach((t) => bump(t, 'partner'));
          it.a.tids.filter((t) => !(it.absTids || []).includes(t)).forEach((t) => bump(t, 'involved'));
        } else if (it.kind === 'cover') bump(it.by, 'cover');
        else if (it.kind === 'merge') (it.partners || []).forEach((t) => bump(t, 'cover'));
      }
    }
    for (const r of rows.values()) r.load = r.partner + r.cover;
    return rows;
  }

  /* ---------- 履歴からの学習 ----------
   * 過去の交換(採用した案・手入力の記録)から、この学校らしい交換の傾向を取り出す。
   *  - 日数の離れ方 / 相手の授業の時限 / 同じ教科どうしか / 同じ週か / 欠勤した先生と相手の先生の組み合わせ
   *  - 交換と、補欠・合同のどちらをよく使うか
   * score(候補) は 0(傾向から遠い)〜1(傾向に近い)。履歴が3件未満なら使わない(conf=0)。 */
  function learnProfile(state) {
    const S = Object.assign(defaultSettings(), state.settings || {});
    const tmap = new Map(state.teachers.map((t) => [t.id, t]));
    const dept = (id) => (tmap.get(id) || {}).dept || '';
    const sw = []; let others = 0;
    for (const h of state.history || []) for (const it of h.items || []) {
      if (it.aux) continue; // 連鎖の前提交換は、欠勤とは無関係の動きなので学習に使わない
      if (it.kind === 'swap') sw.push(it); else if (it.kind === 'cover' || it.kind === 'merge') others++;
    }
    const n = sw.length, total = n + others;
    const conf = S.learn && n >= 3 ? Math.min(1, n / 10) : 0;
    const dist = new Map(), per = new Map(), pair = new Map(), pairMax = new Map();
    let sameDept = 0, sameWeek = 0, sumDist = 0;
    const wk = (d) => addDays(d, -((dow(d) + 6) % 7));
    const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const it of sw) {
      if (!it.a || !it.b) continue;
      inc(dist, it.dayDist || 0); sumDist += it.dayDist || 0; if (it.b.period) inc(per, it.b.period);
      const A = it.absTids && it.absTids.length ? it.absTids : (it.a.tids || []);
      for (const ta of A) for (const tb of it.b.tids || []) { const k = ta + '|' + tb; inc(pair, k); pairMax.set(ta, Math.max(pairMax.get(ta) || 0, pair.get(k))); }
      if (A.some((ta) => (it.b.tids || []).some((tb) => dept(ta) && dept(ta) === dept(tb)))) sameDept++;
      if (it.a.date && it.b.date && wk(it.a.date) === wk(it.b.date)) sameWeek++;
    }
    const sd = (d) => (dist.get(d) || 0) + 0.5 * ((dist.get(d - 1) || 0) + (dist.get(d + 1) || 0)); // 近い日数も少し評価する
    const maxSd = Math.max(0, ...[...dist.keys()].map(sd)), maxPer = Math.max(0, ...per.values());
    const rCover = total ? others / total : 0;
    function score(c) {
      if (!n) return null;
      const parts = [];
      parts.push(maxSd ? sd(c.dayDist) / maxSd : 0);
      parts.push(maxPer ? (per.get(c.p1) || 0) / maxPer : 0);
      const same = c.TA.some((ta) => c.TB.some((tb) => dept(ta) && dept(ta) === dept(tb)));
      parts.push(same ? sameDept / n : 1 - sameDept / n);
      parts.push(c.cross ? 1 - sameWeek / n : sameWeek / n);
      let best = null;
      for (const ta of c.TA) { const mx = pairMax.get(ta); if (!mx) continue; for (const tb of c.TB) { const v = (pair.get(ta + '|' + tb) || 0) / mx; best = best === null ? v : Math.max(best, v); } }
      if (best !== null) parts.push(best);
      return parts.reduce((s, x) => s + x, 0) / parts.length;
    }
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return {
      n, conf, rCover, score,
      summary: {
        n, others, conf, avgDist: n ? sumDist / n : 0, sameDayRate: n ? (dist.get(0) || 0) / n : 0, sameWeekRate: n ? sameWeek / n : 0, sameDeptRate: n ? sameDept / n : 0, coverRate: rCover,
        pairs: top(pair, 5).map(([k, c]) => ({ a: k.split('|')[0], b: k.split('|')[1], count: c })),
        periods: top(per, 3).map(([p, c]) => ({ period: p, count: c })),
      },
    };
  }

  /* ---------- 交換案の生成 ---------- */
  function propose(state, opts) {
    opts = opts || {};
    const ctx = makeCtx(state);
    const S = ctx.S, W = S.weights;
    const today = opts.today || '0000-00-00';
    const LP = learnProfile(state);
    const learnCover = LP.conf > 0 ? W.learn * LP.conf * (1 - LP.rCover) : 0; // 補欠・合同を使ってきた割合が低いほど加点
    const skip = new Set(opts.skip || []); // 授業変更が不要とチェックされたコマ(date|period|cls)
    const units = affectedUnits(ctx, today).filter((u) => !skip.has(u.date + '|' + u.period + '|' + u.cls));
    const hist = stats(state);
    const eligible = state.teachers.filter((t) => !t.locked && !t.noCover && [state.lessons].concat((state.tables || []).map((q) => q.lessons)).some((ls) => ls.some((l) => l.t === t.id))).map((t) => t.id);

    const key = (d, p) => d + '|' + p;
    const getSlot = (st, d, p) => st.overlay.get(key(d, p)) || ctx.slot(d, p);
    const loadOf = (st, tid) => ((hist.get(tid) || {}).load || 0) + (st.use.get(tid) || 0);
    const minLoad = (st) => { let m = Infinity; for (const t of eligible) m = Math.min(m, loadOf(st, t)); return m === Infinity ? 0 : m; };
    const dailyCount = (st, tid, d) => { let n = 0; for (let p = 1; p <= PERIODS; p++) for (const x of getSlot(st, d, p)) if (x.tid === tid) n++; return n; };
    const excess = (n) => Math.max(0, n - S.maxPerDay);
    const freeFor = (st, tid, d, p, excl) => {
      if (ctx.isAbsent(tid, d, p) || ctx.isUnavail(tid, d, p)) return false;
      const sl = getSlot(st, d, p);
      return !sl.some((x) => x.tid === tid && !excl.includes(x) && ctx.isMainIn(sl.filter((y) => y.cls === x.cls), x));
    };
    const roomsOf = (arr) => arr.map((x) => x.room).filter(ctx.isSpecialRoom);
    const roomsFree = (st, d, p, excl, rooms) => {
      const other = getSlot(st, d, p).filter((x) => !excl.includes(x)).map((x) => x.room);
      return rooms.every((r) => !other.includes(r));
    };
    const uniq = (a) => [...new Set(a)];
    const tidsOf = (arr) => uniq(arr.map((x) => x.tid));
    const nameOf = (tid) => (ctx.teachers.get(tid) || {}).name || tid;

    const weekStart = (d) => addDays(d, -((dow(d) + 6) % 7)); // その日を含む週の月曜日
    // 交換期間は「授業日」で数える(土日・祝日・授業なしの日は日数に含めない)。距離も授業日差。
    const isSchoolDay = (d) => ctx.dayInfo(d).w >= 1;
    function windowDates(d0) {
      const out = [{ d: d0, dist: 0 }];
      let n = 0;
      for (let d = addDays(d0, 1); n < S.windowDays; d = addDays(d, 1)) { if (isSchoolDay(d)) n++; out.push({ d, dist: n }); if (diffDays(d0, d) > 400) break; }
      if (S.allowBefore) {
        n = 0;
        for (let d = addDays(d0, -1); n < S.beforeDays; d = addDays(d, -1)) { if (d < today) break; if (isSchoolDay(d)) n++; out.push({ d, dist: n }); }
      }
      return out;
    }

    function describe(arr) {
      const mn = ctx.mains(arr);
      return { date: arr[0].date, period: arr[0].period, cls: arr[0].cls, tids: tidsOf(mn), lessons: arr.map((x) => ({ lid: x.lid, tid: x.tid, subj: x.subj, room: x.room, sub: !mn.includes(x) })) };
    }

    /* 1つの交換候補(Aのコマ ⇄ d1,p1のコマ)を検査してコストを付ける。
     * 成立=>{cand} / 先生の重複だけが原因=>{blocked:[重複しているコマ]} / 不可=>null */
    function evalSwap(st, A, d1, p1, dayDist, avoid) {
      const d0 = A.date, p0 = A.period, IA = A.insts;
      if (d1 === d0 && p1 === p0) return null;
      if (avoid && avoid.includes(key(d1, p1))) return null;
      const IB = getSlot(st, d1, p1).filter((x) => x.cls === A.cls);
      if (!IB.length) return null;
      if (ctx.unitLocked(IB)) return null;
      if (S.avoidReswap && IB.some((x) => x.moved || x.covered)) return null;
      // 週(月曜始まり)をまたぐか。only なら同じ週の授業とだけ交換する
      const cross = weekStart(d1) !== weekStart(d0);
      if (cross && S.weekMode === 'only') return null;
      // 横並びの授業は、メインの先生だけを考える(副担当は空き・重複・負担の判定に含めない)
      const TA = tidsOf(ctx.mains(IA)), TB = tidsOf(ctx.mains(IB));
      const conflicts = [];
      const s0 = getSlot(st, d0, p0), s1 = getSlot(st, d1, p1);
      const busy = (sl, x) => ctx.isMainIn(sl.filter((y) => y.cls === x.cls), x); // その先生がメインとして入っているコマだけ重複とみなす
      for (const t of TB) {
        if (ctx.isAbsent(t, d0, p0) || ctx.isUnavail(t, d0, p0)) return null;
        s0.forEach((x) => { if (x.tid === t && !IA.includes(x) && busy(s0, x)) conflicts.push(x); });
      }
      for (const t of TA) {
        if (ctx.isAbsent(t, d1, p1) || ctx.isUnavail(t, d1, p1)) return null;
        s1.forEach((x) => { if (x.tid === t && !IB.includes(x) && busy(s1, x)) conflicts.push(x); });
      }
      if (!roomsFree(st, d0, p0, IA, roomsOf(IB))) return null;
      if (!roomsFree(st, d1, p1, IB, roomsOf(IA))) return null;
      if (conflicts.length) return { blocked: conflicts, d1, p1, dayDist };
      // 同じ日に同じクラスで同じ科目が重ならないか(交換で新たに動いた先の日だけ検査)
      let dup = false;
      if (d1 !== d0 && S.sameDay !== 'allow') {
        const hit = (date, skipP, subs) => { for (let q = 1; q <= PERIODS; q++) { if (q === skipP) continue; if (getSlot(st, date, q).some((x) => x.cls === A.cls && subs.includes(x.subj))) return true; } return false; };
        dup = hit(d1, p1, uniq(IA.map((x) => x.subj))) || hit(d0, p0, uniq(IB.map((x) => x.subj)));
        if (dup && S.sameDay === 'forbid') return null;
      }
      let c = W.swap + W.day * dayDist + W.teacher * ((TA.length - 1) + (TB.length - 1));
      const ml = minLoad(st);
      for (const t of TB) {
        c += W.balance * Math.max(0, loadOf(st, t) - ml);
        c += W.load * excess(dailyCount(st, t, d0) - (TA.includes(t) ? 1 : 0) + 1);
      }
      for (const t of TA) c += W.load * excess(dailyCount(st, t, d1) - (TB.includes(t) ? 1 : 0) + 1);
      if (dup) c += W.dup;
      if (cross && S.weekMode === 'prefer') c += W.week;
      // 履歴の傾向から遠いほど加点する(傾向に近い案が上位に来る)。交換より補欠・合同を多く使ってきた学校では交換にも少し加点
      let learn = null;
      if (LP.conf > 0) {
        learn = LP.score({ TA, TB, dayDist, p1, cross });
        if (learn !== null) c += W.learn * LP.conf * (1 - learn);
        c += W.learn * LP.conf * LP.rCover;
      }
      return { cand: { kind: 'swap', IA, IB, TA, TB, d1, p1, dayDist, dup, cross, learn, cost: c } };
    }

    function swapCandidates(st, A, absTids, avoid, wantBlocked) {
      if (ctx.unitLocked(A.insts)) return wantBlocked ? { cands: [], blocked: [] } : [];
      const out = [], blocked = [];
      for (const { d: d1, dist } of windowDates(A.date)) {
        for (let p1 = 1; p1 <= PERIODS; p1++) {
          const r = evalSwap(st, A, d1, p1, dist, avoid);
          if (!r) continue;
          if (r.cand) out.push(r.cand); else blocked.push(r);
        }
      }
      out.sort((x, y) => x.cost - y.cost);
      return wantBlocked ? { cands: out, blocked } : out;
    }

    /* 連鎖交換: 先生の重複で成立しない交換を、重複しているコマを同じクラスの別コマと先に交換して成立させる */
    function chainCandidates(st, A, absTids) {
      const { blocked } = swapCandidates(st, A, absTids, null, true);
      blocked.sort((x, y) => x.dayDist - y.dayDist || x.blocked.length - y.blocked.length);
      const results = [];
      for (const bl of blocked.slice(0, 30)) {
        const confUnits = [];
        for (const x of bl.blocked) {
          if (!confUnits.some((u) => u.date === x.date && u.period === x.period && u.cls === x.cls)) confUnits.push({ date: x.date, period: x.period, cls: x.cls, tids: [] });
          confUnits.find((u) => u.date === x.date && u.period === x.period && u.cls === x.cls).tids.push(x.tid);
        }
        if (confUnits.length > S.chainMax) continue;
        const avoid = [key(A.date, A.period), key(bl.d1, bl.p1)];
        let states = [st];
        for (const cu of confUnits) {
          const nextStates = [];
          for (const cs of states) {
            const insts = getSlot(cs, cu.date, cu.period).filter((x) => x.cls === cu.cls);
            if (!insts.length || ctx.mains(insts).some((x) => ctx.isAbsent(x.tid, cu.date, cu.period)) || insts.some((x) => x.moved || x.covered)) continue;
            const AU = { date: cu.date, period: cu.period, cls: cu.cls, insts };
            for (const c of swapCandidates(cs, AU, [], avoid).slice(0, states.length === 1 ? 2 : 1)) {
              c.cost += W.chain;
              const n = applySwap(cs, AU, c, []);
              const it = n.items[n.items.length - 1];
              it.aux = { frees: uniq(cu.tids), date: cu.date, period: cu.period };
              nextStates.push(n);
            }
          }
          states = nextStates;
          if (!states.length) break;
        }
        for (const cs of states) {
          const IA = getSlot(cs, A.date, A.period).filter((x) => x.cls === A.cls);
          const r = evalSwap(cs, { date: A.date, period: A.period, cls: A.cls, insts: IA }, bl.d1, bl.p1, bl.dayDist, null);
          if (r && r.cand) results.push(applySwap(cs, { date: A.date, period: A.period, cls: A.cls, insts: IA }, r.cand, absTids));
        }
      }
      results.sort((x, y) => x.cost - y.cost);
      return results;
    }

    function mergeCandidate(st, A, absInsts) {
      const present = A.insts.filter((x) => !absInsts.includes(x));
      if (!present.length) return null;
      const subj = uniq(absInsts.map((x) => x.subj));
      if (!present.every((x) => subj.includes(x.subj))) return null; // 別科目(選択ブロック等)は合同にできない
      return { kind: 'merge', absInsts, partners: tidsOf(present), cost: W.merge + learnCover };
    }

    function coverCandidates(st, A, inst) {
      const ml = minLoad(st);
      const absDept = (ctx.teachers.get(inst.tid) || {}).dept;
      const out = [];
      for (const t of state.teachers) {
        if (t.noCover || t.id === inst.tid) continue;
        if (!freeFor(st, t.id, A.date, A.period, [])) continue;
        if (inst.room && ctx.isSpecialRoom(inst.room) === false) { /* 教室制約なし */ }
        let c = W.cover + learnCover + (t.dept === absDept ? 0 : W.mismatch) + W.balance * Math.max(0, loadOf(st, t.id) - ml)
          + W.load * excess(dailyCount(st, t.id, A.date) + 1);
        out.push({ kind: 'cover', inst, by: t.id, cost: c });
      }
      out.sort((x, y) => x.cost - y.cost);
      return out;
    }

    /* ----- 状態の更新(overlayはコピーオンライト) ----- */
    function cloneState(st) { return { overlay: new Map(st.overlay), use: new Map(st.use), cost: st.cost, items: st.items.slice(), moves: st.moves.slice() }; }
    function applySwap(st, A, c, absTids) {
      const n = cloneState(st);
      const d0 = A.date, p0 = A.period, d1 = c.d1, p1 = c.p1;
      const s0 = getSlot(st, d0, p0).filter((x) => !c.IA.includes(x));
      const s1 = getSlot(st, d1, p1).filter((x) => !c.IB.includes(x));
      const mv = (x, d, p) => Object.assign({}, x, { date: d, period: p, moved: true });
      n.overlay.set(key(d0, p0), s0.concat(c.IB.map((x) => mv(x, d0, p0))));
      n.overlay.set(key(d1, p1), s1.concat(c.IA.map((x) => mv(x, d1, p1))));
      const item = { kind: 'swap', a: describe(c.IA), b: describe(c.IB), absTids, dayDist: c.dayDist, dup: !!c.dup, cross: !!c.cross, learn: c.learn == null ? null : Math.round(c.learn * 100), cost: c.cost };
      for (const x of c.IA) n.moves.push({ kind: 'move', lid: x.lid, fromDate: d0, fromPeriod: p0, toDate: d1, toPeriod: p1 });
      for (const x of c.IB) n.moves.push({ kind: 'move', lid: x.lid, fromDate: d1, fromPeriod: p1, toDate: d0, toPeriod: p0 });
      c.TB.forEach((t) => n.use.set(t, (n.use.get(t) || 0) + 1));
      n.items.push(item); n.cost += c.cost;
      return n;
    }
    function applyCover(st, A, c) {
      const n = cloneState(st);
      const cur = getSlot(st, A.date, A.period);
      n.overlay.set(key(A.date, A.period), cur.map((x) => (x === c.inst ? Object.assign({}, x, { origTid: x.tid, tid: c.by, covered: true }) : x)));
      n.moves.push({ kind: 'cover', lid: c.inst.lid, date: A.date, period: A.period, by: c.by });
      n.use.set(c.by, (n.use.get(c.by) || 0) + 1);
      n.items.push({ kind: 'cover', a: describe([c.inst]), by: c.by, absTids: [c.inst.tid], cost: c.cost });
      n.cost += c.cost;
      return n;
    }
    function applyMerge(st, A, c) {
      const n = cloneState(st);
      const cur = getSlot(st, A.date, A.period);
      n.overlay.set(key(A.date, A.period), cur.filter((x) => !c.absInsts.includes(x)));
      for (const x of c.absInsts) n.moves.push({ kind: 'merge', lid: x.lid, date: A.date, period: A.period });
      c.partners.forEach((t) => n.use.set(t, (n.use.get(t) || 0) + 1));
      n.items.push({ kind: 'merge', a: describe(c.absInsts), partners: c.partners, absTids: uniq(c.absInsts.map((x) => x.tid)), cost: c.cost });
      n.cost += c.cost;
      return n;
    }
    function unresolved(st, A, insts) {
      const n = cloneState(st);
      n.items.push({ kind: 'unresolved', a: describe(insts), absTids: uniq(insts.map((x) => x.tid)), cost: W.unresolved });
      n.cost += W.unresolved;
      return n;
    }

    /* ----- 1単位(欠勤コマ)を解決する全候補 ----- */
    function expand(st, u) {
      const cur = getSlot(st, u.date, u.period).filter((x) => x.cls === u.cls);
      const absInsts = ctx.mains(cur).filter((x) => ctx.isAbsent(x.tid, u.date, u.period)); // 副担当の欠勤は無視
      if (!absInsts.length) return [st]; // 他の交換で既に解消済み
      const A = { date: u.date, period: u.period, cls: u.cls, insts: cur };
      const absTids = uniq(absInsts.map((x) => x.tid));
      const res = [];
      const sw = swapCandidates(st, A, absTids);
      sw.slice(0, 8).forEach((c) => res.push(applySwap(st, A, c, absTids)));
      const ch = S.chain && !ctx.unitLocked(A.insts) ? chainCandidates(st, A, absTids) : [];
      ch.slice(0, 4).forEach((n) => res.push(n));
      const mode = S.coverMode;
      if (mode === 'equal' || (mode === 'fallback' && !sw.length && !ch.length)) {
        const mg = mergeCandidate(st, A, absInsts);
        if (mg) res.push(applyMerge(st, A, mg));
        // 欠勤者が複数いる場合は1人目の補欠を分岐し、残りは最良候補で順に埋める
        const first = coverCandidates(st, A, absInsts[0]).slice(0, 3);
        for (const c0 of first) {
          let n = applyCover(st, A, c0), ok = true;
          for (const rest of absInsts.slice(1)) {
            const curr = getSlot(n, A.date, A.period).find((x) => x.lid === rest.lid);
            const cs = coverCandidates(n, A, curr);
            if (!cs.length) { ok = false; break; }
            n = applyCover(n, A, cs[0]);
          }
          if (ok) res.push(n);
        }
      }
      if (!res.length) res.push(unresolved(st, A, absInsts));
      return res;
    }

    /* ----- ビームサーチ ----- */
    const BEAM = 40;
    let beam = [{ overlay: new Map(), use: new Map(), cost: 0, items: [], moves: [] }];
    for (const u of units) {
      const next = [];
      for (const st of beam) next.push(...expand(st, u));
      next.sort((a, b) => a.cost - b.cost);
      const seen = new Set(), keep = [];
      for (const st of next) {
        const sig = st.moves.map((m) => JSON.stringify(m)).join('');
        if (seen.has(sig)) continue;
        seen.add(sig); keep.push(st);
        if (keep.length >= BEAM) break;
      }
      beam = keep;
    }
    /* 交換される先生(欠勤の先生を除く)の、その日の空き時間。before=交換前、after=この案を適用した後 */
    const absentT = new Set((state.absences || []).map((a) => a.tid));
    const freeOn = (get, tid, date) => {
      let n = 0;
      for (let p = 1; p <= PERIODS; p++) {
        const sl = get(date, p);
        const busy = sl.some((x) => x.tid === tid && ctx.isMainIn(sl.filter((y) => y.cls === x.cls), x));
        if (!busy && !ctx.isUnavail(tid, date, p)) n++;
      }
      return n;
    };
    function freeInfo(st) {
      const pairs = new Map();
      const add = (tid, date) => { if (tid && !absentT.has(tid)) pairs.set(tid + '|' + date, { tid, date }); };
      for (const it of st.items) {
        if (it.kind === 'swap') { it.b.tids.forEach((t) => add(t, it.a.date)); it.a.tids.filter((t) => !(it.absTids || []).includes(t)).forEach((t) => add(t, it.b.date)); }
        else if (it.kind === 'cover') add(it.by, it.a.date);
        else if (it.kind === 'merge') (it.partners || []).forEach((t) => add(t, it.a.date));
      }
      const list = [...pairs.values()].map(({ tid, date }) => ({ tid, date, before: freeOn(ctx.slot, tid, date), after: freeOn((d, p) => getSlot(st, d, p), tid, date) }));
      const avg = (k) => (list.length ? list.reduce((s, x) => s + x[k], 0) / list.length : 0);
      return { list, avg: avg('before'), avgAfter: avg('after') };
    }
    const plans = beam.slice(0, S.maxPlans).map((st, i) => {
      const sw = st.items.filter((x) => x.kind === 'swap');
      const involved = uniq([].concat(...st.items.map((x) => (x.kind === 'swap' ? x.b.tids.concat(x.a.tids) : x.kind === 'cover' ? [x.by] : x.kind === 'merge' ? x.partners : []))));
      return {
        rank: i + 1, cost: Math.round(st.cost * 10) / 10, items: st.items, moves: st.moves,
        stats: {
          swaps: sw.length, crossWeek: sw.filter((x) => x.cross).length, chain: sw.filter((x) => x.aux).length, covers: st.items.filter((x) => x.kind === 'cover').length, merges: st.items.filter((x) => x.kind === 'merge').length,
          unresolved: st.items.filter((x) => x.kind === 'unresolved').length,
          avgDays: sw.length ? sw.reduce((s, x) => s + x.dayDist, 0) / sw.length : 0, maxDays: sw.reduce((m, x) => Math.max(m, x.dayDist), 0),
          teachers: involved,
          free: freeInfo(st),
        },
      };
    });
    return { plans, units, nameOf };
  }

  /* 採用した案を履歴エントリにする */
  function makeHistoryEntry(plan, meta) {
    meta = meta || {};
    const dates = plan.items.map((x) => x.a.date).sort();
    return {
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: meta.now || new Date().toISOString(),
      date: dates[0] || '',
      note: meta.note || '',
      items: plan.items.filter((x) => x.kind !== 'unresolved'),
      moves: plan.moves,
    };
  }

  /* 実授業の矛盾チェック(教師の重複・教室の重複・欠勤者の授業残り) */
  function validate(state, dates) {
    const ctx = makeCtx(state);
    const problems = [];
    for (const d of dates) {
      for (let p = 1; p <= PERIODS; p++) {
        const sl = ctx.slot(d, p);
        const seenT = new Map(), seenR = new Map();
        for (const x of sl) {
          const sub = !ctx.isMainIn(sl.filter((y) => y.cls === x.cls), x); // 副担当は判定しない
          if (!sub) {
            if (seenT.has(x.tid)) problems.push({ type: 'teacher-dup', date: d, period: p, tid: x.tid });
            seenT.set(x.tid, x);
          }
          if (ctx.isSpecialRoom(x.room)) { const y = seenR.get(x.room); if (y && y.cls !== x.cls) problems.push({ type: 'room-dup', date: d, period: p, room: x.room }); seenR.set(x.room, x); }
          if (sub) continue;
          if (ctx.isAbsent(x.tid, d, p)) problems.push({ type: 'absent-has-lesson', date: d, period: p, tid: x.tid });
          if (ctx.isUnavail(x.tid, d, p) && !x.covered) problems.push({ type: 'unavailable', date: d, period: p, tid: x.tid });
        }
      }
    }
    return problems;
  }

  /* 過去に行った交換・補欠を手入力で履歴にする。
   * spec = { kind:'swap', a:{date,period,cls}, b:{date,period} }   a=休みの先生の授業、b=入れ替えた相手の授業(同じクラス)
   *      | { kind:'cover', a:{date,period,cls,lid}, by:教師id }
   *      | { kind:'move', a:{date,period,lid か cls}, to:{date,period} }   授業を別のコマへ移動(移動先に同じクラスの授業があってもよい)
   * 戻り値 { entry, problems } か { error }。problems は記録後に新しく生じた先生・教室の重複など(記録自体は行える)。 */
  function makeManualEntry(state, spec) {
    const ctx = makeCtx(state);
    const uniq = (a) => [...new Set(a)];
    const desc = (arr) => { const mn = ctx.mains(arr); return { date: arr[0].date, period: arr[0].period, cls: arr[0].cls, tids: uniq(mn.map((x) => x.tid)), lessons: arr.map((x) => ({ lid: x.lid, tid: x.tid, subj: x.subj, room: x.room, sub: !mn.includes(x) })) }; };
    const schoolDist = (d0, d1) => { let a = d0 <= d1 ? d0 : d1; const b = d0 <= d1 ? d1 : d0; let n = 0; for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (ctx.dayInfo(d).w >= 1) n++; return n; };
    let items, moves, classDup = false;
    if (spec.kind === 'swap') {
      const { a, b } = spec;
      if (!a || !b || !a.date || !b.date || !a.period || !b.period) return { error: '日付と時限を入力してください。' };
      if (a.date === b.date && +a.period === +b.period) return { error: '同じコマどうしは交換できません。' };
      const IA = ctx.slot(a.date, +a.period).filter((x) => x.cls === a.cls);
      const IB = ctx.slot(b.date, +b.period).filter((x) => x.cls === a.cls);
      if (!IA.length) return { error: '交換元の授業が見つかりません。' };
      if (!IB.length) return { error: '交換先に同じクラス(' + a.cls + ')の授業がありません。' };
      items = [{ kind: 'swap', a: desc(IA), b: desc(IB), absTids: uniq(ctx.mains(IA).map((x) => x.tid)), dayDist: schoolDist(a.date, b.date), manual: true, cost: 0 }];
      moves = IA.map((x) => ({ kind: 'move', lid: x.lid, fromDate: a.date, fromPeriod: +a.period, toDate: b.date, toPeriod: +b.period }))
        .concat(IB.map((x) => ({ kind: 'move', lid: x.lid, fromDate: b.date, fromPeriod: +b.period, toDate: a.date, toPeriod: +a.period })));
    } else if (spec.kind === 'cover') {
      const { a, by } = spec;
      const inst = a && ctx.slot(a.date, +a.period).find((x) => x.lid === a.lid);
      if (!inst) return { error: '補欠にした授業が見つかりません。' };
      if (!by || by === inst.tid) return { error: '補欠に入った先生を選んでください。' };
      items = [{ kind: 'cover', a: desc([inst]), by, absTids: [inst.tid], manual: true, cost: 0 }];
      moves = [{ kind: 'cover', lid: inst.lid, date: a.date, period: +a.period, by }];
    } else if (spec.kind === 'move') {
      const { a, to } = spec;
      if (!a || !to || !a.date || !to.date || !a.period || !to.period) return { error: '日付と時限を入力してください。' };
      if (a.date === to.date && +a.period === +to.period) return { error: '移動先が元と同じコマです。' };
      // a.lid があればその授業だけ、なければ同じクラスの授業をまとめて動かす
      const IA = ctx.slot(a.date, +a.period).filter((x) => (a.lid ? x.lid === a.lid : x.cls === a.cls));
      if (!IA.length) return { error: '移動した授業が見つかりません。' };
      a.cls = IA[0].cls;
      if (ctx.dayInfo(to.date).w === 0) return { error: '移動先の日は授業日ではありません。' };
      classDup = ctx.slot(to.date, +to.period).some((x) => x.cls === a.cls); // 移動先に同じクラスの授業があっても移動できる(注意として知らせる)
      items = [{ kind: 'move', a: desc(IA), to: { date: to.date, period: +to.period }, absTids: uniq(ctx.mains(IA).map((x) => x.tid)), dayDist: schoolDist(a.date, to.date), manual: true, cost: 0 }];
      moves = IA.map((x) => ({ kind: 'move', lid: x.lid, fromDate: a.date, fromPeriod: +a.period, toDate: to.date, toPeriod: +to.period }));
    } else return { error: '種類が不明です。' };
    const entry = makeHistoryEntry({ items, moves }, { note: '手入力' });
    entry.manual = true;
    const dates = uniq(items.flatMap((i) => [i.a.date, i.b ? i.b.date : i.to ? i.to.date : i.a.date]));
    const key = (p) => p.type + '|' + p.date + '|' + p.period + '|' + (p.tid || p.room || '');
    const before = new Set(validate(state, dates).map(key));
    const problems = validate(Object.assign({}, state, { history: (state.history || []).concat([entry]) }), dates).filter((p) => !before.has(key(p)));
    if (classDup) problems.push({ type: 'class-dup', date: spec.to.date, period: +spec.to.period });
    return { entry, problems };
  }

  const api = {
    PERIODS, DAY_NAMES, HOLIDAYS, defaultSettings, makeCtx, affectedUnits, propose, stats, makeHistoryEntry, makeManualEntry, learnProfile, validate, inRange,
    util: { toMs, fromMs, addDays, dow, diffDays, fmtMD, dateRange },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JK = api;
})(typeof window !== 'undefined' ? window : globalThis);
