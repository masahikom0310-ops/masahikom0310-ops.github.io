(function () {
  'use strict';
  var STORAGE_KEY = 'teiki-test-kantoku-v1';
  var WD = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' };

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function weekdayLabel(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return WD[d.getDay()];
  }
  function monthDayLabel(dateStr) {
    var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return dateStr || '';
    return Number(m[1]) + '/' + Number(m[2]);
  }

  function defaultState() {
    var base = window.IMPORTED_BASE || { teachers: [], lessons: [], subRoles: [] };
    var clsSet = {};
    base.lessons.forEach(function (l) { if (/^\d+-\d+$/.test(l.c)) clsSet[l.c] = true; });
    var classes = Object.keys(clsSet).sort();
    var gradeSet = {};
    classes.forEach(function (c) { gradeSet[Engine.gradeOf(c)] = true; });
    var locSet = {};
    base.lessons.forEach(function (l) { if (l.r) locSet[l.r] = true; });
    return {
      updatedAt: Date.now(),
      importedAt: new Date().toISOString(),
      teachers: JSON.parse(JSON.stringify(base.teachers)),
      lessons: JSON.parse(JSON.stringify(base.lessons)),
      subRoles: JSON.parse(JSON.stringify(base.subRoles || [])),
      classes: classes,
      grades: Object.keys(gradeSet).sort(),
      testDays: [],
      periods: [1, 2],
      periodTimes: {},
      dayPeriods: {},
      exams: {},
      setters: {},
      examSubjects: {},
      customSubjects: {},
      removedSubjects: {},
      subjectGroups: [],
      absences: [],
      assignments: {},
      locations: Object.keys(locSet).sort(),
      examLocations: {},
      reserveCount: 0,
      scheduleRules: {
        period1RequiredOnly: true,
        diversifyPeriod1Dept: true,
        avoidSelfStudyAfterPeriod2: true,
        electivesPreferMidPeriods: true,
        avoidCrossGradeSamePeriod: true,
        avoidSelfStudyEdgeDays: true,
        electivesOnePerDay: true,
        avoidSameDeptSameDay: true
      }
    };
  }

  var state = loadState();

  // 教科グループは元々クラス単位だったが、学年単位に変更した。旧データ(cls+members、または古いcls+subjects)が
  // 残っていれば学年単位にまとめ直す(同じ学年・同じ名前のグループは1つにマージする)。
  function normalizeSubjectGroups(st) {
    var merged = [];
    var seen = {};
    (st.subjectGroups || []).forEach(function (g) {
      var subjectsArr;
      if (g.subjects && typeof g.subjects[0] === 'string') subjectsArr = g.subjects.slice();
      else if (g.members) subjectsArr = g.members.map(function (m) { return m.subject; });
      else subjectsArr = [];
      var grade = g.grade || (g.cls ? Engine.gradeOf(g.cls) : null);
      if (!grade || !subjectsArr.length) return;
      var key = grade + '|' + g.name;
      if (seen[key]) {
        subjectsArr.forEach(function (s) { if (seen[key].subjects.indexOf(s) === -1) seen[key].subjects.push(s); });
      } else {
        var rec = { id: g.id || uid('grp'), grade: grade, name: g.name, subjects: subjectsArr };
        if (g.inClass) rec.inClass = true;
        seen[key] = rec;
        merged.push(rec);
      }
    });
    st.subjectGroups = merged;
    return st;
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeSubjectGroups(Object.assign(defaultState(), JSON.parse(raw)));
    } catch (e) { /* ignore */ }
    return defaultState();
  }
  function saveState() {
    state.updatedAt = Date.now();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    scheduleCloudPush();
  }

  // ---- クラウド同期(Claude Artifactのdb機能。Artifact外で動かしている場合はwindow.claudeが無く何もしない) ----
  var CLOUD_DOC_PATH = 'data/state';
  var CLOUD_SYNCED_ONCE_KEY = STORAGE_KEY + '-synced-once';
  var cloudDb = null;
  var cloudRef = null;
  var cloudWriting = false;
  var cloudPending = false;
  var cloudPushTimer = null;

  function setCloudStatus(text) {
    var el = document.getElementById('cloudStatus');
    if (!el) return;
    if (text) { el.textContent = text; el.hidden = false; } else { el.hidden = true; }
  }

  function adoptRemoteState(remote) {
    state = normalizeSubjectGroups(Object.assign(defaultState(), remote));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function pushStateToCloud() {
    if (!cloudRef) return;
    if (cloudWriting) { cloudPending = true; return; }
    cloudWriting = true;
    cloudRef.set(state).catch(function () {
      // 書き込み権限がない(読み取り専用の共有相手など)場合は、以後はpushせず読み取り専用で動かす
      cloudRef = null;
      setCloudStatus('クラウド同期: 読み取り専用(書き込み権限がありません)');
    }).then(function () {
      cloudWriting = false;
      if (cloudPending) { cloudPending = false; pushStateToCloud(); }
    });
  }

  function scheduleCloudPush() {
    if (!cloudRef) return;
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(pushStateToCloud, 1200);
  }

  async function initCloudSync() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    var db;
    try { db = await window.claude.use('db'); } catch (e) { db = null; }
    if (!db) return;
    cloudDb = db;
    var ref = db.doc(CLOUD_DOC_PATH);
    cloudRef = ref;
    setCloudStatus('クラウド同期: 確認中…');
    var syncedBefore = false;
    try { syncedBefore = localStorage.getItem(CLOUD_SYNCED_ONCE_KEY) === '1'; } catch (e) { /* ignore */ }
    try {
      var snap = await ref.get();
      if (snap.exists) {
        var remote = snap.data();
        if (!syncedBefore || (remote.updatedAt || 0) > (state.updatedAt || 0)) {
          adoptRemoteState(remote);
          renderAll();
          toast('クラウドの最新データを読み込みました');
        } else if ((state.updatedAt || 0) > (remote.updatedAt || 0)) {
          pushStateToCloud();
        }
      } else {
        pushStateToCloud();
      }
      try { localStorage.setItem(CLOUD_SYNCED_ONCE_KEY, '1'); } catch (e) { /* ignore */ }
      setCloudStatus('クラウド同期: 有効(他の端末でも同じ内容を開けます)');
    } catch (e) {
      setCloudStatus('クラウド同期: 読み込みに失敗しました(通信状況をご確認ください)');
    }
    ref.onSnapshot(function (snap) {
      if (!snap.exists) return;
      var remote = snap.data();
      if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
        adoptRemoteState(remote);
        renderAll();
        toast('他の端末での変更を取り込みました');
      }
    }, function (err) {
      setCloudStatus('クラウド同期: エラー(' + (err && err.code) + ')');
    });
  }
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function periodLabel(period) {
    var pt = state.periodTimes && state.periodTimes[period];
    if (pt && pt.start && pt.end) return period + '校時(' + pt.start + '-' + pt.end + ')';
    return period + '校時';
  }

  function teacherName(id) {
    var t = (state.teachers || []).find(function (x) { return x.id === id; });
    return t ? t.name : '(不明)';
  }

  // デュアル関連の教科は複数の教科グループに繰り返し使うため、
  // 「試験実施」にチェック済みでも「教科グループを作る」の候補から外さない。
  function isRepeatableGroupSubject(s) {
    return s.indexOf('デュアル') !== -1;
  }

  // クラスの教科マスタ一覧: 授業一覧由来の教科(削除されていないもの) + 手動追加した教科。
  function masterSubjectsFor(cls) {
    var fromLessons = Engine.subjectCandidates(state.lessons, cls);
    var extra = (state.customSubjects && state.customSubjects[cls]) || [];
    var removed = (state.removedSubjects && state.removedSubjects[cls]) || [];
    var set = {};
    fromLessons.concat(extra).forEach(function (s) { if (removed.indexOf(s) === -1) set[s] = true; });
    return Object.keys(set).sort();
  }

  function addSubjectToClass(cls, name) {
    name = (name || '').trim();
    if (!name) return false;
    if (masterSubjectsFor(cls).indexOf(name) !== -1) return false;
    state.customSubjects[cls] = state.customSubjects[cls] || [];
    state.customSubjects[cls].push(name);
    var removed = state.removedSubjects[cls];
    if (removed) {
      var ri = removed.indexOf(name);
      if (ri !== -1) removed.splice(ri, 1);
    }
    saveState();
    return true;
  }

  function examUsageCount(cls, name) {
    var n = 0;
    Object.keys(state.exams).forEach(function (key) {
      var parts = key.split('|');
      if (parts[2] === cls && state.exams[key].subject === name) n++;
    });
    return n;
  }

  function removeSubjectFromClass(cls, name) {
    state.removedSubjects[cls] = state.removedSubjects[cls] || [];
    if (state.removedSubjects[cls].indexOf(name) === -1) state.removedSubjects[cls].push(name);
    if (state.customSubjects[cls]) {
      state.customSubjects[cls] = state.customSubjects[cls].filter(function (s) { return s !== name; });
    }
    if (state.examSubjects[cls]) {
      state.examSubjects[cls] = state.examSubjects[cls].filter(function (s) { return s !== name; });
    }
    delete state.setters[Engine.subjClsKey(name, cls)];
    saveState();
  }

  function renameSubjectInClass(cls, oldName, newName) {
    newName = (newName || '').trim();
    if (!newName || newName === oldName) return false;
    if (masterSubjectsFor(cls).indexOf(newName) !== -1) { toast('同じ名前の教科が既にあります'); return false; }
    state.customSubjects[cls] = state.customSubjects[cls] || [];
    var ci = state.customSubjects[cls].indexOf(oldName);
    if (ci !== -1) state.customSubjects[cls][ci] = newName; else state.customSubjects[cls].push(newName);
    state.removedSubjects[cls] = state.removedSubjects[cls] || [];
    if (state.removedSubjects[cls].indexOf(oldName) === -1) state.removedSubjects[cls].push(oldName);

    if (state.examSubjects[cls]) {
      var ei = state.examSubjects[cls].indexOf(oldName);
      if (ei !== -1) state.examSubjects[cls][ei] = newName;
    }
    var oldKey = Engine.subjClsKey(oldName, cls), newKey = Engine.subjClsKey(newName, cls);
    if (state.setters[oldKey] !== undefined) { state.setters[newKey] = state.setters[oldKey]; delete state.setters[oldKey]; }
    Object.keys(state.exams).forEach(function (key) {
      var parts = key.split('|');
      if (parts[2] === cls && state.exams[key].subject === oldName) state.exams[key].subject = newName;
    });
    saveState();
    return true;
  }

  // 試験時間割の入力候補: 決定済みの教科 + そのクラスの教科グループ名。
  // 未決定(examSubjects未設定)なら教科マスタ一覧を候補にする。
  function scheduleOptionsFor(cls) {
    var confirmed = (state.examSubjects && state.examSubjects[cls]) || [];
    var base = confirmed.length ? confirmed.slice() : masterSubjectsFor(cls);
    var grade = Engine.gradeOf(cls);
    (state.subjectGroups || []).forEach(function (g) {
      if (g.grade === grade && base.indexOf(g.name) === -1) base.push(g.name);
    });
    return base;
  }

  // ---- 学年単位の操作(内部ではクラスごとのデータに書き込む一括操作) ----
  function allGrades() {
    var set = {};
    (state.grades || []).forEach(function (g) { set[g] = true; });
    state.classes.forEach(function (c) { set[Engine.gradeOf(c)] = true; });
    return Object.keys(set).sort();
  }
  function classesOfGrade(grade) {
    return state.classes.filter(function (c) { return Engine.gradeOf(c) === grade; });
  }
  function addGrade(name) {
    name = (name || '').trim();
    if (!name) return false;
    state.grades = state.grades || [];
    if (state.grades.indexOf(name) !== -1) return false;
    state.grades.push(name);
    state.grades.sort();
    saveState();
    return true;
  }
  function removeGrade(name) {
    state.grades = (state.grades || []).filter(function (g) { return g !== name; });
    saveState();
  }
  function masterSubjectsForGrade(grade) {
    var set = {};
    classesOfGrade(grade).forEach(function (cls) {
      masterSubjectsFor(cls).forEach(function (s) { set[s] = true; });
    });
    return Object.keys(set).sort();
  }
  function gradeConfirmInfo(grade, subject) {
    var classes = classesOfGrade(grade);
    var n = 0;
    classes.forEach(function (cls) { if ((state.examSubjects[cls] || []).indexOf(subject) !== -1) n++; });
    return { n: n, total: classes.length };
  }
  function setGradeSubjectConfirmed(grade, subject, checked) {
    classesOfGrade(grade).forEach(function (cls) {
      var arr = state.examSubjects[cls] || [];
      var i = arr.indexOf(subject);
      if (checked && i === -1) arr.push(subject);
      if (!checked && i !== -1) arr.splice(i, 1);
      state.examSubjects[cls] = arr;
    });
    saveState();
  }
  function addSubjectToGrade(grade, name) {
    var classes = classesOfGrade(grade);
    if (!classes.length) return false;
    var any = false;
    classes.forEach(function (cls) { if (addSubjectToClass(cls, name)) any = true; });
    return any;
  }
  function removeSubjectFromGrade(grade, name) {
    classesOfGrade(grade).forEach(function (cls) { removeSubjectFromClass(cls, name); });
    // 学年の教科グループからもこの教科を外す(グループが空になったら削除)
    state.subjectGroups = (state.subjectGroups || []).map(function (g) {
      if (g.grade !== grade) return g;
      g.subjects = g.subjects.filter(function (s) { return s !== name; });
      return g;
    }).filter(function (g) { return g.subjects.length > 0; });
    saveState();
  }
  function renameSubjectInGrade(grade, oldName, newName) {
    newName = (newName || '').trim();
    if (!newName || newName === oldName) return false;
    var classes = classesOfGrade(grade);
    for (var i = 0; i < classes.length; i++) {
      if (masterSubjectsFor(classes[i]).indexOf(newName) !== -1) {
        toast('クラス ' + classes[i] + ' に既に同じ名前の教科があります');
        return false;
      }
    }
    classes.forEach(function (cls) { renameSubjectInClass(cls, oldName, newName); });
    // 学年の教科グループに含まれていれば、こちらも名前を差し替える
    (state.subjectGroups || []).forEach(function (g) {
      if (g.grade !== grade) return;
      var i2 = g.subjects.indexOf(oldName);
      if (i2 !== -1) g.subjects[i2] = newName;
    });
    saveState();
    return true;
  }
  // 学年単位の教科グループを作る。選択科目は学年の全クラスで同じ構成にするのが初期設定なので、
  // まだその教科がないクラスには自動的に追加する(教科グループ自体はクラスをまたがず、学年に1つだけ持つ)。
  function createGroupForGrade(grade, name, subjectNames) {
    var existing = (state.subjectGroups || []).filter(function (g) { return g.grade === grade; });
    if (existing.some(function (g) { return g.name === name; })) {
      return { createdIn: [], skipped: ['同じ名前のグループが既にあります'] };
    }
    var createdIn = [];
    classesOfGrade(grade).forEach(function (cls) {
      subjectNames.forEach(function (s) {
        if (masterSubjectsFor(cls).indexOf(s) === -1) addSubjectToClass(cls, s);
      });
      var arr = state.examSubjects[cls] || [];
      subjectNames.forEach(function (s) { if (arr.indexOf(s) === -1) arr.push(s); });
      state.examSubjects[cls] = arr;
      createdIn.push(cls);
    });
    state.subjectGroups.push({ id: uid('grp'), grade: grade, name: name, subjects: subjectNames.slice() });
    saveState();
    return { createdIn: createdIn, skipped: [] };
  }

  var subjectEditTarget = null; // {scope:'grade',key,name} 編集中の教科(renderSubjectsのみで使う一時状態)
  var clearScheduleConfirmPending = false; // 「時間割をクリアして組み直す」の確認待ち状態(renderExamのみで使う一時状態)
  var restoreBackupConfirmPending = false; // 「このテキストで全データを復元」の確認待ち状態(renderDataのみで使う一時状態)
  var restoreBackupText = ''; // 確認待ちの間も、貼り付けた内容が画面の描き直しで消えないように保持する

  // ---- tabs ----
  var TABS = [
    { id: 'data', label: 'データ連携', render: renderData },
    { id: 'settings', label: '日程・時限', render: renderSettings },
    { id: 'subjects', label: '試験教科決定', render: renderSubjects },
    { id: 'exam', label: '試験時間割・監督割り当て', render: renderExam },
    { id: 'setters', label: '出題者確認', render: renderSetters },
    { id: 'absence', label: '出張・欠勤', render: renderAbsence },
    { id: 'selfstudy', label: '自習バランス', render: renderSelfStudy },
    { id: 'teacherview', label: '教員別一覧', render: renderTeacherView }
  ];
  var curTab = TABS[0].id;

  function renderTabs() {
    var nav = document.getElementById('tabs');
    nav.innerHTML = '';
    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.textContent = t.label;
      if (t.id === curTab) b.className = 'on';
      b.onclick = function () { curTab = t.id; clearScheduleConfirmPending = false; restoreBackupConfirmPending = false; renderAll(); };
      nav.appendChild(b);
    });
  }
  function renderAll() {
    renderTabs();
    var view = document.getElementById('view');
    view.innerHTML = '';
    var tab = TABS.find(function (t) { return t.id === curTab; });
    tab.render(view);
  }

  // ---- データ連携 ----
  function renderData(view) {
    var deptCount = {};
    (state.teachers || []).forEach(function (t) { deptCount[t.dept] = (deptCount[t.dept] || 0) + 1; });

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>授業交換ナビのデータ</h2>' +
      '<p class="mut">読み込み日時: ' + esc(new Date(state.importedAt).toLocaleString('ja-JP')) + '</p>' +
      '<p>教員 ' + state.teachers.length + ' 名 / 授業 ' + state.lessons.length + ' コマ / クラス ' + state.classes.length + ' 件</p>' +
      '<p class="mut">' + Object.keys(deptCount).sort().map(function (d) { return esc(d) + '(' + deptCount[d] + ')'; }).join(' ・ ') + '</p>' +
      '<h3>再インポート</h3>' +
      '<p class="mut">授業交換ナビ(jugyo-koukan)の data.js を開き、<code>window.DEFAULT_DATA = {...}</code> の中身(teachers・lessons・subRolesを含むオブジェクト)をそのまま貼り付けて更新できます。</p>' +
      '<textarea id="importTa" rows="4" style="width:100%" placeholder=\'{"teachers":[...],"lessons":[...],"subRoles":[...]}\'></textarea>' +
      '<div class="row"><button class="b" id="importBtn">この内容で更新</button></div>';
    view.appendChild(card);

    card.querySelector('#importBtn').onclick = function () {
      var ta = card.querySelector('#importTa');
      try {
        var obj = JSON.parse(ta.value);
        if (!obj.teachers || !obj.lessons) throw new Error('teachers / lessons が見つかりません');
        state.teachers = obj.teachers;
        state.lessons = obj.lessons;
        state.subRoles = obj.subRoles || [];
        var clsSet = {};
        state.lessons.forEach(function (l) { if (/^\d+-\d+$/.test(l.c)) clsSet[l.c] = true; });
        state.classes.forEach(function (c) { clsSet[c] = true; }); // 既存クラスは維持
        state.classes = Object.keys(clsSet).sort();
        state.importedAt = new Date().toISOString();
        saveState();
        toast('データを更新しました');
        renderAll();
      } catch (e) {
        toast('読み込み失敗: ' + e.message);
      }
    };

    var card2 = document.createElement('div');
    card2.className = 'card';
    card2.innerHTML = '<h2>教員一覧</h2><p class="mut">管理職など監督に入らない教員は「監督対象外」をチェックしてください。「教科」は授業交換ナビから読み込んだ担当教科(部活動の部ではなく教科)で、誤りがあれば直接修正できます。「上限」に数値を入れると、その教員の監督回数(予備以外)がその回数を超えないようにします(空欄=無制限)。「予備のみ」をチェックすると、その教員は予備(バックアップ)監督にだけ割り当て、試験監督や自習の見守りには入れません。</p>';
    var tbl = document.createElement('table');
    tbl.innerHTML = '<tr><th>氏名</th><th>教科</th><th>監督対象外</th><th>予備のみ</th><th>上限(回)</th></tr>';
    state.teachers.forEach(function (t) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(t.name) + '</td><td></td><td></td><td></td><td></td>';
      var deptIn = document.createElement('input');
      deptIn.type = 'text'; deptIn.value = t.dept || '';
      deptIn.onchange = function () { t.dept = deptIn.value.trim(); saveState(); };
      tr.cells[1].appendChild(deptIn);
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!t.noCover;
      cb.onchange = function () { t.noCover = cb.checked; saveState(); };
      tr.cells[2].appendChild(cb);
      var rcb = document.createElement('input');
      rcb.type = 'checkbox'; rcb.checked = !!t.reserveOnly;
      rcb.onchange = function () { if (rcb.checked) t.reserveOnly = true; else delete t.reserveOnly; saveState(); };
      tr.cells[3].appendChild(rcb);
      var maxIn = document.createElement('input');
      maxIn.type = 'number'; maxIn.min = '0'; maxIn.placeholder = '無制限';
      if (t.maxCount != null) maxIn.value = t.maxCount;
      maxIn.onchange = function () {
        var v = maxIn.value.trim();
        if (v === '') delete t.maxCount; else t.maxCount = Math.max(0, parseInt(v, 10) || 0);
        saveState();
      };
      tr.cells[4].appendChild(maxIn);
      tbl.appendChild(tr);
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card2.appendChild(wrap);
    view.appendChild(card2);

    var card3 = document.createElement('div');
    card3.className = 'card';
    card3.innerHTML = '<h2>監督対象クラス</h2><p class="mut">試験監督が必要なホームルームクラスを管理します。</p>' +
      '<div class="row">' + state.classes.map(function (c) {
        return '<span class="chip">' + esc(c) + ' <a href="#" data-del="' + esc(c) + '" style="color:var(--bad);text-decoration:none">×</a></span>';
      }).join('') + '</div>' +
      '<div class="row"><label>追加するクラス<input id="newCls" placeholder="例: 1-1"></label><button class="b sec" id="addClsBtn">追加</button></div>';
    view.appendChild(card3);
    card3.querySelectorAll('[data-del]').forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var c = a.getAttribute('data-del');
        state.classes = state.classes.filter(function (x) { return x !== c; });
        saveState(); renderAll();
      };
    });
    card3.querySelector('#addClsBtn').onclick = function () {
      var v = card3.querySelector('#newCls').value.trim();
      if (!v) return;
      if (state.classes.indexOf(v) === -1) { state.classes.push(v); state.classes.sort(); saveState(); renderAll(); }
    };

    var card4 = document.createElement('div'); card4.className = 'card';
    card4.innerHTML = '<h2>全データのバックアップ(書き出し/読み込み)</h2>' +
      '<p class="mut">試験時間割・監督割り当て・教員一覧など、すべてのデータをテキストとして書き出せます。' +
      'オフラインのスマホなどで編集した内容を別の端末に反映したいときは、オフライン側でこのテキストをコピーし、' +
      '反映したい側の「読み込む」欄に貼り付けて実行してください。</p>' +
      '<h3>書き出す</h3>' +
      '<textarea id="backupExportTa" rows="4" style="width:100%" readonly></textarea>' +
      '<div class="row"><button class="b sec" id="backupCopyBtn">全選択してコピー</button></div>' +
      '<h3>読み込む</h3>' +
      '<p class="mut bad">注意: 実行すると今の内容(試験時間割・監督割り当てなどすべて)が、貼り付けた内容でまるごと置き換わります。元に戻せません。</p>' +
      '<textarea id="backupImportTa" rows="4" style="width:100%" placeholder="書き出したテキストをここに貼り付け"></textarea>' +
      '<div class="row"><button class="' + (restoreBackupConfirmPending ? 'b del' : 'b sec') + '" id="backupRestoreBtn">' +
      (restoreBackupConfirmPending ? 'もう一度クリックで実行(元に戻せません)' : 'この内容で全データを復元') + '</button></div>';
    view.appendChild(card4);

    var exportTa = card4.querySelector('#backupExportTa');
    exportTa.value = JSON.stringify(state);
    exportTa.onclick = function () { exportTa.select(); };
    card4.querySelector('#backupCopyBtn').onclick = function () {
      exportTa.focus();
      exportTa.select();
      try { exportTa.setSelectionRange(0, exportTa.value.length); } catch (e) { /* ignore */ }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(exportTa.value).then(function () {
            toast('コピーしました');
          }).catch(function () {
            toast('全選択しました。コピー(Ctrl+C など)して貼り付けてください');
          });
          return;
        }
      } catch (e) { /* ignore */ }
      toast('全選択しました。コピー(Ctrl+C など)して貼り付けてください');
    };

    var importTa = card4.querySelector('#backupImportTa');
    importTa.value = restoreBackupText;
    importTa.oninput = function () { restoreBackupText = importTa.value; };
    card4.querySelector('#backupRestoreBtn').onclick = function () {
      var text = importTa.value.trim();
      restoreBackupText = importTa.value;
      if (!text) { toast('貼り付ける内容がありません'); return; }
      var obj;
      try {
        obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('内容が正しくありません');
      } catch (e) {
        restoreBackupConfirmPending = false;
        toast('読み込み失敗: 貼り付けた内容が途中で切れているか、正しくありません(' + e.message + ')');
        return;
      }
      if (!restoreBackupConfirmPending) {
        restoreBackupConfirmPending = true;
        var planCount = Array.isArray(obj.plans) ? obj.plans.length : 0;
        toast('今のすべてのデータを、貼り付けた内容(案' + planCount + '件を含む)で置き換えます。もう一度押すと実行します。');
        renderAll();
        return;
      }
      restoreBackupConfirmPending = false;
      restoreBackupText = '';
      state = normalizeSubjectGroups(Object.assign(defaultState(), obj));
      saveState();
      toast('全データを復元しました' + (Array.isArray(state.plans) && state.plans.length ? '(案' + state.plans.length + '件)' : ''));
      renderAll();
    };
  }

  // ---- 日程・時限 ----
  function setDayPeriodActive(d, p, checked) {
    var full = state.periods.slice().sort(function (a, b) { return a - b; });
    var cur = (state.dayPeriods && state.dayPeriods[d.id]) ? state.dayPeriods[d.id].slice() : full.slice();
    cur = cur.filter(function (x) { return x !== p; });
    if (checked) cur.push(p);
    cur.sort(function (a, b) { return a - b; });
    var isFull = cur.length === full.length && cur.every(function (x, i) { return x === full[i]; });
    state.dayPeriods = state.dayPeriods || {};
    if (isFull) delete state.dayPeriods[d.id]; else state.dayPeriods[d.id] = cur;
    if (!checked) Engine.clearExamDataAt(state, d.id, p);
    saveState(); renderAll();
  }

  function renderSettings(view) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>テスト日程・時限</h2><p class="mut">下の「試験を実施する時限」で日程全体で使う時限と時刻を設定します。各日の行のチェックを外すと、その日だけその時限を試験なし(通常授業)にできます(例: 最終日だけ午後の時限を使わない)。</p>';
    var tbl = document.createElement('table');
    tbl.innerHTML = '<tr><th>日付</th><th>曜日</th><th>メモ</th>' +
      state.periods.map(function (p) { return '<th>' + esc(p + '校時') + '</th>'; }).join('') + '<th></th></tr>';
    state.testDays.forEach(function (d) {
      var tr = document.createElement('tr');
      var wd = weekdayLabel(d.date);
      var wdWarn = (wd === '土' || wd === '日') ? ' <span class="bad">(休日注意)</span>' : '';
      tr.innerHTML = '<td>' + esc(d.date) + '</td><td>' + esc(wd) + wdWarn + '</td><td>' + esc(d.note || '') + '</td>' +
        state.periods.map(function () { return '<td></td>'; }).join('') + '<td></td>';
      var activePeriods = Engine.periodsForDay(state, d.id);
      state.periods.forEach(function (p, i) {
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = activePeriods.indexOf(p) !== -1;
        cb.onchange = function () { setDayPeriodActive(d, p, cb.checked); };
        tr.cells[3 + i].appendChild(cb);
      });
      var delBtn = document.createElement('button');
      delBtn.className = 'b del'; delBtn.textContent = '削除';
      delBtn.onclick = function () {
        state.testDays = state.testDays.filter(function (x) { return x.id !== d.id; });
        delete state.dayPeriods[d.id];
        saveState(); renderAll();
      };
      tr.lastChild.appendChild(delBtn);
      tbl.appendChild(tr);
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card.appendChild(wrap);

    var addRow = document.createElement('div');
    addRow.className = 'row';
    addRow.innerHTML = '<label>日付<input type="date" id="newDate"></label><label>メモ<input id="newNote" placeholder="1日目など"></label>';
    var addBtn = document.createElement('button'); addBtn.className = 'b sec'; addBtn.textContent = '追加';
    addBtn.onclick = function () {
      var dateVal = addRow.querySelector('#newDate').value;
      if (!dateVal) return;
      state.testDays.push({ id: uid('day'), date: dateVal, note: addRow.querySelector('#newNote').value.trim() });
      state.testDays.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      saveState(); renderAll();
    };
    addRow.appendChild(addBtn);
    card.appendChild(addRow);
    view.appendChild(card);

    var card2 = document.createElement('div');
    card2.className = 'card';
    card2.innerHTML = '<h2>試験を実施する時限</h2><p class="mut">日程全体でどの時限を使うか、何時から何時かを設定します(上の表の時限列もここに合わせて増減します)。この時限以外は通常授業として扱われます(自習判定にも使います)。時刻は時間割表示用のメモで、割り当てロジックには使いません。</p>';
    var tbl2 = document.createElement('table');
    tbl2.innerHTML = '<tr><th>実施</th><th>時限</th><th>開始</th><th>終了</th></tr>';
    for (var p = 1; p <= 6; p++) {
      (function (p) {
        var tr = document.createElement('tr');
        var tdCb = document.createElement('td');
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.periods.indexOf(p) !== -1;
        cb.onchange = function () {
          var set = {}; state.periods.forEach(function (x) { set[x] = true; });
          if (cb.checked) set[p] = true; else delete set[p];
          state.periods = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
          saveState(); renderAll();
        };
        tdCb.appendChild(cb);
        var tdLabel = document.createElement('td'); tdLabel.textContent = p + '校時';
        var pt = (state.periodTimes && state.periodTimes[p]) || {};
        var tdStart = document.createElement('td');
        var inStart = document.createElement('input'); inStart.type = 'time'; inStart.value = pt.start || '';
        inStart.onchange = function () {
          state.periodTimes[p] = state.periodTimes[p] || {};
          state.periodTimes[p].start = inStart.value;
          saveState(); renderAll();
        };
        tdStart.appendChild(inStart);
        var tdEnd = document.createElement('td');
        var inEnd = document.createElement('input'); inEnd.type = 'time'; inEnd.value = pt.end || '';
        inEnd.onchange = function () {
          state.periodTimes[p] = state.periodTimes[p] || {};
          state.periodTimes[p].end = inEnd.value;
          saveState(); renderAll();
        };
        tdEnd.appendChild(inEnd);
        tr.appendChild(tdCb); tr.appendChild(tdLabel); tr.appendChild(tdStart); tr.appendChild(tdEnd);
        tbl2.appendChild(tr);
      })(p);
    }
    var wrap2 = document.createElement('div'); wrap2.className = 'scroll'; wrap2.appendChild(tbl2);
    card2.appendChild(wrap2);
    view.appendChild(card2);

    var card3 = document.createElement('div'); card3.className = 'card';
    card3.innerHTML = '<h2>予備(バックアップ)監督</h2><p class="mut">試験が行われる時限ごとに、特定のクラスに紐づかない予備の監督を置けます(急な欠席への対応用)。0人なら使いません。</p>';
    var row3 = document.createElement('div'); row3.className = 'row';
    var lab3 = document.createElement('label'); lab3.textContent = '予備の人数';
    var in3 = document.createElement('input'); in3.type = 'number'; in3.min = '0'; in3.max = '3';
    in3.value = state.reserveCount || 0;
    in3.onchange = function () {
      var v = Math.max(0, Math.min(3, Number(in3.value) || 0));
      state.reserveCount = v; in3.value = v;
      saveState(); renderAll();
    };
    lab3.appendChild(in3);
    row3.appendChild(lab3);
    card3.appendChild(row3);
    view.appendChild(card3);

    var card4 = document.createElement('div'); card4.className = 'card';
    card4.innerHTML = '<h2>場所(教室)</h2><p class="mut">試験や自習を行う場所の選択肢です。「試験時間割・監督割り当て」タブの各コマで、日付×時限×クラスごとに選べます。</p>';
    var chipRow4 = document.createElement('div'); chipRow4.className = 'row';
    (state.locations || []).forEach(function (loc) {
      var chip = document.createElement('span'); chip.className = 'chip';
      chip.appendChild(document.createTextNode(loc + ' '));
      var del = document.createElement('a'); del.href = '#'; del.textContent = '×';
      del.style.color = 'var(--bad)'; del.style.textDecoration = 'none';
      del.onclick = function (e) {
        e.preventDefault();
        state.locations = state.locations.filter(function (x) { return x !== loc; });
        saveState(); renderAll();
      };
      chip.appendChild(del);
      chipRow4.appendChild(chip);
    });
    card4.appendChild(chipRow4);
    var addRow4 = document.createElement('div'); addRow4.className = 'row';
    var addLab4 = document.createElement('label'); addLab4.textContent = '場所を追加';
    var addIn4 = document.createElement('input'); addIn4.placeholder = '例: 体育館';
    addLab4.appendChild(addIn4);
    addRow4.appendChild(addLab4);
    var addBtn4 = document.createElement('button'); addBtn4.className = 'b sec'; addBtn4.textContent = '追加';
    addBtn4.onclick = function () {
      var v = addIn4.value.trim();
      if (!v) return;
      state.locations = state.locations || [];
      if (state.locations.indexOf(v) !== -1) { toast('同じ場所が既にあります'); return; }
      state.locations.push(v); state.locations.sort();
      saveState(); renderAll();
    };
    addRow4.appendChild(addBtn4);
    card4.appendChild(addRow4);
    view.appendChild(card4);
  }

  // ---- 出題者確認 ----
  function renderSetters(view) {
    var slots = Engine.listExamSlots(state);
    var combos = {};
    slots.forEach(function (s) {
      var members = Engine.effectiveSubjects(state, s.cls, s.subject);
      members.forEach(function (m) {
        var key = Engine.subjClsKey(m.subject, m.cls);
        var isGroupMember = (m.cls !== s.cls || m.subject !== s.subject);
        combos[key] = { subject: m.subject, cls: m.cls, groupLabel: isGroupMember ? (s.subject + (m.cls !== s.cls ? '(' + s.cls + ')' : '')) : null };
      });
    });
    var keys = Object.keys(combos).sort();

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>出題者の確認</h2><p class="mut">授業交換ナビの担当教員から自動推定しています。複数候補がいる場合(チームティーチング等)は選び直してください。教科グループ(選択A等)は、含まれる教科ごとに出題者を確認してください。</p>';
    if (!keys.length) {
      card.innerHTML += '<p class="mut">まだ試験時間割が入力されていません。</p>';
      view.appendChild(card); return;
    }
    function buildSetterTable(subKeys) {
      var tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>科目</th><th>クラス</th><th>出題者1</th><th>出題者2</th></tr>';
      subKeys.forEach(function (key) {
        var c = combos[key];
        var cands = Engine.setterCandidates(state.lessons, state.subRoles, c.subject, c.cls);
        var manualRaw = state.setters[key];
        var manual = Array.isArray(manualRaw) ? manualRaw : (manualRaw ? [manualRaw] : []);
        var tr = document.createElement('tr');
        var subjCell = esc(c.subject) + (c.groupLabel ? ' <span class="mut">(' + esc(c.groupLabel) + ')</span>' : '');
        tr.innerHTML = '<td>' + subjCell + '</td><td>' + esc(c.cls) + '</td><td></td><td></td>';
        function onSetterChange() {
          var next = [sel1.value, sel2.value].filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
          if (next.length) state.setters[key] = next; else delete state.setters[key];
          saveState();
        }
        function makeSetterSelect(idx, placeholder) {
          var sel = document.createElement('select');
          var opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = placeholder;
          sel.appendChild(opt0);
          state.teachers.forEach(function (t) {
            var o = document.createElement('option'); o.value = t.id; o.textContent = t.name + (cands.indexOf(t.id) !== -1 ? ' ★候補' : '');
            if (manual[idx] === t.id) o.selected = true;
            sel.appendChild(o);
          });
          sel.onchange = onSetterChange;
          return sel;
        }
        var sel1 = makeSetterSelect(0, '(自動推定: ' + (cands[0] ? teacherName(cands[0]) : 'なし') + ')');
        var sel2 = makeSetterSelect(1, '(なし)');
        tr.cells[2].appendChild(sel1);
        tr.cells[3].appendChild(sel2);
        tbl.appendChild(tr);
      });
      return tbl;
    }

    // 縦に長くなりすぎないよう、2列に分けて並べて表示する。
    var half = Math.ceil(keys.length / 2);
    var cols = [keys.slice(0, half), keys.slice(half)].filter(function (c) { return c.length; });
    var colsWrap = document.createElement('div'); colsWrap.className = 'setter-cols';
    cols.forEach(function (colKeys) {
      var wrap = document.createElement('div'); wrap.className = 'scroll';
      wrap.appendChild(buildSetterTable(colKeys));
      colsWrap.appendChild(wrap);
    });
    card.appendChild(colsWrap);
    view.appendChild(card);
  }

  // ---- 出張・欠勤 ----
  function renderAbsence(view) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>出張・欠勤の登録</h2>';
    var tbl = document.createElement('table');
    tbl.innerHTML = '<tr><th>教員</th><th>種別</th><th>期間</th><th>時限</th><th>メモ</th><th></th></tr>';
    state.absences.forEach(function (a) {
      var tr = document.createElement('tr');
      var absPeriodLabel = (a.periods === 'all' || !a.periods) ? '終日' : a.periods.join(',') + '校時';
      tr.innerHTML = '<td>' + esc(teacherName(a.teacherId)) + '</td><td>' + esc(a.type) + '</td>' +
        '<td>' + esc(a.start) + (a.start !== a.end ? ' ~ ' + esc(a.end) : '') + '</td>' +
        '<td>' + esc(absPeriodLabel) + '</td><td>' + esc(a.note || '') + '</td><td></td>';
      var delBtn = document.createElement('button'); delBtn.className = 'b del'; delBtn.textContent = '削除';
      delBtn.onclick = function () {
        state.absences = state.absences.filter(function (x) { return x.id !== a.id; });
        saveState(); renderAll();
      };
      tr.lastChild.appendChild(delBtn);
      tbl.appendChild(tr);
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card.appendChild(wrap);

    var form = document.createElement('div');
    form.innerHTML =
      '<h3>新規登録</h3>' +
      '<div class="row">' +
      '<label>教員<select id="aTeacher">' + state.teachers.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') + '</select></label>' +
      '<label>種別<select id="aType"><option>出張</option><option>欠勤</option><option>空き</option></select></label>' +
      '<label>開始日<input type="date" id="aStart"></label>' +
      '<label>終了日<input type="date" id="aEnd"></label>' +
      '<label>メモ<input id="aNote"></label>' +
      '</div>' +
      '<div class="row"><span class="mut">休む時間:</span>' +
      '<label class="inl"><input type="radio" name="aRange" id="aAllDay" value="all" checked> 終日</label>' +
      '<label class="inl"><input type="radio" name="aRange" id="aSomePeriods" value="some"> 時限を選ぶ</label></div>' +
      '<div class="row"><span id="aPeriods" class="row" style="display:none"></span></div>' +
      '<button class="b sec" id="aAddBtn">登録</button>';
    card.appendChild(form);
    view.appendChild(card);

    var periodsBox = form.querySelector('#aPeriods');
    for (var p = 1; p <= 6; p++) {
      (function (p) {
        var lab = document.createElement('label'); lab.className = 'inl';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = p; cb.className = 'aPeriodCb';
        lab.appendChild(cb); lab.appendChild(document.createTextNode(p + '校時'));
        periodsBox.appendChild(lab);
      })(p);
    }
    function syncRange() {
      periodsBox.style.display = form.querySelector('#aSomePeriods').checked ? 'flex' : 'none';
    }
    form.querySelector('#aAllDay').onchange = syncRange;
    form.querySelector('#aSomePeriods').onchange = syncRange;
    form.querySelector('#aAddBtn').onclick = function () {
      var start = form.querySelector('#aStart').value;
      var end = form.querySelector('#aEnd').value || start;
      if (!start) { toast('開始日を入力してください'); return; }
      var allDay = form.querySelector('#aAllDay').checked;
      var periods = 'all';
      if (!allDay) {
        periods = Array.prototype.slice.call(form.querySelectorAll('.aPeriodCb'))
          .filter(function (cb) { return cb.checked; }).map(function (cb) { return Number(cb.value); });
        if (!periods.length) { toast('休む時限を1つ以上選んでください'); return; }
      }
      state.absences.push({
        id: uid('abs'), teacherId: form.querySelector('#aTeacher').value,
        type: form.querySelector('#aType').value, start: start, end: end,
        periods: periods, note: form.querySelector('#aNote').value.trim()
      });
      saveState(); renderAll();
    };
  }

  // ---- 試験教科決定 ----
  // 教科の行(チェック・修正・削除)を組み立てる共通部品。クラス別・学年別の両方から使う。
  function buildSubjectRow(scopeType, scopeKey, s, checked, countLabel, onToggle, onRenameTry, onRemove) {
    var row = document.createElement('div'); row.className = 'subj-item';
    if (subjectEditTarget && subjectEditTarget.scope === scopeType && subjectEditTarget.key === scopeKey && subjectEditTarget.name === s) {
      var editIn = document.createElement('input'); editIn.value = s; editIn.style.minWidth = '160px';
      var saveBtn = document.createElement('button'); saveBtn.className = 'b sm'; saveBtn.textContent = '保存';
      saveBtn.onclick = function () {
        if (onRenameTry(editIn.value)) { subjectEditTarget = null; renderAll(); }
      };
      var cancelBtn = document.createElement('button'); cancelBtn.className = 'b sec sm'; cancelBtn.textContent = 'やめる';
      cancelBtn.onclick = function () { subjectEditTarget = null; renderAll(); };
      row.appendChild(editIn); row.appendChild(saveBtn); row.appendChild(cancelBtn);
    } else {
      var lab = document.createElement('label'); lab.className = 'inl';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = checked;
      cb.onchange = function () { onToggle(cb.checked); renderAll(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(s));
      row.appendChild(lab);

      if (countLabel) { var us = document.createElement('span'); us.className = 'mut'; us.style.fontSize = '11px'; us.textContent = countLabel; row.appendChild(us); }

      var editBtn = document.createElement('button'); editBtn.className = 'b sec sm'; editBtn.textContent = '✎';
      editBtn.title = '教科名を修正';
      editBtn.onclick = function () { subjectEditTarget = { scope: scopeType, key: scopeKey, name: s }; renderAll(); };
      row.appendChild(editBtn);

      var delBtn = document.createElement('button'); delBtn.className = 'b del'; delBtn.textContent = '削除';
      delBtn.onclick = function () { onRemove(); renderAll(); };
      row.appendChild(delBtn);
    }
    return row;
  }

  function renderSubjects(view) {
    if (!state.classes.length) {
      view.innerHTML = '<div class="card"><p class="mut">先に「データ連携」タブで監督対象クラスを登録してください。</p></div>';
      return;
    }
    var intro = document.createElement('div'); intro.className = 'card';
    intro.innerHTML = '<h2>試験教科の決定</h2>' +
      '<p class="mut">定期テストで実施する教科を学年ごとに決めます。チェック・追加・修正・削除すると、その学年の全クラスにまとめて反映されます。' +
      'チェックした教科が「試験時間割」タブの入力候補になります(1つもチェックしていないクラスは教科マスタ一覧が候補になります)。' +
      '選択科目のように同じ時間に複数の教科が並行して行われる場合は、「教科グループ」で2つ以上の教科をまとめて1つの名前(例: 選択A)にできます' +
      '(教科グループは学年単位です。作成すると、その学年の全クラスで同じ名前が使えるようになります)。' +
      'グループを作ると中の教科は自動でチェック(試験あり)されますが、後からそのチェックだけを外すと、その教科は試験を実施せず、同じコマの中でまとめて自習(見守りのみ)として扱われます' +
      '(選択科目の一部だけ筆記試験がない場合に使います)。</p>';
    view.appendChild(intro);

    renderSubjectsByGrade(view);
  }

  // 教科グループの一覧表示。
  function renderGroupsList(card, groups) {
    if (!groups.length) return;
    var gh = document.createElement('h3'); gh.textContent = '教科グループ';
    card.appendChild(gh);
    var gNote = document.createElement('p'); gNote.className = 'mut';
    gNote.textContent = '「各クラスで実施」にチェックすると、そのグループの教科(例: 美術Ⅱと音楽Ⅱ)を同じ時限に、生徒が集まらずそれぞれのクラスの教室で受けます。監督はグループの教科ごとではなく、通常の教科と同じくクラスごとに1人になります。';
    card.appendChild(gNote);
    groups.forEach(function (g) {
      var gRow = document.createElement('div'); gRow.className = 'row'; gRow.style.alignItems = 'center';
      var chip = document.createElement('span'); chip.className = 'chip';
      chip.appendChild(document.createTextNode(g.name + ' = ' + g.subjects.join(' + ') + ' '));
      var del = document.createElement('a'); del.href = '#'; del.textContent = '×';
      del.style.color = 'var(--bad)'; del.style.textDecoration = 'none';
      del.onclick = function (e) {
        e.preventDefault();
        state.subjectGroups = state.subjectGroups.filter(function (x) { return x.id !== g.id; });
        saveState(); renderAll();
      };
      chip.appendChild(del);
      gRow.appendChild(chip);
      var lab = document.createElement('label'); lab.className = 'inl';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!g.inClass;
      cb.onchange = function () {
        setGroupInClass(g, cb.checked);
        toast(cb.checked ? g.name + 'を各クラスで実施にしました。監督は割り当て直してください' : g.name + 'を集まって受ける形に戻しました。監督は割り当て直してください');
        renderAll();
      };
      lab.appendChild(cb); lab.appendChild(document.createTextNode('各クラスで実施(場所は各クラス・監督はクラスごと)'));
      gRow.appendChild(lab);
      card.appendChild(gRow);
    });
  }

  // 教科グループの実施方法(集まって受ける/各クラスで実施)を切り替える。監督の枠の形が変わるので、
  // そのグループのコマに入っていた監督・場所(グループ単位とクラス単位の両方)をいったん消す。
  function setGroupInClass(g, inClass) {
    if (inClass) g.inClass = true; else delete g.inClass;
    var pseudo = Engine.groupSlotCls(g.grade, g.name);
    var classKeys = {};
    Object.keys(state.exams || {}).forEach(function (key) {
      var e = state.exams[key];
      var parts = key.split('|');
      if (e && e.subject === g.name && Engine.gradeOf(parts[2]) === g.grade) classKeys[key] = true;
    });
    ['assignments', 'examLocations'].forEach(function (field) {
      var obj = state[field];
      if (!obj) return;
      Object.keys(obj).forEach(function (key) {
        var parts = key.split('|');
        if (parts[2] === pseudo || classKeys[parts.slice(0, 3).join('|')]) delete obj[key];
      });
    });
    saveState();
  }

  function renderSubjectsByGrade(view) {
    var gcard = document.createElement('div'); gcard.className = 'card';
    gcard.innerHTML = '<h2>学年の管理</h2><p class="mut">まだクラスがない学年も、先に学年だけ追加しておけます(教科の追加はクラスを登録してから行えます)。</p>';
    var chipRow = document.createElement('div'); chipRow.className = 'row';
    allGrades().forEach(function (g) {
      var chip = document.createElement('span'); chip.className = 'chip';
      chip.appendChild(document.createTextNode(g + '年 '));
      var del = document.createElement('a'); del.href = '#'; del.textContent = '×';
      del.style.color = 'var(--bad)'; del.style.textDecoration = 'none';
      del.onclick = function (e) { e.preventDefault(); removeGrade(g); renderAll(); };
      chip.appendChild(del);
      chipRow.appendChild(chip);
    });
    gcard.appendChild(chipRow);
    var addGradeRow = document.createElement('div'); addGradeRow.className = 'row';
    var addGradeLab = document.createElement('label'); addGradeLab.textContent = '学年を追加';
    var addGradeIn = document.createElement('input'); addGradeIn.placeholder = '例: 4'; addGradeIn.style.width = '70px';
    addGradeLab.appendChild(addGradeIn);
    addGradeRow.appendChild(addGradeLab);
    var addGradeBtn = document.createElement('button'); addGradeBtn.className = 'b sec'; addGradeBtn.textContent = '追加';
    addGradeBtn.onclick = function () {
      if (addGrade(addGradeIn.value)) renderAll(); else toast('学年名を確認してください(未入力か、既に同じ学年があります)');
    };
    addGradeRow.appendChild(addGradeBtn);
    gcard.appendChild(addGradeRow);
    view.appendChild(gcard);

    allGrades().forEach(function (grade) {
      var card = document.createElement('div'); card.className = 'card';
      var h = document.createElement('h3'); h.textContent = grade + '年';
      card.appendChild(h);

      var classes = classesOfGrade(grade);
      if (!classes.length) {
        var pEmpty = document.createElement('p'); pEmpty.className = 'mut';
        pEmpty.textContent = 'この学年にはまだクラスがありません。「データ連携」タブの監督対象クラスで追加してください。';
        card.appendChild(pEmpty);
        view.appendChild(card);
        return;
      }
      var pCls = document.createElement('p'); pCls.className = 'mut'; pCls.textContent = '対象クラス: ' + classes.join(', ');
      card.appendChild(pCls);

      var subjects = masterSubjectsForGrade(grade);
      if (!subjects.length) {
        var pEmpty2 = document.createElement('p'); pEmpty2.className = 'mut';
        pEmpty2.textContent = '教科がまだありません。下の「教科を追加」から登録してください。';
        card.appendChild(pEmpty2);
      } else {
        var listWrap = document.createElement('div'); listWrap.className = 'subj-list';
        subjects.forEach(function (s) {
          var info = gradeConfirmInfo(grade, s);
          var row = buildSubjectRow('grade', grade, s, info.n === info.total && info.total > 0, '',
            function (checked) { setGradeSubjectConfirmed(grade, s, checked); },
            function (newName) { return renameSubjectInGrade(grade, s, newName); },
            function () { removeSubjectFromGrade(grade, s); }
          );
          listWrap.appendChild(row);
        });
        card.appendChild(listWrap);
      }

      var addRow2 = document.createElement('div'); addRow2.className = 'row';
      var addLab2 = document.createElement('label'); addLab2.textContent = '教科を追加';
      var addIn2 = document.createElement('input'); addIn2.placeholder = '例: 総合的な探究の時間';
      addLab2.appendChild(addIn2);
      addRow2.appendChild(addLab2);
      var addBtn2 = document.createElement('button'); addBtn2.className = 'b sec'; addBtn2.textContent = '追加';
      addBtn2.onclick = function () {
        if (addSubjectToGrade(grade, addIn2.value)) { renderAll(); } else { toast('教科名を確認してください(未入力か、既に同名があります)'); }
      };
      addRow2.appendChild(addBtn2);
      card.appendChild(addRow2);

      var groupsForGrade = (state.subjectGroups || []).filter(function (g) { return g.grade === grade; });
      renderGroupsList(card, groupsForGrade);

      var gFormWrap = document.createElement('div');
      var gfh = document.createElement('h3'); gfh.textContent = '教科グループを作る';
      gFormWrap.appendChild(gfh);
      var gfp = document.createElement('p'); gfp.className = 'mut';
      gfp.textContent = '2つ以上の教科を選び、まとめた名前を付けます(例: 選択A)。この学年の全クラスに同じ名前・同じ構成のグループがまとめて作られます(その教科がまだないクラスには自動的に追加されます)。';
      gFormWrap.appendChild(gfp);

      var gPickRow = document.createElement('div'); gPickRow.className = 'row';
      var gPickCbs = [];
      var gPickable = subjects.filter(function (s) {
        if (isRepeatableGroupSubject(s)) return true;
        var info = gradeConfirmInfo(grade, s);
        return !(info.n === info.total && info.total > 0);
      });
      if (!gPickable.length) {
        var gpNone = document.createElement('p'); gpNone.className = 'mut'; gpNone.textContent = '上で試験実施にチェックしていない教科がありません。';
        gPickRow.appendChild(gpNone);
      }
      gPickable.forEach(function (s) {
        var lab = document.createElement('label'); lab.className = 'inl';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = s;
        lab.appendChild(cb); lab.appendChild(document.createTextNode(s));
        gPickRow.appendChild(lab);
        gPickCbs.push(cb);
      });
      gFormWrap.appendChild(gPickRow);

      var gNameRow = document.createElement('div'); gNameRow.className = 'row';
      var gNameLab = document.createElement('label'); gNameLab.textContent = 'グループ名';
      var gNameIn = document.createElement('input'); gNameIn.placeholder = '例: 選択A';
      gNameLab.appendChild(gNameIn);
      gNameRow.appendChild(gNameLab);
      var gMakeBtn = document.createElement('button'); gMakeBtn.className = 'b sec'; gMakeBtn.textContent = '作成';
      gMakeBtn.onclick = function () {
        var picked = gPickCbs.filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
        var name = gNameIn.value.trim();
        if (picked.length < 2) { toast('2つ以上の教科を選んでください'); return; }
        if (!name) { toast('グループ名を入力してください'); return; }
        var result = createGroupForGrade(grade, name, picked);
        if (!result.createdIn.length) { toast('作成できませんでした: ' + result.skipped.join(', ')); return; }
        toast('作成: ' + result.createdIn.join(', ') + (result.skipped.length ? ' (スキップ: ' + result.skipped.join(', ') + ')' : ''));
        renderAll();
      };
      gNameRow.appendChild(gMakeBtn);
      gFormWrap.appendChild(gNameRow);
      card.appendChild(gFormWrap);

      view.appendChild(card);
    });
  }

  // ---- 試験時間割・監督割り当て ----
  function renderExam(view) {
    if (!state.testDays.length) {
      view.innerHTML = '<div class="card"><p class="mut">先に「日程・時限」タブでテスト日程を登録してください。</p></div>';
      return;
    }

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>試験時間割・監督割り当て</h2>' +
      '<p class="mut">「AIで計算」を押すと、「試験教科決定」タブで決めた教科をもとに空いているコマへ試験時間割を自動で組み、' +
      'その場で監督も割り当てます。科目名が既に入っているコマはそのまま残し、未入力のコマだけ埋めます。' +
      '科目名は入力・修正することもできます(空欄 = 試験なし=自習)。自習のコマにも見守り教員と場所を選べます。' +
      '「確定」を入れたコマは、再計算を押しても教員が変わりません(自習も含む)。科目を修正すると確定は自動的に外れます。' +
      '場所は「日程・時限」タブで追加できます。必須科目(教科グループ以外)・自習の場所は、特に選ばなければ自分のクラス(そのクラスの教室)が既定値になります。別の場所(特別教室など)で行う場合だけ、場所のセレクトで選び直してください。' +
      '「AIで計算」は空いているコマしか埋めないため、条件(チェックボックス)を変えても既に入っているコマは動きません。' +
      '条件を変えて最初から組み直したいときは「時間割をクリアして組み直す」を使ってください(入力済みの時間割・監督割り当てが消えるので確認が出ます)。</p>';

    var rulesWrap = document.createElement('div');
    var rulesTitle = document.createElement('p'); rulesTitle.className = 'mut'; rulesTitle.textContent = '時間割を組む条件(チェックで有効):';
    rulesWrap.appendChild(rulesTitle);
    var rulesRow = document.createElement('div'); rulesRow.className = 'row';
    state.scheduleRules = state.scheduleRules || {};
    [
      { key: 'period1RequiredOnly', label: '1校時は必須科目のみにする' },
      { key: 'diversifyPeriod1Dept', label: '一つの教科がすべて1校時のテストにならないようにする' },
      { key: 'avoidSelfStudyAfterPeriod2', label: '自習はできるだけ1,2校時だけにする' },
      { key: 'electivesPreferMidPeriods', label: '選択科目はできるだけ2,3校時にする' },
      { key: 'avoidCrossGradeSamePeriod', label: '学年違いの同じ教科を同じ校時にしない' },
      { key: 'avoidSelfStudyEdgeDays', label: '自習は最終日にしない' },
      { key: 'electivesOnePerDay', label: '選択科目、自習は1日1科目までにする' },
      { key: 'avoidSameDeptSameDay', label: '1日に同じ教科(国・数・英・理・社など)を重ねない' }
    ].forEach(function (rule) {
      var lab = document.createElement('label'); lab.className = 'inl';
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = state.scheduleRules[rule.key] !== false;
      cb.onchange = function () { state.scheduleRules[rule.key] = cb.checked; saveState(); };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(rule.label));
      rulesRow.appendChild(lab);
    });
    rulesWrap.appendChild(rulesRow);
    card.appendChild(rulesWrap);

    var runBtn = document.createElement('button'); runBtn.className = 'b'; runBtn.textContent = 'AIで計算';
    runBtn.onclick = function () {
      var hasAnySubject = state.classes.some(function (c) { return Engine.schedulableItemsForClass(state, c).length > 0; });
      if (!hasAnySubject) { toast('先に「試験教科決定」タブで実施する教科を決めてください'); return; }
      var combined = Engine.buildScheduleWithAssignment(state, { iterations: 200 });
      var schedResult = { warnings: combined.scheduleWarnings };
      var result = combined.assignResult;
      state.assignments = result.assignments;
      saveState();
      var msgs = [];
      msgs.push(schedResult.warnings.length ? '時間割: 一部配置できず(要確認 ' + schedResult.warnings.length + '学年)' : '時間割を自動作成');
      if (combined.changes.length) msgs.push('監督が入らないコマがあったため時間割を' + combined.changes.length + '箇所調整');
      msgs.push(result.warnings.length ? '監督: 要確認 ' + result.warnings.length + '件' : '監督も割り当て完了');
      toast(msgs.join(' / '));
      renderAll();
    };
    card.appendChild(runBtn);

    var clearBtn = document.createElement('button');
    clearBtn.className = clearScheduleConfirmPending ? 'b del' : 'b sec';
    clearBtn.textContent = clearScheduleConfirmPending ? 'もう一度クリックで実行(元に戻せません)' : '時間割をクリアして組み直す';
    clearBtn.style.marginLeft = '8px';
    clearBtn.title = '既に入力済みのコマも含めて試験時間割をすべて空にしてから、現在の条件で自動的に組み直します(予備監督を除く)。';
    clearBtn.onclick = function () {
      if (!clearScheduleConfirmPending) {
        clearScheduleConfirmPending = true;
        toast('現在の試験時間割・監督割り当て(予備監督を除く)を消去して組み直します。もう一度押すと実行します。');
        renderAll();
        return;
      }
      clearScheduleConfirmPending = false;
      // 教科グループの監督割り当て(場所ごと)で指定した場所は、日時が変わっても引き継ぐために先に取り出しておく。
      var groupLocations = Engine.captureGroupLocations(state);
      // 教科を固定したコマだけは残し、それ以外の時間割を空にする。
      var keptExams = {};
      Object.keys(state.exams || {}).forEach(function (k) { if (state.exams[k] && state.exams[k].locked) keptExams[k] = state.exams[k]; });
      state.exams = keptExams;
      var keepAssign = {}, keepLoc = {};
      Object.keys(state.assignments || {}).forEach(function (key) {
        if (Engine.isReserveCls(key.split('|')[2])) keepAssign[key] = state.assignments[key];
      });
      Object.keys(state.examLocations || {}).forEach(function (key) {
        if (Engine.isReserveCls(key.split('|')[2])) keepLoc[key] = state.examLocations[key];
      });
      state.assignments = keepAssign;
      state.examLocations = keepLoc;

      var hasAnySubject = state.classes.some(function (c) { return Engine.schedulableItemsForClass(state, c).length > 0; });
      if (!hasAnySubject) { saveState(); toast('時間割をクリアしました。先に「試験教科決定」タブで実施する教科を決めてください'); renderAll(); return; }
      var combinedClear = Engine.buildScheduleWithAssignment(state, { iterations: 200, restoreGroupLocations: groupLocations });
      state.assignments = combinedClear.assignResult.assignments;
      saveState();
      var msgsClear = [];
      msgsClear.push(combinedClear.scheduleWarnings.length ? '時間割: 一部配置できず(要確認 ' + combinedClear.scheduleWarnings.length + '学年)' : '時間割をクリアして組み直し');
      if (combinedClear.changes.length) msgsClear.push('監督が入らないコマがあったため時間割を' + combinedClear.changes.length + '箇所調整');
      msgsClear.push(combinedClear.assignResult.warnings.length ? '監督: 要確認 ' + combinedClear.assignResult.warnings.length + '件' : '監督も割り当て完了');
      toast(msgsClear.join(' / '));
      renderAll();
    };
    card.appendChild(clearBtn);

    // 「確定(固定)」チェックをまとめて付け外しする(教員が入っているコマだけが対象。予備・教科グループの枠も含む)。
    var lockRow = document.createElement('div'); lockRow.className = 'row'; lockRow.style.marginTop = '10px';
    var lockable = Object.keys(state.assignments || {}).filter(function (k) { return state.assignments[k] && state.assignments[k].teacherId; });
    var lockedNow = lockable.filter(function (k) { return state.assignments[k].locked; }).length;
    var lockInfo = document.createElement('span'); lockInfo.className = 'mut';
    lockInfo.textContent = '確定(固定): ' + lockedNow + ' / ' + lockable.length + 'コマ';
    var lockAllBtn = document.createElement('button'); lockAllBtn.className = 'b sec sm'; lockAllBtn.textContent = '確定(固定)をすべて選択';
    lockAllBtn.onclick = function () {
      if (!lockable.length) { toast('教員が入っているコマがありません'); return; }
      lockable.forEach(function (k) { state.assignments[k].locked = true; });
      saveState(); toast(lockable.length + 'コマをすべて確定(固定)しました'); renderAll();
    };
    var unlockAllBtn = document.createElement('button'); unlockAllBtn.className = 'b sec sm'; unlockAllBtn.textContent = 'すべて解除';
    unlockAllBtn.onclick = function () {
      Object.keys(state.assignments || {}).forEach(function (k) { if (state.assignments[k]) state.assignments[k].locked = false; });
      saveState(); toast('確定(固定)をすべて解除しました'); renderAll();
    };
    lockRow.appendChild(lockAllBtn); lockRow.appendChild(unlockAllBtn); lockRow.appendChild(lockInfo);
    card.appendChild(lockRow);

    // 教科だけの固定をまとめて付け外しする(教科が入っているコマだけが対象)。
    var subjLockRow = document.createElement('div'); subjLockRow.className = 'row';
    var subjKeys = Object.keys(state.exams || {}).filter(function (k) { return state.exams[k] && state.exams[k].subject; });
    var subjLockedNow = subjKeys.filter(function (k) { return state.exams[k].locked; }).length;
    var subjLockAll = document.createElement('button'); subjLockAll.className = 'b sec sm'; subjLockAll.textContent = '教科をすべて固定';
    subjLockAll.onclick = function () {
      if (!subjKeys.length) { toast('教科が入っているコマがありません'); return; }
      subjKeys.forEach(function (k) { state.exams[k].locked = true; });
      saveState(); toast(subjKeys.length + 'コマの教科を固定しました'); renderAll();
    };
    var subjUnlockAll = document.createElement('button'); subjUnlockAll.className = 'b sec sm'; subjUnlockAll.textContent = '教科の固定をすべて解除';
    subjUnlockAll.onclick = function () {
      Object.keys(state.exams || {}).forEach(function (k) { if (state.exams[k]) delete state.exams[k].locked; });
      saveState(); toast('教科の固定をすべて解除しました'); renderAll();
    };
    var subjLockInfo = document.createElement('span'); subjLockInfo.className = 'mut';
    subjLockInfo.textContent = '教科固定: ' + subjLockedNow + ' / ' + subjKeys.length + 'コマ(固定した教科は「時間割をクリアして組み直す」や自動調整でも動きません)';
    subjLockRow.appendChild(subjLockAll); subjLockRow.appendChild(subjUnlockAll); subjLockRow.appendChild(subjLockInfo);
    card.appendChild(subjLockRow);
    view.appendChild(card);
    renderPlans(view);

    // 警告: 現割り当てのうち、現状の制約(出題者/出張/多忙)に違反しているものを検出
    var monitorSlots = Engine.listMonitorSlots(state);
    var reserveSlots = Engine.listReserveSlots(state);
    var selfStudySlots = Engine.listSelfStudySlots(state);
    var warnMap = {};
    function checkWarn(slot) {
      var key = slot.key;
      var a = state.assignments[key];
      if (!a || !a.teacherId) { warnMap[key] = '未割当'; return; }
      // その(日,時限)に試験が行われている教科の出題者は、学年・クラスを問わずそのコマ全体から除外する。
      var setters = Engine.settersAtTime(state, slot.dayId, slot.period);
      if (setters.indexOf(a.teacherId) !== -1) { warnMap[key] = '出題者と同一'; return; }
      if (Engine.isAbsent(state, a.teacherId, slot.date, slot.period)) { warnMap[key] = '出張・欠勤中'; return; }
      var at = state.teachers.filter(function (t) { return t.id === a.teacherId; })[0];
      if (at && at.reserveOnly && !slot.reserve) { warnMap[key] = '予備のみの教員'; return; }
    }
    monitorSlots.forEach(checkWarn);
    reserveSlots.forEach(checkWarn);
    selfStudySlots.forEach(checkWarn);

    // datalist 用の候補(決定済み教科 + 教科グループ名)
    var dlHtml = '';
    state.classes.forEach(function (c) {
      var cands = scheduleOptionsFor(c);
      dlHtml += '<datalist id="dl-' + esc(c) + '">' + cands.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>';
    });
    var dlWrap = document.createElement('div'); dlWrap.innerHTML = dlHtml;
    view.appendChild(dlWrap);

    // クラスごとに、どの教科が既にどのコマ(「12/2 3校時」)に置かれているか(プルダウンで「配置済」と示すため)。
    var placedSubjectsByClass = {};
    state.testDays.forEach(function (day) {
      Engine.periodsForDay(state, day.id).forEach(function (period) {
        state.classes.forEach(function (c) {
          var ex = state.exams[Engine.slotKey(day.id, period, c)];
          if (!ex || !ex.subject) return;
          placedSubjectsByClass[c] = placedSubjectsByClass[c] || {};
          (placedSubjectsByClass[c][ex.subject] = placedSubjectsByClass[c][ex.subject] || []).push(monthDayLabel(day.date) + ' ' + period + '校時');
        });
      });
    });

    // 監督(または自習の見守り)1人分の行(教員選択・確定・場所)を組み立てる。
    // horizontal=trueなら、教員選択・確定・場所を縦積みではなく横並びにする。
    // defaultLocationClsを指定すると、場所が未設定のときにそのクラス自身を既定の場所(自分のクラス)として選択状態にする。
    function buildMonitorRow(monitorKey, placeholderLabel, horizontal, defaultLocationCls) {
      var a = state.assignments[monitorKey] || {};
      var warn = warnMap[monitorKey];
      var row = document.createElement('div'); row.className = horizontal ? 'sched-cell sched-cell-h' : 'sched-cell';

      var sel = document.createElement('select');
      var opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = placeholderLabel;
      sel.appendChild(opt0);
      state.teachers.forEach(function (t) {
        var o = document.createElement('option'); o.value = t.id; o.textContent = t.name;
        if (a.teacherId === t.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        state.assignments[monitorKey] = { teacherId: sel.value || null, locked: a.locked || false };
        saveState(); renderAll();
      };
      row.appendChild(sel);

      var lockLab = document.createElement('label'); lockLab.className = 'inl'; lockLab.style.fontSize = '11px';
      var lockCb = document.createElement('input'); lockCb.type = 'checkbox'; lockCb.checked = !!a.locked;
      lockCb.onchange = function () {
        var cur = state.assignments[monitorKey] || { teacherId: null, locked: false };
        if (lockCb.checked && !cur.teacherId) {
          toast('先に教員を選んでから確定してください');
          lockCb.checked = false; return;
        }
        cur.locked = lockCb.checked;
        state.assignments[monitorKey] = cur;
        saveState(); renderAll();
      };
      lockLab.appendChild(lockCb); lockLab.appendChild(document.createTextNode('確定(固定)'));
      row.appendChild(lockLab);

      var curLoc = state.examLocations[monitorKey];
      var locSel = document.createElement('select');
      if (defaultLocationCls) {
        // 自習は基本的に自分のクラスで行うため、場所が未設定なら自クラスを既定値にする。
        var ownOpt = document.createElement('option'); ownOpt.value = defaultLocationCls; ownOpt.textContent = defaultLocationCls + '(自分のクラス)';
        if (!curLoc || curLoc === defaultLocationCls) ownOpt.selected = true;
        locSel.appendChild(ownOpt);
      } else {
        var locOpt0 = document.createElement('option'); locOpt0.value = ''; locOpt0.textContent = '(場所未設定)';
        locSel.appendChild(locOpt0);
      }
      (state.locations || []).forEach(function (loc) {
        var o = document.createElement('option'); o.value = loc; o.textContent = loc;
        if (curLoc === loc) o.selected = true;
        locSel.appendChild(o);
      });
      locSel.onchange = function () {
        if (locSel.value) state.examLocations[monitorKey] = locSel.value; else delete state.examLocations[monitorKey];
        saveState();
      };
      row.appendChild(locSel);

      if (warn) {
        var w = document.createElement('div'); w.className = 'bad'; w.style.fontSize = '11px'; w.textContent = '⚠ ' + warn;
        row.appendChild(w);
      }
      return row;
    }

    var card2 = document.createElement('div'); card2.className = 'card';
    var tbl = document.createElement('table'); tbl.className = 'grid-sched';
    tbl.innerHTML = '<tr><th>日付</th><th>時限</th>' + state.classes.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';

    state.testDays.forEach(function (day) {
      Engine.periodsForDay(state, day.id).forEach(function (period) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + esc(day.date) + '</td><td>' + esc(periodLabel(period)) + '</td>';
        state.classes.forEach(function (cls) {
          var key = Engine.slotKey(day.id, period, cls);
          var td = document.createElement('td');
          var cellDiv = document.createElement('div'); cellDiv.className = 'sched-cell';

          // 教科はプルダウンから選ぶ(その学年の決定済み教科・教科グループ・自習)。候補に無い教科は「その他」で手入力。
          var curSubj = (state.exams[key] && state.exams[key].subject) || '';
          var setSubject = function (v) {
            v = (v || '').trim();
            if (v === curSubj) return;
            if (v) state.exams[key] = { subject: v }; else delete state.exams[key];
            // 科目が変わったら確定状態を解除し、割り当てを見直す
            delete state.assignments[key];
            saveState(); renderAll();
          };
          var subjSel = document.createElement('select');
          subjSel.className = 'subj-select';
          var addOpt = function (value, label) {
            var o = document.createElement('option'); o.value = value; o.textContent = label;
            if (value === curSubj) o.selected = true;
            subjSel.appendChild(o);
          };
          addOpt('', '(自習)');
          var cands = scheduleOptionsFor(cls).slice();
          if (curSubj && cands.indexOf(curSubj) === -1) cands.unshift(curSubj);
          var placedAt = placedSubjectsByClass[cls] || {};
          cands.forEach(function (s) {
            var where = (s !== curSubj && placedAt[s]) ? ' (' + placedAt[s].join('・') + 'に配置済)' : '';
            addOpt(s, s + where);
          });
          addOpt('__other__', 'その他(手入力)…');
          subjSel.onchange = function () {
            if (subjSel.value !== '__other__') { setSubject(subjSel.value); return; }
            var inp = document.createElement('input');
            inp.placeholder = '教科名を入力して Enter';
            inp.value = curSubj;
            inp.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); setSubject(inp.value); } if (ev.key === 'Escape') renderAll(); };
            inp.onblur = function () { if (inp.value.trim() && inp.value.trim() !== curSubj) setSubject(inp.value); else renderAll(); };
            subjSel.parentNode.replaceChild(inp, subjSel);
            inp.focus();
          };
          // 教科だけの固定。固定中はプルダウンを変更不可にし、「AIで計算」の調整や「時間割をクリアして組み直す」でも動かさない。
          var subjLocked = !!(state.exams[key] && state.exams[key].locked);
          var subjLine = document.createElement('div'); subjLine.className = 'subj-line';
          subjSel.disabled = subjLocked;
          subjLine.appendChild(subjSel);
          if (curSubj) {
            var sl = document.createElement('label'); sl.className = 'inl subj-lock' + (subjLocked ? ' on' : '');
            sl.title = '教科を固定(自動調整や組み直しで変わらないようにする)';
            var scb = document.createElement('input'); scb.type = 'checkbox'; scb.checked = subjLocked;
            scb.onchange = function () {
              var ex = state.exams[key];
              if (!ex) return;
              if (scb.checked) ex.locked = true; else delete ex.locked;
              saveState(); renderAll();
            };
            sl.appendChild(scb); sl.appendChild(document.createTextNode('教科固定'));
            subjLine.appendChild(sl);
          }
          cellDiv.appendChild(subjLine);

          var e = state.exams[key];
          var hasSubject = !!(e && e.subject);
          var group = hasSubject ? Engine.groupLookup(state)[Engine.groupKey(Engine.gradeOf(cls), e.subject)] : null;
          td.className = hasSubject ? '' : 'gray';

          if (group && group.inClass) {
            // 各クラスで実施する教科グループは、通常の教科と同じくこのクラスのマス目で監督を割り当てる。
            var icDiv = document.createElement('div'); icDiv.className = 'mut'; icDiv.style.fontSize = '11px';
            icDiv.textContent = '(各クラスで実施: ' + group.subjects.join('・') + ')';
            cellDiv.appendChild(icDiv);
            if (warnMap[key]) td.className = 'warnc';
            cellDiv.appendChild(buildMonitorRow(key, '(未割当)', false, cls));
          } else if (group) {
            // 教科グループ(選択科目)は学年の複数クラスが同じ場所に集まって受けるため、監督はこのクラス単位の
            // マス目ではなく、下の「教科グループの監督割り当て」で学年・グループ・教科(場所)ごとに設定する。
            var noteDiv = document.createElement('div'); noteDiv.className = 'mut'; noteDiv.style.fontSize = '11px';
            noteDiv.textContent = '(監督は下の「教科グループの監督割り当て」で設定)';
            cellDiv.appendChild(noteDiv);
          } else {
            if (warnMap[key]) td.className = 'warnc';
            cellDiv.appendChild(buildMonitorRow(key, hasSubject ? '(未割当)' : '(見守り未割当)', false, cls));
          }

          td.appendChild(cellDiv);
          tr.appendChild(td);
        });
        tbl.appendChild(tr);
      });
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card2.appendChild(wrap);
    view.appendChild(card2);

    // 教科グループ(選択科目)の監督は、クラスごとではなく学年+グループ+教科(場所)ごとに1人ずつ割り当てる。
    var groupSlots = monitorSlots.filter(function (s) { return s.groupMember || s.groupSelfStudy; });
    groupSlots.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.period !== b.period) return a.period - b.period;
      if (a.grade !== b.grade) return a.grade < b.grade ? -1 : 1;
      if (a.groupName !== b.groupName) return a.groupName < b.groupName ? -1 : 1;
      return 0;
    });
    if (groupSlots.length) {
      var card2g = document.createElement('div'); card2g.className = 'card';
      card2g.innerHTML = '<h2>教科グループの監督割り当て(場所ごと)</h2>' +
        '<p class="mut">教科グループ(選択科目)は同じ学年の複数クラスの生徒が同じ場所に集まって受けるため、監督はクラスごとではなく、学年・グループ・教科(または自習)ごとに1人だけ割り当てます。「試験教科決定」でチェックを外した教科は、まとめて1つの自習枠になります。</p>';
      var tblG = document.createElement('table'); tblG.className = 'grid-sched';
      tblG.innerHTML = '<tr><th>日付</th><th>時限</th><th>学年</th><th>グループ</th><th>対象</th><th>監督</th></tr>';
      groupSlots.forEach(function (s) {
        var tr = document.createElement('tr');
        var label = s.groupSelfStudy ? ('自習(' + s.member.subject + ')') : s.member.subject;
        tr.innerHTML = '<td>' + esc(s.date) + '</td><td>' + esc(periodLabel(s.period)) + '</td><td>' + esc(s.grade) + '年</td>' +
          '<td>' + esc(s.groupName) + '</td><td>' + esc(label) + '</td>';
        var tdG = document.createElement('td');
        if (warnMap[s.key]) tdG.className = 'warnc';
        tdG.appendChild(buildMonitorRow(s.key, s.groupSelfStudy ? '(見守り未割当)' : '(未割当)', true));
        tr.appendChild(tdG);
        tblG.appendChild(tr);
      });
      var wrapG = document.createElement('div'); wrapG.className = 'scroll'; wrapG.appendChild(tblG);
      card2g.appendChild(wrapG);
      view.appendChild(card2g);
    }

    if (state.reserveCount > 0) {
      var card2b = document.createElement('div'); card2b.className = 'card';
      card2b.innerHTML = '<h2>予備(バックアップ)監督</h2><p class="mut">特定のクラスに紐づかない予備監督です(人数は「日程・時限」タブで変更できます)。</p>';
      var tblR = document.createElement('table'); tblR.className = 'grid-sched';
      var reserveCols = [];
      for (var ri = 1; ri <= state.reserveCount; ri++) reserveCols.push('__reserve' + ri);
      tblR.innerHTML = '<tr><th>日付</th><th>時限</th>' + reserveCols.map(function (_, i) { return '<th>予備' + (i + 1) + '</th>'; }).join('') + '</tr>';
      state.testDays.forEach(function (day) {
        Engine.periodsForDay(state, day.id).forEach(function (period) {
          var hasAnyExam = state.classes.some(function (cls) { return Engine.hasExam(state, day.id, period, cls); });
          if (!hasAnyExam) return;
          var tr = document.createElement('tr');
          tr.innerHTML = '<td>' + esc(day.date) + '</td><td>' + esc(periodLabel(period)) + '</td>';
          reserveCols.forEach(function (rcls) {
            var key = Engine.slotKey(day.id, period, rcls);
            var td = document.createElement('td');
            var cellDiv = document.createElement('div'); cellDiv.className = 'sched-cell';
            var a = state.assignments[key] || {};
            var warn = warnMap[key];
            if (warn) td.className = 'warnc';
            var sel = document.createElement('select');
            var opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = '(未割当)';
            sel.appendChild(opt0);
            state.teachers.forEach(function (t) {
              var o = document.createElement('option'); o.value = t.id; o.textContent = t.name;
              if (a.teacherId === t.id) o.selected = true;
              sel.appendChild(o);
            });
            sel.onchange = function () {
              state.assignments[key] = { teacherId: sel.value || null, locked: a.locked || false };
              saveState(); renderAll();
            };
            cellDiv.appendChild(sel);
            var lockLab = document.createElement('label'); lockLab.className = 'inl'; lockLab.style.fontSize = '11px';
            var lockCb = document.createElement('input'); lockCb.type = 'checkbox'; lockCb.checked = !!a.locked;
            lockCb.onchange = function () {
              var cur = state.assignments[key] || { teacherId: null, locked: false };
              if (lockCb.checked && !cur.teacherId) { toast('先に教員を選んでから確定してください'); lockCb.checked = false; return; }
              cur.locked = lockCb.checked;
              state.assignments[key] = cur;
              saveState(); renderAll();
            };
            lockLab.appendChild(lockCb); lockLab.appendChild(document.createTextNode('確定(固定)'));
            cellDiv.appendChild(lockLab);
            if (warn) {
              var w2 = document.createElement('div'); w2.className = 'bad'; w2.style.fontSize = '11px'; w2.textContent = '⚠ ' + warn;
              cellDiv.appendChild(w2);
            }
            td.appendChild(cellDiv);
            tr.appendChild(td);
          });
          tblR.appendChild(tr);
        });
      });
      var wrapR = document.createElement('div'); wrapR.className = 'scroll'; wrapR.appendChild(tblR);
      card2b.appendChild(wrapR);
      view.appendChild(card2b);
    }

    // バランス表示
    var fakeResult = { assignments: state.assignments };
    var stats = Engine.buildStats(state, fakeResult);
    var card3 = document.createElement('div'); card3.className = 'card';
    card3.innerHTML = '<h2>教員ごとの監督回数</h2><p class="mut">予備以外の回数で平等になるように割り当てます(予備は別枠で集計・表示)。</p>';
    var maxN = 1;
    state.teachers.forEach(function (t) { maxN = Math.max(maxN, (stats[t.id] && stats[t.id].nonReserveTotal) || 0); });
    state.teachers.forEach(function (t) {
      var n = (stats[t.id] && stats[t.id].nonReserveTotal) || 0;
      var bySubj = (stats[t.id] && stats[t.id].bySubject) || {};
      var subjStr = Object.keys(bySubj).map(function (s) { return s + '×' + bySubj[s]; }).join(' / ');
      var row = document.createElement('div'); row.className = 'bal';
      row.innerHTML = '<span class="name">' + esc(t.name) + (t.noCover ? '(対象外)' : '') + (t.reserveOnly ? '(予備のみ)' : '') + (t.maxCount != null ? '(上限' + t.maxCount + ')' : '') + '</span>' +
        '<span class="bar" style="width:' + (120 * n / maxN) + 'px"></span><span class="n">' + n + '</span>' +
        '<span class="mut" style="font-size:11px">' + esc(subjStr) + '</span>';
      card3.appendChild(row);
    });
    view.appendChild(card3);
  }

  // ---- 自習バランス ----
  function renderSelfStudy(view) {
    if (!state.testDays.length) {
      view.innerHTML = '<div class="card"><p class="mut">先に試験時間割を入力してください。</p></div>';
      return;
    }
    var analysis = Engine.analyzeSelfStudy(state);
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>学年ごとの自習コマ・時限バランス</h2><p class="mut">各学年で試験が入っていない時限が自習になります。1校時と2校時の回数差が大きい場合は時間割の調整をおすすめします。</p>';
    var tbl = document.createElement('table');
    tbl.innerHTML = '<tr><th>学年</th>' + state.periods.map(function (p) { return '<th>' + esc(periodLabel(p)) + '</th>'; }).join('') + '<th>差</th></tr>';
    Object.keys(analysis).sort().forEach(function (g) {
      var info = analysis[g];
      var tr = document.createElement('tr');
      var cells = state.periods.map(function (p) { return '<td>' + (info.counts[p] || 0) + '</td>'; }).join('');
      var diffCls = info.imbalance > 1 ? 'warnc' : '';
      tr.innerHTML = '<td>' + esc(g) + '年</td>' + cells + '<td class="' + diffCls + '">' + info.imbalance + '</td>';
      tbl.appendChild(tr);
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card.appendChild(wrap);
    view.appendChild(card);

    var card2 = document.createElement('div'); card2.className = 'card';
    card2.innerHTML = '<h2>自習コマ一覧</h2>';
    Object.keys(analysis).sort().forEach(function (g) {
      var info = analysis[g];
      var h = document.createElement('h3'); h.textContent = g + '年';
      card2.appendChild(h);
      if (!info.slots.length) {
        var p = document.createElement('p'); p.className = 'mut'; p.textContent = '自習コマなし';
        card2.appendChild(p);
      } else {
        info.slots.forEach(function (s) {
          var chip = document.createElement('span'); chip.className = 'chip g';
          chip.textContent = s.date + '(' + weekdayLabel(s.date) + ') ' + periodLabel(s.period);
          card2.appendChild(chip);
        });
      }
    });
    view.appendChild(card2);
  }

  // ---- 案の保存・切り替え ----
  // 試験時間割(exams)・監督割り当て(assignments)・場所(examLocations)を「案」として名前を付けて保存し、
  // 別の案を作りながら、あとで開き直したり最終的に決定したりできるようにする。state.plans に保存される。
  var planConfirm = null; // {id, action} 2回押しの確認待ち
  function planSnapshot() {
    return {
      exams: JSON.parse(JSON.stringify(state.exams || {})),
      assignments: JSON.parse(JSON.stringify(state.assignments || {})),
      examLocations: JSON.parse(JSON.stringify(state.examLocations || {}))
    };
  }
  function sameSnapshot(a, b) {
    return JSON.stringify(a.exams) === JSON.stringify(b.exams) &&
      JSON.stringify(a.assignments) === JSON.stringify(b.assignments) &&
      JSON.stringify(a.examLocations) === JSON.stringify(b.examLocations);
  }
  // 今の内容と案の違い(教科が違うコマ数・監督が違うコマ数)
  function planDiff(p) {
    var cur = planSnapshot();
    var exKeys = {}, asKeys = {};
    Object.keys(cur.exams).concat(Object.keys(p.exams || {})).forEach(function (k) { exKeys[k] = true; });
    Object.keys(cur.assignments).concat(Object.keys(p.assignments || {})).forEach(function (k) { asKeys[k] = true; });
    var subj = 0, proc = 0;
    Object.keys(exKeys).forEach(function (k) {
      var a = (cur.exams[k] && cur.exams[k].subject) || '', b = (p.exams[k] && p.exams[k].subject) || '';
      if (a !== b) subj++;
    });
    Object.keys(asKeys).forEach(function (k) {
      var a = (cur.assignments[k] && cur.assignments[k].teacherId) || '', b = (p.assignments[k] && p.assignments[k].teacherId) || '';
      if (a !== b) proc++;
    });
    return { subj: subj, proc: proc };
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function renderPlans(view) {
    if (!Array.isArray(state.plans)) state.plans = [];
    var plans = state.plans;
    var card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<h2>案の保存・切り替え</h2>' +
      '<p class="mut">今の試験時間割と監督割り当てを「案」として保存しておけます。保存したあとも自由に作り直せて、' +
      '「開く」で保存した案に戻せます。いくつか案を作って比べ、最後に「この案に決定」を押すと、その案が今の内容になり「決定」の印が付きます。</p>';

    var cur = planSnapshot();
    var matching = plans.filter(function (p) { return sameSnapshot(p, cur); })[0];
    var status = document.createElement('div'); status.className = 'mut'; status.style.marginBottom = '6px';
    status.innerHTML = '今の内容: ' + (matching ? '<b>' + esc(matching.name) + '</b>と同じ' + (state.finalPlanId === matching.id ? ' <span class="chip" style="background:var(--ok);color:#fff">決定</span>' : '') : '<span class="warn">どの案にも保存されていません</span>');
    card.appendChild(status);

    var saveRow = document.createElement('div'); saveRow.className = 'row';
    var nameInp = document.createElement('input'); nameInp.placeholder = '案の名前(例: 案A)';
    nameInp.value = '案' + String.fromCharCode(65 + Math.min(plans.length, 25));
    var saveBtn = document.createElement('button'); saveBtn.className = 'b'; saveBtn.textContent = '今の内容を新しい案として保存';
    saveBtn.onclick = function () {
      var name = nameInp.value.trim() || ('案' + (plans.length + 1));
      var snap = planSnapshot();
      plans.push({ id: uid('plan'), name: name, savedAt: Date.now(), exams: snap.exams, assignments: snap.assignments, examLocations: snap.examLocations });
      planConfirm = null;
      saveState(); toast('「' + name + '」として保存しました'); renderAll();
    };
    saveRow.appendChild(nameInp); saveRow.appendChild(saveBtn);
    card.appendChild(saveRow);

    if (plans.length) {
      var tbl = document.createElement('table');
      tbl.innerHTML = '<tr><th>案</th><th>保存日時</th><th>今の内容との違い</th><th>操作</th></tr>';
      plans.forEach(function (p) {
        var tr = document.createElement('tr');
        var d = planDiff(p);
        var diffText = (d.subj || d.proc) ? ('教科 ' + d.subj + 'コマ・監督 ' + d.proc + 'コマ') : '同じ';
        var isFinal = state.finalPlanId === p.id;
        tr.innerHTML = '<td><b>' + esc(p.name) + '</b>' + (isFinal ? ' <span class="chip" style="background:var(--ok);color:#fff">決定</span>' : '') + '</td>' +
          '<td>' + esc(fmtTime(p.savedAt)) + '</td><td>' + esc(diffText) + '</td>';
        var tdOps = document.createElement('td');
        var ops = document.createElement('div'); ops.className = 'row'; ops.style.margin = '0';
        function opBtn(action, label, confirmLabel, cls, fn) {
          var pending = planConfirm && planConfirm.id === p.id && planConfirm.action === action;
          var b = document.createElement('button');
          b.className = pending ? 'b del' : ('b sm ' + (cls || 'sec'));
          b.textContent = pending ? confirmLabel : label;
          b.onclick = function () {
            if (confirmLabel && !pending) { planConfirm = { id: p.id, action: action }; renderAll(); return; }
            planConfirm = null; fn();
          };
          ops.appendChild(b);
        }
        var unsaved = !matching;
        opBtn('open', '開く', unsaved ? '今の内容は未保存です。それでも開く' : null, 'sec', function () {
          state.exams = JSON.parse(JSON.stringify(p.exams || {}));
          state.assignments = JSON.parse(JSON.stringify(p.assignments || {}));
          state.examLocations = JSON.parse(JSON.stringify(p.examLocations || {}));
          saveState(); toast('「' + p.name + '」を開きました'); renderAll();
        });
        opBtn('final', isFinal ? '決定済み' : 'この案に決定', 'もう一度押すと決定(今の内容がこの案になります)', '', function () {
          state.exams = JSON.parse(JSON.stringify(p.exams || {}));
          state.assignments = JSON.parse(JSON.stringify(p.assignments || {}));
          state.examLocations = JSON.parse(JSON.stringify(p.examLocations || {}));
          state.finalPlanId = p.id;
          saveState(); toast('「' + p.name + '」に決定しました'); renderAll();
        });
        opBtn('overwrite', '今の内容で上書き', 'もう一度押すと上書き', 'sec', function () {
          var snap = planSnapshot();
          p.exams = snap.exams; p.assignments = snap.assignments; p.examLocations = snap.examLocations; p.savedAt = Date.now();
          saveState(); toast('「' + p.name + '」を上書きしました'); renderAll();
        });
        opBtn('rename', '名前変更', null, 'sec', function () {
          var cell = tr.firstChild;
          var inp = document.createElement('input'); inp.value = p.name; inp.style.width = '120px';
          var commit = function () { var v = inp.value.trim(); if (v) p.name = v; saveState(); renderAll(); };
          inp.onkeydown = function (ev) { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') renderAll(); };
          inp.onblur = commit;
          cell.innerHTML = ''; cell.appendChild(inp); inp.focus(); inp.select();
        });
        opBtn('delete', '削除', 'もう一度押すと削除', 'del', function () {
          state.plans = state.plans.filter(function (x) { return x.id !== p.id; });
          if (state.finalPlanId === p.id) delete state.finalPlanId;
          saveState(); toast('「' + p.name + '」を削除しました'); renderAll();
        });
        tdOps.appendChild(ops);
        tr.appendChild(tdOps);
        tbl.appendChild(tr);
      });
      var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.style.marginTop = '8px'; wrap.appendChild(tbl);
      card.appendChild(wrap);
    }
    view.appendChild(card);
  }

  // ---- 教員別一覧 ----
  // その教員・日付・時限に登録されている出張・欠勤・空きの種別(複数あれば「・」でつなぐ)。無ければ空文字。
  function absenceTypeAt(teacherId, dateStr, period) {
    var types = [];
    (state.absences || []).forEach(function (a) {
      if (a.teacherId !== teacherId || dateStr < a.start || dateStr > a.end) return;
      if (a.periods !== 'all' && a.periods && a.periods.indexOf(period) === -1) return;
      var t = a.type || '出張';
      if (types.indexOf(t) === -1) types.push(t);
    });
    return types.join('・');
  }

  function renderTeacherView(view) {
    if (!state.testDays.length) {
      view.innerHTML = '<div class="card"><p class="mut">先に試験時間割を入力してください。</p></div>';
      return;
    }
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h2>教員別一覧</h2>' +
      '<p class="mut">教員ごとに、どのコマでどのクラス(または予備)の監督に入るかを一覧表示します。「出:2-1」のように、' +
      'その教員がそのコマの出題者になっているクラスも合わせて表示します(教科グループは学年単位のため「出:2年」のように学年で表示します)。' +
      '「試験時間割・監督割り当て」タブで入力・再計算した内容がそのまま反映されます(ここでは編集できません)。' +
      '表の上段に、同じ日付×時限の列でクラスごとの試験教科(テスト日程)も表示するので、見比べながら確認できます。' +
      '「出張・欠勤」タブで登録した時限は<span class="abs-legend">斜線</span>で表示します(出張・欠勤・空きの種別も表示)。</p>';
    view.appendChild(card);

    var grid = Engine.teacherGrid(state, { assignments: state.assignments });
    if (!grid.columns.length) {
      var p = document.createElement('p'); p.className = 'mut'; p.textContent = 'まだ時限が設定されていません。';
      card.appendChild(p);
      return;
    }

    // 印刷(A4): この下の表(card2)だけを印刷する。用紙の向きと「1枚に収める」を選べる。
    var printBar = document.createElement('div');
    printBar.className = 'row';
    printBar.innerHTML =
      '<label>用紙の向き(A4)<select id="tvOrient"><option value="landscape">横</option><option value="portrait">縦</option></select></label>' +
      '<label class="inl"><input type="checkbox" id="tvFitPage"> 1枚に収める(縦方向も縮小)</label>' +
      '<button class="b" id="tvPrintBtn">この一覧をA4で印刷</button>';
    card.appendChild(printBar);
    var tvPrefs = {};
    try { tvPrefs = JSON.parse(localStorage.getItem('tvPrintPrefs') || '{}'); } catch (e) { tvPrefs = {}; }
    if (tvPrefs.orient) printBar.querySelector('#tvOrient').value = tvPrefs.orient;
    if (tvPrefs.fit) printBar.querySelector('#tvFitPage').checked = true;

    var card2 = document.createElement('div'); card2.className = 'card print-area';
    var printTitle = document.createElement('div');
    printTitle.className = 'print-title';
    var dates = grid.columns.map(function (c) { return c.date; }).sort();
    printTitle.textContent = '定期テスト監督割り当て 教員別一覧(' + monthDayLabel(dates[0]) + '〜' + monthDayLabel(dates[dates.length - 1]) + ')';
    card2.appendChild(printTitle);
    var tbl = document.createElement('table');
    var totalCols = 2 + grid.columns.length + 1;
    var head = '<thead><tr><th>教科</th><th>氏名</th>' +
      grid.columns.map(function (col) { return '<th>' + esc(monthDayLabel(col.date)) + '<br>' + col.period + '校時</th>'; }).join('') +
      '<th>回数<br>(予備以外(予備含む))</th></tr></thead>';
    tbl.innerHTML = head;

    printBar.querySelector('#tvPrintBtn').onclick = function () {
      var orient = printBar.querySelector('#tvOrient').value;
      var fit = printBar.querySelector('#tvFitPage').checked;
      try { localStorage.setItem('tvPrintPrefs', JSON.stringify({ orient: orient, fit: fit })); } catch (e) { /* 無視 */ }
      // 印刷可能範囲(A4・余白8mm、96dpi換算)。タイトル分を高さから引く。
      var mm = 96 / 25.4;
      var pageW = (orient === 'landscape' ? 297 : 210) - 16, pageH = (orient === 'landscape' ? 210 : 297) - 16;
      var availW = pageW * mm, availH = pageH * mm - 34;
      var pageStyle = document.getElementById('tvPageStyle');
      if (!pageStyle) { pageStyle = document.createElement('style'); pageStyle.id = 'tvPageStyle'; document.head.appendChild(pageStyle); }
      pageStyle.textContent = '@page{size:A4 ' + orient + ';margin:8mm}';
      document.body.classList.add('printing');
      tbl.style.zoom = '';
      var w = tbl.scrollWidth, h = tbl.scrollHeight;
      // 横幅に合わせて拡大・縮小(拡大は1.6倍まで)。1ページに収まる表を拡大して2ページにはしない。
      var scale = Math.min(1.6, availW / w);
      if (fit || h <= availH) scale = Math.min(scale, availH / h);
      tbl.style.zoom = String(Math.floor(scale * 1000) / 1000);
      var cleanup = function () {
        document.body.classList.remove('printing');
        tbl.style.zoom = '';
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      setTimeout(function () {
        try { window.print(); } catch (e) { toast('このブラウザでは印刷できませんでした'); cleanup(); }
      }, 50);
    };

    // テスト日程(参考): 教員別一覧と同じ列(日付×時限)で、試験教科を上段にまとめて表示する(空欄=自習)。
    // 同じ学年の全クラスは同じ教科になるので、クラスごとではなく学年ごとに1行で表示する。
    var schedLabelRow = document.createElement('tr');
    schedLabelRow.innerHTML = '<td colspan="' + totalCols + '" style="text-align:left;font-weight:bold;background:var(--bg)">テスト日程(参考・空欄=自習)</td>';
    tbl.appendChild(schedLabelRow);
    var gradeRepCls = {}; var grades = [];
    state.classes.forEach(function (cls) {
      var g = Engine.gradeOf(cls);
      if (!gradeRepCls[g]) { gradeRepCls[g] = cls; grades.push(g); }
    });
    grades.sort().forEach(function (g) {
      var cls = gradeRepCls[g];
      var trS = document.createElement('tr');
      var cellsS = grid.columns.map(function (col) {
        var e = state.exams[Engine.slotKey(col.dayId, col.period, cls)];
        var subj = e && e.subject;
        return '<td class="' + (subj ? '' : 'gray') + '">' + esc(subj || '自習') + '</td>';
      }).join('');
      trS.innerHTML = '<td></td><td>' + esc(g) + '年</td>' + cellsS + '<td></td>';
      tbl.appendChild(trS);
    });

    var teacherLabelRow = document.createElement('tr');
    teacherLabelRow.innerHTML = '<td colspan="' + totalCols + '" style="text-align:left;font-weight:bold;background:var(--bg)">教員別一覧</td>';
    tbl.appendChild(teacherLabelRow);

    var lastDept = null;
    grid.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      var deptCell = (row.dept !== lastDept) ? esc(row.dept) : '';
      lastDept = row.dept;
      var cells = row.cells.map(function (c, ci) {
        var parts = [];
        if (c.proctor) parts.push(c.proctor);
        if (c.setterClasses.length) parts.push('出:' + c.setterClasses.join(','));
        var cls = c.proctor ? (c.proctor.indexOf('予備') === 0 ? 'gray' : '') : '';
        // 出張・欠勤・空きで登録した時限は斜線模様にし、種別を表示する。
        var col = grid.columns[ci];
        var absType = absenceTypeAt(row.teacherId, col.date, col.period);
        if (absType) {
          cls = 'absent';
          return '<td class="' + cls + '"><span class="abs-tag">' + esc(absType) + '</span>' + (parts.length ? ' ' + esc(parts.join(' / ')) : '') + '</td>';
        }
        return '<td class="' + cls + '">' + esc(parts.join(' / ')) + '</td>';
      }).join('');
      tr.innerHTML = '<td>' + deptCell + '</td><td>' + esc(row.name) + (row.noCover ? '<span class="mut">(対象外)</span>' : '') + (row.reserveOnly ? '<span class="mut">(予備のみ)</span>' : '') + (row.maxCount != null ? '<span class="mut">(上限' + row.maxCount + ')</span>' : '') + '</td>' +
        cells + '<td><b>' + row.nonReserveTotal + '</b>(' + row.total + ')</td>';
      tbl.appendChild(tr);
    });
    var wrap = document.createElement('div'); wrap.className = 'scroll'; wrap.appendChild(tbl);
    card2.appendChild(wrap);
    view.appendChild(card2);
  }

  renderAll();
  initCloudSync();
})();
