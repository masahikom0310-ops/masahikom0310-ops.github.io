/* 定期テスト監督割り当てエンジン(UI非依存)。node test.js でも動く。
   state = {
     teachers:[{id,name,dept,noCover,maxCount}],  // maxCount=予備以外の監督回数の上限(未指定/nullなら無制限)
     lessons:[{id,t,d,p,s,c,r}],        // 通常授業(曜日1-5,時限)。出題者推定・教員の多忙判定に使う
     subRoles:[{tid,subj,cls}],         // 副担当(出題者候補から除外)
     classes:[clsName,...],             // 監督対象のクラス一覧
     testDays:[{id,date:'YYYY-MM-DD',note}],
     periods:[1,2,...],                 // テストを実施する時限
     exams:{ 'dayId|period|cls': {subject} },      // 空/未設定 = その時限その組は試験なし。subjectは実教科名、または教科グループ名
     setters:{ 'subject|cls': [teacherId,...] },     // 出題者の手動指定(未指定なら自動推定)。キーは実教科名。最大2人まで想定
     examSubjects:{ cls: [subject,...] },           // 試験を実施すると決定した教科(未設定なら全教科を候補にする)
     subjectGroups:[{id,grade,name,subjects:[subject,...]}], // 選択科目をまとめた教科グループ。クラス単位ではなく学年単位。
                                         // 試験時間割でそのグループ名を選んだクラスを基準に、含まれる各教科の出題者を調べる
                                         // グループ内の教科のうち、examSubjects[cls]でチェックされていない(試験なし)教科は、
                                         // そのクラスのそのコマでは「自習」としてまとめて1つの監督(見守り)枠になる(他の教科はそれぞれ試験監督のまま)
                                         // 監督(assignments/examLocations)は、教科グループについてはクラスごとではなく学年+グループ単位
                                         // (同じ学年の複数クラスの生徒が同じ場所に集まって受けるため)。そのキーは
                                         // 'dayId|period|__group:grade:groupName[|memberSubject]' の仮想クラス名を使う(groupSlotCls参照)
     absences:[{id,teacherId,start,end,periods:'all'|[...],type,note}],
     assignments:{ 'dayId|period|cls[|memberSubject]': {teacherId,locked} },  // cls='__reserveN' は予備(バックアップ)監督。
                                         // exams[key]に教科がないコマ(自習)も同じキー形式で見守り教員を割り当てる。
                                         // 教科グループ(選択科目)は、含まれる教科ごとに場所が違うことがあるため、
                                         // 'dayId|period|cls|memberSubject' の形で教科ごとに別々の監督を割り当てる
     reserveCount: 0,           // 試験が行われる各時限に置く予備監督の人数(クラスを指定しない待機役)
     locations:[locationName,...],              // 場所(教室)の選択肢
     examLocations:{ 'dayId|period|cls[|memberSubject]': locationName } // assignmentsと同じキー形式の場所
   }
*/
(function (root) {
  'use strict';

  function slotKey(dayId, period, cls) { return dayId + '|' + period + '|' + cls; }
  function subjClsKey(subject, cls) { return subject + '|' + cls; }
  // 監督割り当て・場所のキー。教科グループの個別教科を指定したときだけ末尾に教科名が付く。
  function monitorKey(dayId, period, cls, memberSubject) {
    return slotKey(dayId, period, cls) + (memberSubject ? ('|' + memberSubject) : '');
  }

  function weekdayOf(dateStr) {
    // 'YYYY-MM-DD' -> 1(月)..5(金), weekend -> null
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    var w = d.getDay(); // 0=日..6=土
    if (w === 0 || w === 6) return null;
    return w; // 1=月..5=金 すでに一致
  }

  function gradeOf(cls) {
    var m = /^(\d+)/.exec(cls);
    return m ? m[1] : cls;
  }

  function subjectCandidates(lessons, cls) {
    var set = {};
    lessons.forEach(function (l) { if (l.c === cls) set[l.s] = true; });
    return Object.keys(set).sort();
  }

  function setterCandidates(lessons, subRoles, subject, cls) {
    var subIds = {};
    (subRoles || []).forEach(function (r) {
      if (r.subj === subject && r.cls === cls) subIds[r.tid] = true;
    });
    var ids = [];
    lessons.forEach(function (l) {
      if (l.s === subject && l.c === cls && !subIds[l.t] && ids.indexOf(l.t) === -1) ids.push(l.t);
    });
    if (ids.length === 0) {
      // 副担当しかいない場合はそれも候補に残す
      lessons.forEach(function (l) {
        if (l.s === subject && l.c === cls && ids.indexOf(l.t) === -1) ids.push(l.t);
      });
    }
    return ids;
  }

  // 出題者(手動指定分)は複数人(主に2人まで)選べる。戻り値は常に配列。
  function resolveSetter(state, subject, cls) {
    var manual = state.setters && state.setters[subjClsKey(subject, cls)];
    if (Array.isArray(manual)) return manual.filter(function (id) { return !!id; });
    if (manual) return [manual]; // 旧データ(単一ID文字列)との互換
    var cands = setterCandidates(state.lessons, state.subRoles, subject, cls);
    return cands.length ? [cands[0]] : [];
  }

  function groupKey(grade, name) { return grade + '|' + name; }

  // 教科グループ(選択科目)のコマは、同じ学年の複数クラスの生徒が同じ場所に集まって受けるため、
  // 監督はクラスごとではなく学年+グループ名を基準にした仮想クラス名でまとめて扱う。
  function groupSlotCls(grade, groupName) { return '__group:' + grade + ':' + groupName; }
  function isGroupSlotCls(cls) { return typeof cls === 'string' && cls.indexOf('__group:') === 0; }
  function parseGroupSlotCls(cls) {
    if (!isGroupSlotCls(cls)) return null;
    var rest = cls.slice('__group:'.length);
    var idx = rest.indexOf(':');
    if (idx === -1) return null;
    return { grade: rest.slice(0, idx), groupName: rest.slice(idx + 1) };
  }

  function groupLookup(state) {
    var map = {};
    (state.subjectGroups || []).forEach(function (g) { map[groupKey(g.grade, g.name)] = g; });
    return map;
  }

  // subjectLabelがそのクラスの学年にある教科グループ名なら、含まれる実教科を{cls,subject}の配列で返す
  // (出題者はこのclsを基準に調べる)。通常の実教科名ならその1件だけの配列を返す。
  function effectiveSubjects(state, cls, subjectLabel) {
    var g = groupLookup(state)[groupKey(gradeOf(cls), subjectLabel)];
    if (g) return g.subjects.map(function (s) { return { cls: cls, subject: s }; });
    return [{ cls: cls, subject: subjectLabel }];
  }

  // 教科グループの場合は、含まれる実教科それぞれ(元クラスごと)の出題者をまとめて返す(重複除去)。
  function resolveSetters(state, cls, subjectLabel) {
    var members = effectiveSubjects(state, cls, subjectLabel);
    var ids = [];
    members.forEach(function (m) {
      resolveSetter(state, m.subject, m.cls).forEach(function (id) {
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return ids;
  }

  // その(日,時限)に試験が行われているすべての教科(学年・クラスを問わず)の出題者をまとめて返す。
  // 出題者はその時間帯に自分の教科の試験が行われている間、他のどのクラスの監督(自習・予備を含む)
  // にもなれない(2,3年など学年が違っても対象。そのコマに居合わせられないため)。
  function settersAtTime(state, dayId, period) {
    var ids = [];
    listExamSlots(state).forEach(function (slot) {
      if (slot.dayId !== dayId || slot.period !== period) return;
      resolveSetters(state, slot.cls, slot.subject).forEach(function (id) {
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return ids;
  }

  function isAbsent(state, teacherId, dateStr, period) {
    return (state.absences || []).some(function (a) {
      if (a.teacherId !== teacherId) return false;
      if (dateStr < a.start || dateStr > a.end) return false;
      if (a.periods === 'all' || !a.periods) return true;
      return a.periods.indexOf(period) !== -1;
    });
  }

  // その日に実施する時限の一覧。state.dayPeriods[dayId]で上書き(日ごとに実施時限を絞る)していなければ
  // state.periods(試験を実施する時限の全体設定)をそのまま使う。上書きがあっても、全体設定から外れた
  // 時限は常に除外する(全体設定を後から変更した場合に矛盾が残らないように)。
  function periodsForDay(state, dayId) {
    var base = state.periods || [];
    var override = state.dayPeriods && state.dayPeriods[dayId];
    if (!override) return base.slice();
    return base.filter(function (p) { return override.indexOf(p) !== -1; });
  }

  // 日・時限を指定して、試験時間割・監督割り当て・場所の既存データをまとめて消す
  // (その日の時限をオフにしたときに、存在しないコマのデータが残らないようにする)。
  function clearExamDataAt(state, dayId, period) {
    ['exams', 'assignments', 'examLocations'].forEach(function (field) {
      var obj = state[field];
      if (!obj) return;
      Object.keys(obj).forEach(function (key) {
        var parts = key.split('|');
        if (parts[0] === dayId && Number(parts[1]) === period) delete obj[key];
      });
    });
  }

  function hasExam(state, dayId, period, cls) {
    var e = state.exams[slotKey(dayId, period, cls)];
    return !!(e && e.subject);
  }

  function isBusyWithRegularLesson(state, dayId, teacherId, dateStr, period) {
    var weekday = weekdayOf(dateStr);
    if (!weekday) return false;
    var trackedClasses = state.classes || [];
    return state.lessons.some(function (l) {
      if (l.t !== teacherId || l.d !== weekday || l.p !== period) return false;
      // 監督対象クラス(授業交換ナビの監督対象クラス一覧)は、試験か自習かに関わらずこの時間帯は授業が行われないので多忙ではない。
      // 監督対象外のクラス(通常授業がそのまま続いている)だけ多忙とみなす。
      return trackedClasses.indexOf(l.c) === -1;
    });
  }

  function subjectDeptMap(teachers, lessons) {
    var tally = {}; // subject -> {dept: count}
    var byId = {};
    teachers.forEach(function (t) { byId[t.id] = t; });
    lessons.forEach(function (l) {
      var t = byId[l.t];
      if (!t) return;
      tally[l.s] = tally[l.s] || {};
      tally[l.s][t.dept] = (tally[l.s][t.dept] || 0) + 1;
    });
    var map = {};
    Object.keys(tally).forEach(function (s) {
      var best = null, bestN = -1;
      Object.keys(tally[s]).forEach(function (dept) {
        if (tally[s][dept] > bestN) { bestN = tally[s][dept]; best = dept; }
      });
      map[s] = best;
    });
    return map;
  }

  function listExamSlots(state) {
    var slots = [];
    (state.testDays || []).forEach(function (day) {
      periodsForDay(state, day.id).forEach(function (period) {
        (state.classes || []).forEach(function (cls) {
          var e = state.exams[slotKey(day.id, period, cls)];
          if (e && e.subject) {
            slots.push({ dayId: day.id, date: day.date, period: period, cls: cls, subject: e.subject, key: slotKey(day.id, period, cls) });
          }
        });
      });
    });
    slots.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.period !== b.period) return a.period - b.period;
      return a.cls < b.cls ? -1 : (a.cls > b.cls ? 1 : 0);
    });
    return slots;
  }

  function reservePrefix() { return '__reserve'; }
  function isReserveCls(cls) { return typeof cls === 'string' && cls.indexOf(reservePrefix()) === 0; }

  // 試験が行われる各(日,時限)ごとに、クラスを指定しない予備監督の仮コマを作る。
  function listReserveSlots(state) {
    var n = state.reserveCount || 0;
    if (!n) return [];
    var real = listExamSlots(state);
    var dpSeen = {};
    var slots = [];
    real.forEach(function (s) {
      var dp = s.dayId + '|' + s.period;
      if (dpSeen[dp]) return;
      dpSeen[dp] = true;
      for (var i = 1; i <= n; i++) {
        var rcls = reservePrefix() + i;
        slots.push({ dayId: s.dayId, date: s.date, period: s.period, cls: rcls, subject: null, reserve: true, key: slotKey(s.dayId, s.period, rcls) });
      }
    });
    return slots;
  }

  // 試験が入っていない(自習になる)クラスごとのコマ一覧。見守り教員の割り当て対象になる。
  function listSelfStudySlots(state) {
    var slots = [];
    (state.testDays || []).forEach(function (day) {
      periodsForDay(state, day.id).forEach(function (period) {
        (state.classes || []).forEach(function (cls) {
          if (!hasExam(state, day.id, period, cls)) {
            slots.push({ dayId: day.id, date: day.date, period: period, cls: cls, subject: null, selfStudy: true, key: slotKey(day.id, period, cls) });
          }
        });
      });
    });
    return slots;
  }

  // 教科グループ内の自習(試験を実施しない)教科のmonitorKey用プレフィックス。
  // 教科名をそのまま4番目のキー要素にすると、buildStats/teacherGridがキーだけから
  // 「自習かどうか」を判定できなくなるため、教科名の前にこの印を付けて区別する。
  var GROUP_SELFSTUDY_PREFIX = '__selfstudy:';
  function groupSelfStudyMemberKey(subj) { return GROUP_SELFSTUDY_PREFIX + subj; }
  function isGroupSelfStudyMemberKey(memberSubject) {
    return typeof memberSubject === 'string' && memberSubject.indexOf(GROUP_SELFSTUDY_PREFIX) === 0;
  }
  function groupSelfStudySubjectOf(memberSubject) { return memberSubject.slice(GROUP_SELFSTUDY_PREFIX.length); }

  // 監督が必要なコマの一覧(試験)。教科グループ(選択科目)は、同じ学年の複数クラスの生徒が同じ場所に
  // 集まって受ける(クラスごとに別々の部屋になるわけではない)ため、クラスごとではなく学年+グループ+教科ごとに
  // 1つずつ「監督が必要なコマ」をまとめる(通常の実教科は今まで通りクラスごとに1コマ)。
  // グループ内の試験を実施しない教科(未チェック)も、まとめて1つにはせず教科ごとに別々の自習枠にする
  // (自習の場所は教科によって異なることがあるため)。同じ場所を選べば、通常の監督割り当てと同様に
  // 同じ教員を複数の自習枠(または試験の監督)に兼任させられる。
  function listMonitorSlots(state) {
    var lookup = groupLookup(state);
    var slots = [];
    var seenGroupSlot = {}; // dayId|period|grade|groupName -> true (クラスをまたいで重複させない)
    listExamSlots(state).forEach(function (s) {
      var grade = gradeOf(s.cls);
      var g = lookup[groupKey(grade, s.subject)];
      // 「各クラスで実施」のグループ(例: 美術Ⅱ・音楽Ⅱを同じ時限に各教室で)は、通常の教科と同じくクラスごとに1コマ。
      if (!g || g.inClass) { slots.push(s); return; }
      var seenKey = s.dayId + '|' + s.period + '|' + grade + '|' + s.subject;
      if (seenGroupSlot[seenKey]) return;
      seenGroupSlot[seenKey] = true;
      var gradeClasses = (state.classes || []).filter(function (c) { return gradeOf(c) === grade; });
      var pseudoCls = groupSlotCls(grade, s.subject);
      // 試験教科決定は学年の全クラスで同じになる前提なので、このグループが置かれているクラスの決定内容を代表値として使う。
      var confirmed = (state.examSubjects && state.examSubjects[s.cls]) || [];
      // 試験教科決定が1つも行われていない(未設定)クラスは、まだ何も決めていないだけなので全教科を試験ありとして扱う。
      // 決定済みの場合だけ、チェックが外れている教科を自習扱いにする。
      var decided = confirmed.length > 0;
      g.subjects.forEach(function (subj) {
        var tested = !decided || confirmed.indexOf(subj) !== -1;
        if (tested) {
          slots.push({
            dayId: s.dayId, date: s.date, period: s.period, cls: pseudoCls, grade: grade, groupName: s.subject, subject: s.subject,
            member: { subject: subj, classes: gradeClasses }, groupMember: true,
            key: monitorKey(s.dayId, s.period, pseudoCls, subj)
          });
        } else {
          slots.push({
            dayId: s.dayId, date: s.date, period: s.period, cls: pseudoCls, grade: grade, groupName: s.subject, subject: s.subject,
            member: { subject: subj, classes: gradeClasses }, groupSelfStudy: true,
            key: monitorKey(s.dayId, s.period, pseudoCls, groupSelfStudyMemberKey(subj))
          });
        }
      });
    });
    return slots;
  }

  function candidatePoolForSlot(state, slot, setterIds) {
    var setterSet = {};
    (Array.isArray(setterIds) ? setterIds : [setterIds]).forEach(function (id) { if (id) setterSet[id] = true; });
    return (state.teachers || []).filter(function (t) {
      if (t.noCover) return false;
      // 「予備のみ」の教員は、予備(バックアップ)監督の枠にだけ割り当てる(試験監督・自習の見守りには入れない)。
      if (t.reserveOnly && !slot.reserve) return false;
      if (setterSet[t.id]) return false;
      if (isAbsent(state, t.id, slot.date, slot.period)) return false;
      // テスト中は通常の時間割は行われないため、授業(他クラスの授業との重複)では除外しない。
      return true;
    }).map(function (t) { return t.id; });
  }

  function variance(nums) {
    if (!nums.length) return 0;
    var mean = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    return nums.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / nums.length;
  }

  function assignAll(state, opts) {
    opts = opts || {};
    var iterations = opts.iterations || 150;
    var deptMap = subjectDeptMap(state.teachers, state.lessons);
    var allSlots = listMonitorSlots(state).concat(listReserveSlots(state)).concat(listSelfStudySlots(state));
    var byId = {};
    (state.teachers || []).forEach(function (t) { byId[t.id] = t; });

    // (日,時限)ごとに、その時間帯に試験が行われている全教科の出題者をまとめて計算しておく
    // (学年・クラスを問わず、その時間帯の監督・自習の見守り・予備すべてから除外する)。
    var settersByDP = {};
    listExamSlots(state).forEach(function (slot) {
      var dp = slot.dayId + '|' + slot.period;
      settersByDP[dp] = settersByDP[dp] || [];
      resolveSetters(state, slot.cls, slot.subject).forEach(function (id) {
        if (id && settersByDP[dp].indexOf(id) === -1) settersByDP[dp].push(id);
      });
    });

    var lockedAssign = {}; // key -> teacherId
    allSlots.forEach(function (s) {
      var cur = state.assignments && state.assignments[s.key];
      if (cur && cur.locked && cur.teacherId) lockedAssign[s.key] = cur.teacherId;
    });

    var unlockedSlots = allSlots.filter(function (s) { return !lockedAssign[s.key]; });

    var eligibleTeacherIds = (state.teachers || []).filter(function (t) { return !t.noCover; }).map(function (t) { return t.id; });

    var slotByKey = {};
    allSlots.forEach(function (s) { slotByKey[s.key] = s; });
    // 同じ(日,時限)で既に使われている教員でも、同じコマ(教科グループの兄弟教科)かつ同じ場所なら
    // 同じ教員を再度割り当ててよい(同じ教室なら1人で見られるため)。cellKeyが同じかどうかで「同じコマ」を判定する。
    function cellKeyOf(slot) { return slotKey(slot.dayId, slot.period, slot.cls); }
    function locationOf(slot) { return (state.examLocations && state.examLocations[slot.key]) || null; }
    function conflicts(usedEntries, cellKey, location) {
      return usedEntries.some(function (u) {
        return !(u.cellKey === cellKey && location && u.location === location);
      });
    }

    var best = null;
    for (var iter = 0; iter < iterations; iter++) {
      // counts=予備以外の監督回数(公平さの主な基準。「教員ごとの監督回数」の表示・バランス計算もこちらを使う)。
      // reserveCounts=予備監督の回数(予備は別枠として、予備同士でだけ偏りを均す)。
      var counts = {}, reserveCounts = {}, subjCount = {}, deptMatch = {};
      eligibleTeacherIds.forEach(function (id) { counts[id] = 0; reserveCounts[id] = 0; subjCount[id] = {}; deptMatch[id] = 0; });
      var usedAt = {}; // dayId|period -> teacherId -> [{cellKey,location},...]

      Object.keys(lockedAssign).forEach(function (key) {
        var tid = lockedAssign[key];
        if (counts[tid] === undefined) { counts[tid] = 0; reserveCounts[tid] = 0; subjCount[tid] = {}; deptMatch[tid] = 0; }
        var lockedSlot = slotByKey[key];
        if (lockedSlot && lockedSlot.reserve) reserveCounts[tid]++; else counts[tid]++;
        var parts = key.split('|');
        var dp = parts[0] + '|' + parts[1];
        var s = slotByKey[key];
        usedAt[dp] = usedAt[dp] || {};
        usedAt[dp][tid] = usedAt[dp][tid] || [];
        usedAt[dp][tid].push(s ? { cellKey: cellKeyOf(s), location: locationOf(s) } : { cellKey: key, location: null });
      });

      var order = unlockedSlots.slice();
      // 同一(日,時限)内のクラス順だけシャッフルして多様な割り当てを試す
      var grouped = {};
      order.forEach(function (s) {
        var dp = s.dayId + '|' + s.period;
        grouped[dp] = grouped[dp] || [];
        grouped[dp].push(s);
      });
      var dpKeys = Object.keys(grouped);
      var finalOrder = [];
      dpKeys.sort(function (a, b) {
        var da = a.split('|'), db = b.split('|');
        if (da[0] !== db[0]) return da[0] < db[0] ? -1 : 1;
        return Number(da[1]) - Number(db[1]);
      });
      dpKeys.forEach(function (dp) {
        var arr = grouped[dp].slice();
        for (var i = arr.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        finalOrder = finalOrder.concat(arr);
      });

      var warnings = [];
      var resultAssign = {};
      Object.keys(lockedAssign).forEach(function (k) { resultAssign[k] = { teacherId: lockedAssign[k], locked: true }; });

      finalOrder.forEach(function (slot) {
        var subjKey = slot.reserve ? '__reserve' : (slot.selfStudy || slot.groupSelfStudy) ? '__selfstudy' : (slot.member ? slot.member.subject : slot.subject);
        var dp = slot.dayId + '|' + slot.period;
        var setters = settersByDP[dp] || [];
        var used = usedAt[dp] || {};
        var myCellKey = cellKeyOf(slot), myLocation = locationOf(slot);
        // 教科グループ内の別の教科(または自習)が既に同じ場所で同じ教員になっていれば、
        // 同じ時間・同じ場所を見ているだけの「同じ1回」なので、回数のバランスやmaxCountの上限では
        // 新たな1回として数えない(回数のバランスより優先して同じ教員を選ぶのにも使う)。
        function alreadySameCellLocation(id) {
          return !!(myLocation && used[id] && used[id].some(function (u) { return u.cellKey === myCellKey && u.location === myLocation; }));
        }
        var pool = candidatePoolForSlot(state, slot, setters).filter(function (id) {
          if (used[id] && conflicts(used[id], myCellKey, myLocation)) return false;
          // 予備以外の回数にのみ上限をかける(予備は別枠のため上限の対象外)。同じ場所の兼任(同じ1回)は対象外。
          if (!slot.reserve && !alreadySameCellLocation(id)) {
            var maxC = byId[id] && byId[id].maxCount;
            if (maxC != null && (counts[id] || 0) >= maxC) return false;
          }
          return true;
        });
        if (!pool.length) {
          warnings.push({ dayId: slot.dayId, date: slot.date, period: slot.period, cls: slot.cls, subject: slot.member ? slot.member.subject : slot.subject, reason: '割当可能な教員がいません' });
          return;
        }
        var subjDept = (slot.reserve || slot.selfStudy || slot.groupSelfStudy) ? null : deptMap[slot.member ? slot.member.subject : effectiveSubjects(state, slot.cls, slot.subject)[0].subject];
        // 予備枠は予備同士の回数(reserveCounts)で、それ以外は予備を除いた回数(counts)で均等になるよう優先度を決める。
        var primaryCounts = slot.reserve ? reserveCounts : counts;
        pool.sort(function (a, b) {
          var sa = (alreadySameCellLocation(a) ? -1e7 : 0)
            + (primaryCounts[a] || 0) * 100
            + ((subjDept && byId[a] && byId[a].dept === subjDept) ? (deptMatch[a] || 0) * 10 : 0)
            + ((subjCount[a] && subjCount[a][subjKey]) || 0) * 3
            + Math.random();
          var sb = (alreadySameCellLocation(b) ? -1e7 : 0)
            + (primaryCounts[b] || 0) * 100
            + ((subjDept && byId[b] && byId[b].dept === subjDept) ? (deptMatch[b] || 0) * 10 : 0)
            + ((subjCount[b] && subjCount[b][subjKey]) || 0) * 3
            + Math.random();
          return sa - sb;
        });
        var pick = pool[0];
        // 同じ場所での兼任(同じ1回)でなければ、新たな1回として回数に数える。
        if (!alreadySameCellLocation(pick)) {
          if (slot.reserve) reserveCounts[pick] = (reserveCounts[pick] || 0) + 1; else counts[pick] = (counts[pick] || 0) + 1;
        }
        subjCount[pick] = subjCount[pick] || {};
        subjCount[pick][subjKey] = (subjCount[pick][subjKey] || 0) + 1;
        if (subjDept && byId[pick] && byId[pick].dept === subjDept) deptMatch[pick] = (deptMatch[pick] || 0) + 1;
        usedAt[dp] = usedAt[dp] || {};
        usedAt[dp][pick] = usedAt[dp][pick] || [];
        usedAt[dp][pick].push({ cellKey: myCellKey, location: myLocation });
        resultAssign[slot.key] = { teacherId: pick, locked: false };
      });

      // ベストな試行を選ぶ基準も、予備以外の回数(counts)の分散で評価する(予備を含めると不公平に見えてしまうため)。
      var countArr = eligibleTeacherIds.map(function (id) { return counts[id] || 0; });
      var score = variance(countArr) + warnings.length * 1e6;
      if (!best || score < best.score) {
        best = { score: score, assignments: resultAssign, warnings: warnings, counts: counts, reserveCounts: reserveCounts };
      }
    }

    return best || { score: 0, assignments: {}, warnings: [], counts: {}, reserveCounts: {} };
  }

  // そのクラスで「1コマ分」として扱う教科(=試験時間割に並ぶ単位)の一覧。
  // 教科グループに含まれる教科はグループ名1つにまとめ、含まれない教科はそのまま1つずつ。
  function schedulableItemsForClass(state, cls) {
    var grade = gradeOf(cls);
    var confirmed = state.examSubjects[cls] || [];
    var groupsForGrade = (state.subjectGroups || []).filter(function (g) { return g.grade === grade; });
    var consumed = {};
    var items = [];
    groupsForGrade.forEach(function (g) {
      // グループ内の教科が1つでも試験実施チェック済みなら、1コマにまとめる(未チェックの教科はそのコマの中で自習扱い)。
      var hasAny = g.subjects.length > 0 && g.subjects.some(function (s) { return confirmed.indexOf(s) !== -1; });
      if (!hasAny) return;
      items.push(g.name);
      g.subjects.forEach(function (s) { consumed[s] = true; });
    });
    confirmed.forEach(function (s) {
      if (!consumed[s] && items.indexOf(s) === -1) items.push(s);
    });
    return items;
  }

  // buildSchedule の配置方針(state.scheduleRulesで個別にON/OFF可能。未指定ならすべてON)。
  function scheduleRule(state, key) {
    var rules = state.scheduleRules || {};
    return rules[key] !== false;
  }

  // 自習(空きコマ)を最終日以外に寄せるためのテスト日程の処理順。
  // 最終日を先に(教科で)埋め、残りの日は最終日に近い方から埋めていくことで、
  // 教科が足りなくなる(=自習になる)のは初日側から順になるようにする。2日以上あるときだけ意味を持つ。
  function edgeDaysFirstOrder(testDays) {
    var days = (testDays || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    if (days.length <= 1) return days;
    var last = days[days.length - 1];
    var rest = days.slice(0, days.length - 1);
    return [last].concat(rest.slice().reverse());
  }

  // 試験教科決定(examSubjects・教科グループ)と日程・時限から、試験時間割(exams)を自動で埋める。
  // 既に科目が入っているコマ・その科目が既にどこかに置かれている学年はそのまま残し、未配置の分だけ埋める。
  // 同じ学年の全クラスは、同じ教科(またはグループ)を同じ(日,時限)で受けるものとして配置する。
  // state.scheduleRules(すべて省略時はON)で以下を個別にON/OFFできる:
  //   period1RequiredOnly: 1校時に教科グループ(選択科目)を入れず、必須の実教科だけを割り当てる
  //   diversifyPeriod1Dept: 一つの教科(国数英理社など)の試験が、学年をまたいですべて1校時に集中しないようにする
  //   avoidSelfStudyAfterPeriod2: 自習(空きコマ)をできるだけ1,2校時だけにする(3校時以降を先に埋める)
  //   electivesPreferMidPeriods: 教科グループ(選択科目)を、必須教科より先に2・3校時の枠に割り当てる(1日ずつ両方使い切ってから次の日へ)
  //   avoidCrossGradeSamePeriod: 学年が違っても同じ教科名なら、日にちが違っていても同じ校時にしない(可能な範囲で)
  //   avoidSelfStudyEdgeDays: 自習(空きコマ)をできるだけ最終日以外に寄せる
  //   electivesOnePerDay: 教科グループ(選択科目)は1日に1つまでにする(同じ日の2校時・3校時に別々の選択科目を置かない)。
  //                       自習(空きコマ)も1日に1つまでにする(可能な範囲で、自習が2つ以上の日から別の日へ散らす)
  //   avoidSameDeptSameDay: 同じ日に同じ教科グループ(国語・数学・英語・理科・社会など)を重ねない(可能な範囲で)
  function buildSchedule(state) {
    var warnings = [];
    var deptMap = subjectDeptMap(state.teachers, state.lessons);
    var rulePeriod1RequiredOnly = scheduleRule(state, 'period1RequiredOnly');
    var ruleDiversifyPeriod1 = scheduleRule(state, 'diversifyPeriod1Dept');
    var ruleAvoidSelfStudyAfterPeriod2 = scheduleRule(state, 'avoidSelfStudyAfterPeriod2');
    var ruleElectivesPreferMid = scheduleRule(state, 'electivesPreferMidPeriods');
    var ruleAvoidCrossGradeSamePeriod = scheduleRule(state, 'avoidCrossGradeSamePeriod');
    var ruleAvoidSelfStudyEdgeDays = scheduleRule(state, 'avoidSelfStudyEdgeDays');
    var ruleElectivesOnePerDay = scheduleRule(state, 'electivesOnePerDay');
    var ruleAvoidSameDeptSameDay = scheduleRule(state, 'avoidSameDeptSameDay');
    var chronoDays = (state.testDays || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    var gradeClasses = {};
    (state.classes || []).forEach(function (cls) {
      var g = gradeOf(cls);
      gradeClasses[g] = gradeClasses[g] || [];
      gradeClasses[g].push(cls);
    });

    // 教科名ごとに、既にどの校時で使われているか(学年・日をまたいで)を集計する。既存の(手入力・前回分の)配置も含める。
    var usedPeriodsBySubject = {};
    function markSubjectPeriod(subject, period) {
      usedPeriodsBySubject[subject] = usedPeriodsBySubject[subject] || {};
      usedPeriodsBySubject[subject][period] = true;
    }
    function subjectPeriodConflicts(subject, period) {
      return !!(usedPeriodsBySubject[subject] && usedPeriodsBySubject[subject][period]);
    }
    // 1校時に既にどの教科(国数英理社など)が使われたかを、学年をまたいで集計する。
    // diversifyPeriod1DeptがONのとき、一つの教科の試験が学年をまたいですべて1校時に
    // 集中しないよう、既に他の学年の1校時で使われた教科はできるだけ避けて選ぶ。
    var period1DeptUsed = {};
    function markPeriod1Dept(subject) {
      var dept = deptMap[subject];
      if (dept) period1DeptUsed[dept] = true;
    }
    (state.testDays || []).forEach(function (day) {
      periodsForDay(state, day.id).forEach(function (period) {
        (state.classes || []).forEach(function (cls) {
          var e = state.exams[slotKey(day.id, period, cls)];
          if (e && e.subject) {
            markSubjectPeriod(e.subject, period);
            if (period === 1) markPeriod1Dept(e.subject);
          }
        });
      });
    });

    Object.keys(gradeClasses).sort().forEach(function (grade) {
      var classes = gradeClasses[grade];

      var groupNames = {};
      (state.subjectGroups || []).forEach(function (g) { if (g.grade === grade) groupNames[g.name] = true; });

      var labelClasses = {}; // label -> [cls,...]
      var orderedLabels = [];
      classes.forEach(function (cls) {
        schedulableItemsForClass(state, cls).forEach(function (label) {
          if (!labelClasses[label]) { labelClasses[label] = []; orderedLabels.push(label); }
          labelClasses[label].push(cls);
        });
      });

      // その日(学年単位)に既にどの教科グループ(国語・数学・英語・理科・社会など)が使われているかを集計する
      // (avoidSameDeptSameDayで、同じ日に同じ教科グループが重ならないようにするために使う)。
      var usedDeptByDay = {};
      function markDeptDay(dayId, subject) {
        var dept = deptMap[subject];
        if (!dept) return;
        usedDeptByDay[dayId] = usedDeptByDay[dayId] || {};
        usedDeptByDay[dayId][dept] = true;
      }

      var placedLabels = {};
      var occupiedSlots = {};
      (state.testDays || []).forEach(function (day) {
        periodsForDay(state, day.id).forEach(function (period) {
          var dp = day.id + '|' + period;
          classes.forEach(function (cls) {
            var e = state.exams[slotKey(day.id, period, cls)];
            if (e && e.subject) { occupiedSlots[dp] = true; placedLabels[e.subject] = true; markDeptDay(day.id, e.subject); }
          });
        });
      });

      var pending = orderedLabels.filter(function (l) { return !placedLabels[l]; });
      var pendingRequired = pending.filter(function (l) { return !groupNames[l]; });

      var placedThisRun = {}; // dayId|period -> label (今回の自動配置で置いたもの。自習の偏り直しで動かしてよいのはこれだけ)
      function place(label, slot) {
        labelClasses[label].forEach(function (cls) {
          state.exams[slotKey(slot.dayId, slot.period, cls)] = { subject: label };
        });
        placedThisRun[slot.dayId + '|' + slot.period] = label;
      }
      function unplace(label, dayId, period) {
        labelClasses[label].forEach(function (cls) { delete state.exams[slotKey(dayId, period, cls)]; });
        delete placedThisRun[dayId + '|' + period];
      }

      // 1校時(空いている日だけ)の割り当て。period1RequiredOnlyがONなら教科グループを除いた必須教科だけから選ぶ。
      var placed = {};
      if ((state.periods || []).indexOf(1) !== -1) {
        var period1Pool = rulePeriod1RequiredOnly ? pendingRequired : pending;
        // 教科数が1校時の空きコマ数より少ない(=1校時のどこかが自習になる)場合だけ、初日・最終日を
        // 先に埋める処理順にする(教科が足りているなら並び順を変える必要が無く、1校時の教科分散にも影響させない)。
        var period1Capacity = chronoDays.filter(function (day) {
          return periodsForDay(state, day.id).indexOf(1) !== -1 && !occupiedSlots[day.id + '|1'];
        }).length;
        var period1Order = (ruleAvoidSelfStudyEdgeDays && period1Pool.length < period1Capacity) ? edgeDaysFirstOrder(chronoDays) : chronoDays;
        period1Order.forEach(function (day) {
          if (periodsForDay(state, day.id).indexOf(1) === -1) return;
          var dp = day.id + '|1';
          if (occupiedSlots[dp]) return;
          var remaining = period1Pool.filter(function (l) { return !placed[l]; });
          if (!remaining.length) return;
          var candidates = remaining;
          if (ruleAvoidCrossGradeSamePeriod) {
            // 他の学年が同じ教科名を既に1校時で使っていれば避ける。候補全部が衝突する場合は、
            // この日の1校時はあえて空けておき(自習)、残りの教科は後で1校時以外の枠に回す。
            var remainingPreferred = remaining.filter(function (l) { return !subjectPeriodConflicts(l, 1); });
            if (!remainingPreferred.length) return;
            candidates = remainingPreferred;
          }
          if (ruleAvoidSameDeptSameDay && usedDeptByDay[day.id]) {
            // 同じ日の他の時限で既に使われている教科グループ(国数英理社など)を避ける(可能な範囲で)。
            var deptSafe = candidates.filter(function (l) { var d = deptMap[l]; return !(d && usedDeptByDay[day.id][d]); });
            if (deptSafe.length) candidates = deptSafe;
          }
          if (ruleDiversifyPeriod1) {
            // 他の学年の1校時で既に使われた教科(国数英理社など)を避ける(可能な範囲で)。これにより、
            // 一つの教科の試験が学年をまたいですべて1校時に集中してしまうのを防ぐ。
            var crossGradeDeptSafe = candidates.filter(function (l) { var d = deptMap[l]; return !(d && period1DeptUsed[d]); });
            if (crossGradeDeptSafe.length) candidates = crossGradeDeptSafe;
          }
          var pick = candidates[0];
          placed[pick] = true;
          markSubjectPeriod(pick, 1);
          markPeriod1Dept(pick);
          markDeptDay(day.id, pick);
          place(pick, { dayId: day.id, period: 1 });
        });
      }

      // 残りの配置方針:
      // ・avoidSelfStudyAfterPeriod2がON: 自習(空きコマ)はできるだけ1,2校時だけにする -> 3校時以降を先に埋め、2校時は最後に埋める
      // ・electivesPreferMidPeriodsがON: 教科グループ(選択科目)を2・3校時の枠に、必須教科より先に割り当てる。
      //   必須教科(avoidSelfStudyAfterPeriod2)と同じ枠の奪い合いにならないよう、まず1日ずつ2校時・3校時の両方を
      //   選択科目で使い切ってから次の日に進む(こうしないと必須教科が先に3校時を使い切ってしまい、2校時が
      //   全日程ぶん丸ごと自習のまま残ってしまうことがある)。ただしelectivesOnePerDayがONの場合は、
      //   1日に選択科目を1つ置いたらその日の残りの2・3校時枠は選択科目の対象から外す(必須教科や自習に回す)。
      var electives = pending.filter(function (l) { return groupNames[l] && !placed[l]; });

      if (ruleElectivesPreferMid && electives.length) {
        var midPeriods = [3, 2].filter(function (p) { return (state.periods || []).indexOf(p) !== -1; });
        var midSlots = [];
        chronoDays.forEach(function (day) {
          var dayPeriods = periodsForDay(state, day.id);
          midPeriods.forEach(function (period) {
            if (dayPeriods.indexOf(period) === -1) return;
            var dp = day.id + '|' + period;
            if (!occupiedSlots[dp]) midSlots.push({ dayId: day.id, period: period, dp: dp });
          });
        });
        var dayUsedForElective = {};
        while (electives.length && midSlots.length) {
          if (ruleElectivesOnePerDay) {
            // 既に選択科目を置いた日の残り枠は、選択科目の対象から外す(必須教科や自習の枠として使われる)。
            midSlots = midSlots.filter(function (s) { return !dayUsedForElective[s.dayId]; });
            if (!midSlots.length) break;
          }
          var midLabel = electives.shift();
          var midIdx = 0;
          if (ruleAvoidCrossGradeSamePeriod) {
            for (var mi2 = 0; mi2 < midSlots.length; mi2++) {
              if (!subjectPeriodConflicts(midLabel, midSlots[mi2].period)) { midIdx = mi2; break; }
            }
          }
          var midSlot = midSlots.splice(midIdx, 1)[0];
          place(midLabel, midSlot);
          placed[midLabel] = true;
          occupiedSlots[midSlot.dp] = true;
          markSubjectPeriod(midLabel, midSlot.period);
          markDeptDay(midSlot.dayId, midLabel);
          if (ruleElectivesOnePerDay) dayUsedForElective[midSlot.dayId] = true;
        }
      }

      var leftoverRequired = pending.filter(function (l) { return !groupNames[l] && !placed[l]; });
      var leftover = ruleElectivesPreferMid ? electives.concat(leftoverRequired) : pending.filter(function (l) { return !placed[l]; });

      var nonFirstPeriods = (state.periods || []).filter(function (p) { return p !== 1; });
      if (ruleAvoidSelfStudyAfterPeriod2) {
        // 3校時以降を時限の大きい方から先に埋め、2校時は最後(自習が出るなら2校時に出やすくする)
        var laterPeriods = nonFirstPeriods.filter(function (p) { return p !== 2; });
        laterPeriods.sort(function (a, b) { return b - a; });
        if (nonFirstPeriods.indexOf(2) !== -1) laterPeriods.push(2);
        nonFirstPeriods = laterPeriods;
      } else {
        nonFirstPeriods.sort(function (a, b) { return a - b; });
      }
      var freeCapacity = 0;
      nonFirstPeriods.forEach(function (period) {
        chronoDays.forEach(function (day) {
          if (periodsForDay(state, day.id).indexOf(period) !== -1 && !occupiedSlots[day.id + '|' + period]) freeCapacity++;
        });
      });
      // 教科数が空きコマ数より少ない(=どこかが自習になる)場合だけ、初日・最終日を先に埋める処理順にする。
      var freeSlotDays = (ruleAvoidSelfStudyEdgeDays && leftover.length < freeCapacity) ? edgeDaysFirstOrder(chronoDays) : chronoDays;
      var freeSlots = [];
      nonFirstPeriods.forEach(function (period) {
        freeSlotDays.forEach(function (day) {
          if (periodsForDay(state, day.id).indexOf(period) === -1) return;
          var dp = day.id + '|' + period;
          if (!occupiedSlots[dp]) freeSlots.push({ dayId: day.id, period: period });
        });
      });

      var remainingFreeSlots = freeSlots.slice();
      var placedCount = 0;
      for (var li = 0; li < leftover.length && remainingFreeSlots.length; li++) {
        var leftoverLabel = leftover[li];
        var leftoverDept = deptMap[leftoverLabel];
        // 学年をまたいだ校時重複(avoidCrossGradeSamePeriod)と、同じ日の教科グループ重複
        // (avoidSameDeptSameDay)の両方をできるだけ避けられる枠を優先する(衝突が少ないものを選ぶ)。
        var slotIdx = 0, bestScore = Infinity;
        for (var fi = 0; fi < remainingFreeSlots.length; fi++) {
          var cand = remainingFreeSlots[fi];
          var score = 0;
          if (ruleAvoidCrossGradeSamePeriod && subjectPeriodConflicts(leftoverLabel, cand.period)) score += 2;
          if (ruleAvoidSameDeptSameDay && leftoverDept && usedDeptByDay[cand.dayId] && usedDeptByDay[cand.dayId][leftoverDept]) score += 1;
          if (score < bestScore) { bestScore = score; slotIdx = fi; if (score === 0) break; }
        }
        var chosenSlot = remainingFreeSlots.splice(slotIdx, 1)[0];
        place(leftoverLabel, chosenSlot);
        markSubjectPeriod(leftoverLabel, chosenSlot.period);
        markDeptDay(chosenSlot.dayId, leftoverLabel);
        placedCount++;
      }
      if (leftover.length > placedCount) {
        warnings.push({ grade: grade, reason: '教科数が空きコマ数より多いため一部配置できませんでした', unplaced: leftover.slice(placedCount) });
      }

      // electivesOnePerDay: 自習(空きコマ)も1日1つまでにする。自習が2つ以上ある日があれば、自習が無い日に
      // 今回置いた教科を、その日の空きコマ(できるだけ同じ校時)へ移して、自習を別の日に散らす(可能な範囲で)。
      if (ruleElectivesOnePerDay) {
        var lastDayId = chronoDays.length ? chronoDays[chronoDays.length - 1].id : null;
        var dpHasExam = function (dayId, period) {
          return classes.some(function (cls) { var e = state.exams[slotKey(dayId, period, cls)]; return !!(e && e.subject); });
        };
        var emptiesOf = function (dayId) {
          return periodsForDay(state, dayId).filter(function (p) { return !dpHasExam(dayId, p); });
        };
        var dayHasElective = function (dayId) {
          return periodsForDay(state, dayId).some(function (p) {
            return classes.some(function (cls) { var e = state.exams[slotKey(dayId, p, cls)]; return !!(e && groupNames[e.subject]); });
          });
        };
        for (var guard = 0; guard < 50; guard++) {
          var crowded = null;
          for (var ci = 0; ci < chronoDays.length; ci++) {
            if (emptiesOf(chronoDays[ci].id).length >= 2) { crowded = chronoDays[ci]; break; }
          }
          if (!crowded) break;
          var targetPeriods = emptiesOf(crowded.id);
          var bestMove = null, bestMoveScore = Infinity;
          Object.keys(placedThisRun).forEach(function (dp) {
            var parts = dp.split('|');
            var fromDay = parts[0], fromPeriod = Number(parts[1]);
            if (fromDay === crowded.id) return;
            if (emptiesOf(fromDay).length > 0) return; // 移すと元の日に自習ができる日だけを相手にする
            var label = placedThisRun[dp];
            var isElective = !!groupNames[label];
            if (isElective && dayHasElective(crowded.id)) return;
            targetPeriods.forEach(function (tp) {
              if (tp === 1 && isElective && rulePeriod1RequiredOnly) return;
              var sc = (tp === fromPeriod) ? 0 : 3;
              if (ruleAvoidSelfStudyEdgeDays && fromDay === lastDayId) sc += 10;
              if (ruleAvoidSelfStudyAfterPeriod2 && fromPeriod > 2) sc += 2;
              var d = deptMap[label];
              if (ruleAvoidSameDeptSameDay && d && usedDeptByDay[crowded.id] && usedDeptByDay[crowded.id][d]) sc += 1;
              if (ruleAvoidCrossGradeSamePeriod && tp !== fromPeriod && subjectPeriodConflicts(label, tp)) sc += 2;
              if (sc < bestMoveScore) { bestMoveScore = sc; bestMove = { label: label, fromDay: fromDay, fromPeriod: fromPeriod, toPeriod: tp }; }
            });
          });
          if (!bestMove) break;
          unplace(bestMove.label, bestMove.fromDay, bestMove.fromPeriod);
          place(bestMove.label, { dayId: crowded.id, period: bestMove.toPeriod });
          markSubjectPeriod(bestMove.label, bestMove.toPeriod);
          markDeptDay(crowded.id, bestMove.label);
        }
      }
    });

    return { warnings: warnings };
  }

  // 学年内の(日,時限)の教科をまるごと入れ替える(その学年の全クラス分)。試験時間割の「最小限の変更」の単位。
  function swapGradeSlot(state, gradeClasses, dayIdA, periodA, dayIdB, periodB) {
    gradeClasses.forEach(function (cls) {
      var keyA = slotKey(dayIdA, periodA, cls);
      var keyB = slotKey(dayIdB, periodB, cls);
      var a = state.exams[keyA];
      var b = state.exams[keyB];
      if (b) state.exams[keyA] = b; else delete state.exams[keyA];
      if (a) state.exams[keyB] = a; else delete state.exams[keyB];
    });
  }

  // 指定した(日,時限,学年)に紐づく監督割り当て・場所を消す(教科を入れ替えた後、古い教科のための割り当てが
  // 残らないようにする)。教科グループのキーは仮想クラス名(__group:grade:name)を使うため、学年の判定はそちらも見る。
  function clearAssignmentsAt(state, dayId, period, grade) {
    ['assignments', 'examLocations'].forEach(function (field) {
      var obj = state[field];
      if (!obj) return;
      Object.keys(obj).forEach(function (key) {
        var parts = key.split('|');
        if (parts[0] !== dayId || Number(parts[1]) !== period) return;
        var cls = parts[2];
        var g = isGroupSlotCls(cls) ? parseGroupSlotCls(cls).grade : gradeOf(cls);
        if (g === grade) delete obj[key];
      });
    });
  }

  // 監督が0人になってしまったコマ(warning)について、同じ学年の他の(日,時限)とまるごと教科を入れ替えることで
  // 解決できないか試す。入れ替え候補は、何も試験が入っていない(自習)コマを優先し、無ければ埋まっているコマも試す。
  // 入れ替えてtrialIterations回だけ試算し、警告の総数がbaselineより減れば採用、改善しなければ元に戻して次の候補を試す。
  function tryRepairSlot(state, warning, baseline, trialIterations) {
    var grade = isGroupSlotCls(warning.cls) ? parseGroupSlotCls(warning.cls).grade : gradeOf(warning.cls);
    var gradeClasses = (state.classes || []).filter(function (c) { return gradeOf(c) === grade; });
    if (!gradeClasses.length) return null;

    var candidates = [];
    (state.testDays || []).forEach(function (day) {
      periodsForDay(state, day.id).forEach(function (period) {
        if (day.id === warning.dayId && period === warning.period) return;
        var anyExam = gradeClasses.some(function (c) { return hasExam(state, day.id, period, c); });
        candidates.push({ dayId: day.id, period: period, empty: !anyExam });
      });
    });
    candidates.sort(function (a, b) { return (a.empty === b.empty) ? 0 : (a.empty ? -1 : 1); });

    // 教科を固定(exams[key].locked)したコマは入れ替えに使わない(固定したコマの教科は動かさない)。
    function subjectLockedAt(dayId, period) {
      return gradeClasses.some(function (c) { var e = state.exams[slotKey(dayId, period, c)]; return !!(e && e.locked); });
    }
    if (subjectLockedAt(warning.dayId, warning.period)) return null;
    candidates = candidates.filter(function (c) { return !subjectLockedAt(c.dayId, c.period); });

    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      var examsBackup = Object.assign({}, state.exams);
      var assignBackup = Object.assign({}, state.assignments);
      var locBackup = Object.assign({}, state.examLocations);

      swapGradeSlot(state, gradeClasses, warning.dayId, warning.period, cand.dayId, cand.period);
      clearAssignmentsAt(state, warning.dayId, warning.period, grade);
      clearAssignmentsAt(state, cand.dayId, cand.period, grade);

      var trialWarnings = assignAll(state, { iterations: trialIterations }).warnings.length;
      if (trialWarnings < baseline) {
        return { grade: grade, from: { dayId: warning.dayId, period: warning.period }, to: { dayId: cand.dayId, period: cand.period } };
      }
      state.exams = examsBackup;
      state.assignments = assignBackup;
      state.examLocations = locBackup;
    }
    return null;
  }

  // 教科グループ(選択科目)の監督割り当て(場所ごと)で指定した場所を、日時が変わっても(例えば
  // 「時間割をクリアして組み直す」で日時が入れ替わっても)引き継げるように、学年・グループ名・教科
  // (または自習教科)を基準にキー化する。日時は変わりうるため含めない。
  function groupLocationLookupKey(grade, groupName, memberKey) { return grade + '|' + groupName + '|' + memberKey; }

  // 現在の教科グループの監督割り当て(場所ごと)の「場所」設定を、日時に依らない形で取り出す。
  // 「時間割をクリアして組み直す」の前に呼び、消去後の再配置にそのまま引き継げるようにする。
  function captureGroupLocations(state) {
    var map = {};
    listMonitorSlots(state).forEach(function (slot) {
      if (!slot.groupMember && !slot.groupSelfStudy) return;
      var loc = state.examLocations && state.examLocations[slot.key];
      if (!loc) return;
      var memberKey = slot.groupSelfStudy ? groupSelfStudyMemberKey(slot.member.subject) : slot.member.subject;
      map[groupLocationLookupKey(slot.grade, slot.groupName, memberKey)] = loc;
    });
    return map;
  }

  // captureGroupLocationsで取り出した場所設定を、現在の(新しい)試験時間割に基づく
  // 教科グループの監督コマへ割り当て直す(既に場所が設定されているコマは上書きしない)。
  function restoreGroupLocations(state, map) {
    if (!map) return;
    listMonitorSlots(state).forEach(function (slot) {
      if (!slot.groupMember && !slot.groupSelfStudy) return;
      if (state.examLocations[slot.key] != null) return;
      var memberKey = slot.groupSelfStudy ? groupSelfStudyMemberKey(slot.member.subject) : slot.member.subject;
      var loc = map[groupLocationLookupKey(slot.grade, slot.groupName, memberKey)];
      if (loc) state.examLocations[slot.key] = loc;
    });
  }

  // 試験時間割を「試験教科決定」の条件で組んでから監督を割り当てる。監督が0人になってしまうコマがあれば、
  // 同じ学年内で教科をまるごと入れ替える最小限の時間割変更を試みてから、再度監督を割り当て直す。
  // 自習・予備は教科ではないため、時間割の変更では解決できない(そのまま警告として残す)。
  // opts.restoreGroupLocationsにcaptureGroupLocationsで取り出したマップを渡すと、組み直し後の
  // 教科グループの監督コマに、同じ学年・グループ・教科の場所設定を引き継ぐ。
  function buildScheduleWithAssignment(state, opts) {
    opts = opts || {};
    var iterations = opts.iterations || 200;
    var trialIterations = opts.trialIterations || 30;
    var maxRepairAttempts = opts.maxRepairAttempts != null ? opts.maxRepairAttempts : 10;

    var scheduleResult = buildSchedule(state);
    if (opts.restoreGroupLocations) restoreGroupLocations(state, opts.restoreGroupLocations);
    var assignResult = assignAll(state, { iterations: iterations });
    var changes = [];
    var attempts = 0;
    while (assignResult.warnings.length && attempts < maxRepairAttempts) {
      var fixable = assignResult.warnings.filter(function (w) { return w.subject && !isReserveCls(w.cls); });
      if (!fixable.length) break;
      var change = tryRepairSlot(state, fixable[0], assignResult.warnings.length, trialIterations);
      attempts++;
      if (!change) break;
      changes.push(change);
      assignResult = assignAll(state, { iterations: iterations });
    }
    return { scheduleWarnings: scheduleResult.warnings, assignResult: assignResult, changes: changes };
  }

  function buildStats(state, assignResult) {
    var byId = {};
    (state.teachers || []).forEach(function (t) { byId[t.id] = t; });
    var perTeacher = {};
    (state.teachers || []).forEach(function (t) { perTeacher[t.id] = { total: 0, nonReserveTotal: 0, bySubject: {} }; });
    // 教科グループで同じ場所を選んだ複数の教科(自習含む)を1人が兼任している場合、
    // 実際には1回(同じ時間・同じ場所)の監督なので、(教員,日,時限,クラス/グループ)が
    // 同じものは2回目以降は回数に数えない(そうしないと兼任した教科の数だけ重複して数えてしまう)。
    var seenCell = {};
    Object.keys(assignResult.assignments || {}).forEach(function (key) {
      var a = assignResult.assignments[key];
      if (!a || !a.teacherId) return;
      var parts = key.split('|');
      var cls = parts[2];
      var dayId = parts[0], period = Number(parts[1]), memberSubject = parts[3];
      var isReserve = isReserveCls(cls);
      var subject;
      if (isReserve) { subject = '予備'; }
      else if (isGroupSelfStudyMemberKey(memberSubject)) { subject = '自習'; }
      else if (memberSubject) { subject = memberSubject; }
      else { var e = state.exams[slotKey(dayId, period, cls)]; subject = (e && e.subject) ? e.subject : '自習'; }
      if (!perTeacher[a.teacherId]) perTeacher[a.teacherId] = { total: 0, nonReserveTotal: 0, bySubject: {} };
      seenCell[a.teacherId] = seenCell[a.teacherId] || {};
      var cellKey = dayId + '|' + period + '|' + cls;
      var alreadyCounted = !!seenCell[a.teacherId][cellKey];
      seenCell[a.teacherId][cellKey] = true;
      if (!alreadyCounted) {
        perTeacher[a.teacherId].total++;
        if (!isReserve) perTeacher[a.teacherId].nonReserveTotal++;
        perTeacher[a.teacherId].bySubject[subject] = (perTeacher[a.teacherId].bySubject[subject] || 0) + 1;
      }
    });
    return perTeacher;
  }

  function analyzeSelfStudy(state) {
    var grades = {};
    (state.classes || []).forEach(function (cls) { grades[gradeOf(cls)] = grades[gradeOf(cls)] || []; });
    Object.keys(grades).forEach(function (g) {
      grades[g] = (state.classes || []).filter(function (c) { return gradeOf(c) === g; });
    });

    var result = {};
    Object.keys(grades).sort().forEach(function (g) {
      var clsList = grades[g];
      var counts = {}; // period -> count
      var slots = [];
      (state.periods || []).forEach(function (p) { counts[p] = 0; });
      (state.testDays || []).forEach(function (day) {
        periodsForDay(state, day.id).forEach(function (period) {
          var anyExam = clsList.some(function (c) { return hasExam(state, day.id, period, c); });
          if (!anyExam) {
            counts[period] = (counts[period] || 0) + 1;
            slots.push({ dayId: day.id, date: day.date, period: period });
          }
        });
      });
      var vals = Object.keys(counts).map(function (p) { return counts[p]; });
      var imbalance = vals.length ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : 0;
      result[g] = { counts: counts, slots: slots, imbalance: imbalance };
    });
    return result;
  }

  // 教員別一覧(監督割振の実物に近い形式): 行=教員, 列=日×時限。
  // セルには、その教員が監督するクラス(予備は「予備1」等)と、その教員がそのコマの出題者になっているクラスの両方を入れる。
  function teacherGrid(state, assignResult) {
    var columns = [];
    (state.testDays || []).forEach(function (day) {
      periodsForDay(state, day.id).forEach(function (period) {
        columns.push({ dayId: day.id, date: day.date, period: period });
      });
    });
    // 教科グループで同じ場所を選んだ複数の教科(自習含む)を1人が兼任している場合、同じ(日,時限)に
    // 複数の記録が入る。グループ名ごとにまとめ、「選択C/自習(保育基礎・生涯スポーツA・デュアル実習Ⅰ)」の
    // ように1つのラベルに短くまとめて表示する(グループ名+スラッシュを繰り返さない)。
    var rawByTeacherCell = {};
    Object.keys(assignResult.assignments || {}).forEach(function (key) {
      var a = assignResult.assignments[key];
      if (!a || !a.teacherId) return;
      var parts = key.split('|');
      var dayId = parts[0], period = Number(parts[1]), cls = parts[2], memberSubject = parts[3];
      var colKey = dayId + '|' + period;
      var groupInfo = parseGroupSlotCls(cls);
      rawByTeacherCell[a.teacherId] = rawByTeacherCell[a.teacherId] || {};
      rawByTeacherCell[a.teacherId][colKey] = rawByTeacherCell[a.teacherId][colKey] || [];
      if (isReserveCls(cls)) {
        rawByTeacherCell[a.teacherId][colKey].push({ plain: '予備' + cls.slice(reservePrefix().length) });
      } else if (groupInfo && isGroupSelfStudyMemberKey(memberSubject)) {
        rawByTeacherCell[a.teacherId][colKey].push({ baseLabel: groupInfo.groupName, selfStudy: groupSelfStudySubjectOf(memberSubject) });
      } else if (groupInfo && memberSubject) {
        rawByTeacherCell[a.teacherId][colKey].push({ baseLabel: groupInfo.groupName, tested: memberSubject });
      } else {
        rawByTeacherCell[a.teacherId][colKey].push({ plain: hasExam(state, dayId, period, cls) ? cls : cls + '(自習)' });
      }
    });
    var byTeacherCell = {};
    Object.keys(rawByTeacherCell).forEach(function (tid) {
      byTeacherCell[tid] = {};
      Object.keys(rawByTeacherCell[tid]).forEach(function (colKey) {
        var byBase = {}, order = [], plains = [];
        rawByTeacherCell[tid][colKey].forEach(function (e) {
          if (e.plain != null) { plains.push(e.plain); return; }
          if (!byBase[e.baseLabel]) { byBase[e.baseLabel] = { tested: [], selfStudy: [] }; order.push(e.baseLabel); }
          if (e.tested != null) byBase[e.baseLabel].tested.push(e.tested);
          else byBase[e.baseLabel].selfStudy.push(e.selfStudy);
        });
        var cellParts = plains.slice();
        order.forEach(function (base) {
          var inner = byBase[base].tested.slice();
          if (byBase[base].selfStudy.length) inner.push('自習(' + byBase[base].selfStudy.join('・') + ')');
          cellParts.push(base + '/' + inner.join('・'));
        });
        byTeacherCell[tid][colKey] = cellParts.join('・');
      });
    });
    var groupLookupMap = groupLookup(state);
    var bySetterCell = {}; // teacherId -> colKey -> [cls,...] (教科グループは学年単位なので「2年」のように表示する)
    listExamSlots(state).forEach(function (slot) {
      var colKey = slot.dayId + '|' + slot.period;
      var isGroup = !!groupLookupMap[groupKey(gradeOf(slot.cls), slot.subject)];
      var label = isGroup ? (gradeOf(slot.cls) + '年') : slot.cls;
      resolveSetters(state, slot.cls, slot.subject).forEach(function (tid) {
        bySetterCell[tid] = bySetterCell[tid] || {};
        bySetterCell[tid][colKey] = bySetterCell[tid][colKey] || [];
        if (bySetterCell[tid][colKey].indexOf(label) === -1) bySetterCell[tid][colKey].push(label);
      });
    });
    // 教科グループでなくても、同じ学年の全クラスの出題者が同じ教員になっていれば(結局学年単位で
    // 出題していることになるので)、クラス名を並べず「2年」のように学年でまとめて表示する。
    var classesByGrade = {};
    (state.classes || []).forEach(function (c) { var g = gradeOf(c); classesByGrade[g] = classesByGrade[g] || []; classesByGrade[g].push(c); });
    Object.keys(bySetterCell).forEach(function (tid) {
      Object.keys(bySetterCell[tid]).forEach(function (colKey) {
        var plainByGrade = {}, others = [];
        bySetterCell[tid][colKey].forEach(function (lbl) {
          if (state.classes.indexOf(lbl) !== -1) {
            var g = gradeOf(lbl);
            plainByGrade[g] = plainByGrade[g] || [];
            plainByGrade[g].push(lbl);
          } else {
            others.push(lbl);
          }
        });
        var merged = others.slice();
        Object.keys(plainByGrade).forEach(function (g) {
          var all = classesByGrade[g] || [];
          var covers = all.length > 0 && all.every(function (c) { return plainByGrade[g].indexOf(c) !== -1; });
          var gradeLabel = g + '年';
          if (covers) {
            if (merged.indexOf(gradeLabel) === -1) merged.push(gradeLabel);
          } else {
            plainByGrade[g].forEach(function (c) { if (merged.indexOf(c) === -1) merged.push(c); });
          }
        });
        bySetterCell[tid][colKey] = merged;
      });
    });
    var stats = buildStats(state, assignResult);
    var rows = (state.teachers || []).map(function (t) {
      var cells = columns.map(function (col) {
        var colKey = col.dayId + '|' + col.period;
        return {
          proctor: (byTeacherCell[t.id] && byTeacherCell[t.id][colKey]) || null,
          setterClasses: (bySetterCell[t.id] && bySetterCell[t.id][colKey]) || []
        };
      });
      return {
        teacherId: t.id, name: t.name, dept: t.dept, noCover: t.noCover, reserveOnly: t.reserveOnly, maxCount: t.maxCount, cells: cells,
        total: (stats[t.id] && stats[t.id].total) || 0,
        nonReserveTotal: (stats[t.id] && stats[t.id].nonReserveTotal) || 0
      };
    });
    return { columns: columns, rows: rows };
  }

  var Engine = {
    slotKey: slotKey,
    subjClsKey: subjClsKey,
    weekdayOf: weekdayOf,
    gradeOf: gradeOf,
    subjectCandidates: subjectCandidates,
    setterCandidates: setterCandidates,
    resolveSetter: resolveSetter,
    groupKey: groupKey,
    groupLookup: groupLookup,
    groupSlotCls: groupSlotCls,
    isGroupSlotCls: isGroupSlotCls,
    groupSelfStudyMemberKey: groupSelfStudyMemberKey,
    isGroupSelfStudyMemberKey: isGroupSelfStudyMemberKey,
    groupSelfStudySubjectOf: groupSelfStudySubjectOf,
    parseGroupSlotCls: parseGroupSlotCls,
    effectiveSubjects: effectiveSubjects,
    resolveSetters: resolveSetters,
    settersAtTime: settersAtTime,
    isAbsent: isAbsent,
    hasExam: hasExam,
    periodsForDay: periodsForDay,
    clearExamDataAt: clearExamDataAt,
    isBusyWithRegularLesson: isBusyWithRegularLesson,
    subjectDeptMap: subjectDeptMap,
    listExamSlots: listExamSlots,
    listReserveSlots: listReserveSlots,
    listSelfStudySlots: listSelfStudySlots,
    listMonitorSlots: listMonitorSlots,
    monitorKey: monitorKey,
    isReserveCls: isReserveCls,
    candidatePoolForSlot: candidatePoolForSlot,
    assignAll: assignAll,
    schedulableItemsForClass: schedulableItemsForClass,
    edgeDaysFirstOrder: edgeDaysFirstOrder,
    buildSchedule: buildSchedule,
    buildScheduleWithAssignment: buildScheduleWithAssignment,
    captureGroupLocations: captureGroupLocations,
    restoreGroupLocations: restoreGroupLocations,
    buildStats: buildStats,
    teacherGrid: teacherGrid,
    analyzeSelfStudy: analyzeSelfStudy
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
