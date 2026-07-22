
/* ---------- FIREBASE CONFIG ---------- */
/* ---------- UI Notification Helper ---------- */
function showNotification(message, type = "success") {
  let note = document.createElement("div");
  note.className = `notif ${type}`;
  note.textContent = message;
  document.body.appendChild(note);

  // fade in
  setTimeout(() => note.classList.add("visible"), 50);

  // fade out and remove
  setTimeout(() => {
    note.classList.remove("visible");
    setTimeout(() => note.remove(), 400);
  }, 3000);
}

/* Notification CSS (inject automatically) */
const notifStyle = document.createElement("style");
notifStyle.textContent = `
.notif {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%) translateY(100px);
  background: linear-gradient(90deg, #ff6b4a, #ffc857);
  color: #050c14;
  font-weight: 600;
  padding: 14px 28px;
  border-radius: 10px;
  box-shadow: 0 0 15px rgba(255,255,255,0.2);
  opacity: 0;
  transition: all 0.4s ease;
  z-index: 9999;
}
.notif.visible {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
.notif.error {
  background: linear-gradient(90deg, #ff3b3b, #ff6b4a);
}
`;
document.head.appendChild(notifStyle);

const firebaseConfig = {
  apiKey: "AIzaSyCqTXKToAUzVIfapWLFa9v9t8VsokQE_1A",
  authDomain: "projectfinal-f6f1a.firebaseapp.com",
  projectId: "projectfinal-f6f1a",
  storageBucket: "projectfinal-f6f1a.appspot.com",
  messagingSenderId: "983765421377",
  appId: "1:983765421377:web:db5f9ad41b40c760d525c0"
};
if (!window.firebase) throw new Error("Firebase SDK missing — include firebase-app-compat, firebase-auth-compat and firebase-firestore-compat in HTML.");
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* ---------- DOM helpers ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const exists = sel => !!document.querySelector(sel);
const toISO = d => (new Date(d)).toISOString().slice(0,10);

/* ---------- App state ---------- */
let EXERCISES = [];         // {name, muscle, met}
let MET_MAP = {};           // name(lower) -> met
const DEFAULT_MET = 6;
let runPoints = [], runMap = null, runPoly = null;
let progressChart = null, weightChart = null, stepsChart = null, muscleChart = null;

/* ---------- Auth guard ---------- */
if (exists('.dashboard-body')) {
  auth.onAuthStateChanged(async user => {
    if (!user) { window.location.href = 'login.html'; return; }
    try {
      await initDashboard(user);
    } catch (e) {
      console.error('initDashboard failed', e);
      showNotification('Initialization error — check console');
    }
  });
}

/* ========== INIT DASHBOARD ========== */
async function initDashboard(user) {
  $('#userMenu').textContent = user.displayName || user.email || 'My Account';

  // Load exercise dataset (xlsx preferred, fallback CSV or fallback list)
  await loadExerciseDataset();

  // Populate select (must be before user tries to save)
  populateExerciseSelect();

  // Wire nav buttons (ensures analysis runs on tab switch)
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchPage(btn, user);
    });
  });

  // Wire logout
  $('#logout')?.addEventListener('click', async () => { await auth.signOut(); window.location.href = 'login.html'; });

  // Quick controls top
  $('#addQuickWeight')?.addEventListener('click', async () => {
    const v = parseFloat($('#quickWeight').value);
    if (!v || v <= 0) return showNotification('Enter a valid weight');
    const uid = auth.currentUser.uid;
    await db.collection('users').doc(uid).set({ weight: v }, { merge:true });
    await db.collection('users').doc(uid).collection('weights').add({ weight: v, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
    $('#quickWeight').value = '';
    await loadProfile(uid);
    await refreshProgress(uid);
  });
  $('#addQuickSteps')?.addEventListener('click', async () => {
    const v = parseInt($('#quickSteps')?.value || 0);
    if (!v) return showNotification('Enter valid steps');
    const uid = auth.currentUser.uid;
    const date = toISO(new Date());
    await db.collection('users').doc(uid).collection('steps').doc(date).set({ date, steps: v, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
    $('#quickSteps').value = '';
    await refreshStepsChart(uid);
  });

  // Form submit (save session)
  $('#workoutForm')?.addEventListener('submit', async e => { e.preventDefault(); await handleSaveSession(); });

  // Clear selection
  $('#clearSelection')?.addEventListener('click', () => {
    $('#selectedExercise').value = '';
    $('#sets').value = '';
    $('#reps').value = '';
    $('#duration').value = '';
  });

  // Profile save
  $('#saveProfile')?.addEventListener('click', async () => {
    const uid = auth.currentUser.uid;
    const name = ($('#profName').value || '').trim();
    const weight = +$('#profWeight').value || null;
    const height = +$('#profHeight').value || null;
    const weekly = +$('#weeklyTarget').value || 0;
    await db.collection('users').doc(uid).set({ name, weight, height, weeklyTarget: weekly, email: auth.currentUser.email }, { merge:true });
    if (weight) await db.collection('users').doc(uid).collection('weights').add({ weight, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
    showNotification('Profile saved');
    await loadProfile(uid);
    await refreshProgress(uid);
    await loadAchievements(uid);
  });

  // Save target
  $('#saveTarget')?.addEventListener('click', async () => {
    const uid = auth.currentUser.uid;
    const type = $('#targetType').value;
    const value = +$('#targetValue').value;
    const unit = $('#targetUnit').value;
    if (!type || !value) return showNotification('Fill target fields');
    await db.collection('users').doc(uid).collection('targets').doc(type).set({ type, value, unit, achieved:false });
    showNotification('Target saved');
    await loadTargets(uid);
    await loadAchievements(uid);
  });

  // Initialize run controls AFTER page loaded
  setupRunControls(auth.currentUser);

  // Initial data loads
  await loadProfile(auth.currentUser.uid);
  await loadRecentWorkouts(auth.currentUser.uid);
  await refreshProgress(auth.currentUser.uid);
  await loadTargets(auth.currentUser.uid);
  await loadAchievements(auth.currentUser.uid);
}

/* ========== Page switching ========== */
function switchPage(btn, user) {
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $$('.page').forEach(p => p.classList.remove('visible'));
  const page = btn.dataset.page;
  document.getElementById(page).classList.add('visible');

  // Ensure map initializes when workouts page is shown
  if (page === 'workouts') {
    setTimeout(()=> { try { setupRunControls(user); } catch(e){/*ignore*/} }, 200);
    loadRecentWorkouts(user.uid);
  }
  if (page === 'progress') refreshProgress(user.uid);
  if (page === 'analysis') buildAnalysis(user.uid);
  if (page === 'account') loadProfile(user.uid);
}

/* ========== Exercise dataset loader ========== */
/* Tries XLSX via SheetJS (XLSX), else fallback to CSV or fallback list */
async function loadExerciseDataset(){
  EXERCISES = [];
  MET_MAP = {};
  // 1) try .xlsx if XLSX lib present and file exists
  try {
    if (window.XLSX) {
      // attempt to fetch workbook file (the filename may be changed; user uploaded Gym Exercises Dataset.xlsx earlier)
      const urls = ['data/Gym Exercises Dataset.xlsx', 'data/gym_exercise_data.xlsx'];
      let buf = null, usedUrl = null;
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          buf = await r.arrayBuffer();
          usedUrl = u; break;
        } catch(e){ continue; }
      }
      if (buf) {
        const wb = XLSX.read(buf, { type:'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if (rows && rows.length) {
          rows.forEach((r, i) => {
            // try common column names
            const name = r.Exercise || r.Name || r['Exercise Name'] || r['Exercise_Name'] || r.exercise || Object.values(r)[0] || `Exercise ${i+1}`;
            const muscle = r.Muscle || r.Group || r['Muscle Group'] || r.muscle_gp || r.muscle || 'general';
            const met = parseFloat(r.MET || r.met) || DEFAULT_MET;
            EXERCISES.push({ name: String(name), muscle: String(muscle).toLowerCase(), met });
            MET_MAP[String(name).toLowerCase()] = met;
          });
          console.log('Loaded XLSX exercises:', EXERCISES.length);
          return;
        }
      }
    }
  } catch (e) {
    console.warn('XLSX load failed:', e);
  }

  // 2) try CSV fallback
  try {
    const r = await fetch('data/gym_exercise_data.csv');
    if (r.ok) {
      const txt = await r.text();
      const lines = txt.trim().split(/\r?\n/).filter(l=>l.trim());
      if (lines.length>1) {
        const headers = lines[0].split(',').map(h=>h.toLowerCase());
        const idxName = headers.findIndex(h=>/exercise|name|title/.test(h));
        const idxMuscle = headers.findIndex(h=>/muscle|body_part|group/.test(h));
        const idxMet = headers.findIndex(h=>/met|intensity|energy/.test(h));
        for (let i=1;i<lines.length;i++){
          const parts = lines[i].split(',');
          const name = (idxName>=0 ? parts[idxName] : parts[0]) || `Exercise ${i}`;
          const muscle = idxMuscle>=0 ? (parts[idxMuscle] || 'general') : 'general';
          const met = idxMet>=0 ? (parseFloat(parts[idxMet]) || DEFAULT_MET) : DEFAULT_MET;
          EXERCISES.push({ name: String(name), muscle: String(muscle).toLowerCase(), met });
          MET_MAP[String(name).toLowerCase()] = met;
        }
        console.log('Loaded CSV exercises:', EXERCISES.length);
        return;
      }
    }
  } catch (e) {
    console.warn('CSV load failed', e);
  }

  // 3) fallback static list (guarantee)
  const fallback = [
    { name:'Squat', muscle:'legs', met:6 },
    { name:'Bench Press', muscle:'chest', met:5 },
    { name:'Deadlift', muscle:'back', met:7 },
    { name:'Push Up', muscle:'chest', met:4 },
    { name:'Pull Up', muscle:'back', met:6 },
    { name:'Plank', muscle:'core', met:3 },
    { name:'Running', muscle:'cardio', met:8 },
    { name:'Cycling', muscle:'cardio', met:7 }
  ];
  EXERCISES = fallback;
  EXERCISES.forEach(e => MET_MAP[e.name.toLowerCase()] = e.met);
  console.log('Using fallback exercise list');
}

/* ========== populate exercise select ========== */
function populateExerciseSelect(){
  const sel = $('#selectedExercise');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select exercise —</option>';
  EXERCISES.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.name;
    opt.textContent = `${e.name} — ${e.muscle}`;
    sel.appendChild(opt);
  });
}

/* ========== save session ========== */
async function handleSaveSession(){
  const type = $('#selectedExercise')?.value;
  if (!type) return showNotification('Select exercise first');
  const sets = +$('#sets').value || 0;
  const reps = +$('#reps').value || 0;
  const duration = +$('#duration').value || 0;
  let weight = 70;
  try {
    const snap = await db.collection('users').doc(auth.currentUser.uid).get();
    if (snap.exists) weight = snap.data().weight || weight;
  } catch(e){ console.warn('get weight', e); }
  const met = MET_MAP[type.toLowerCase()] || DEFAULT_MET;
  const calories = Math.round(met * weight * (duration/60));
  const muscle = (EXERCISES.find(x=>x.name===type)?.muscle || 'unknown').toLowerCase();
  try {
    await db.collection('sessions').add({
      uid: auth.currentUser.uid,
      type, sets, reps, durationMin: duration, calories, muscle,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    showNotification('Session saved!');
    $('#selectedExercise').value=''; $('#sets').value=''; $('#reps').value=''; $('#duration').value='';
    await loadRecentWorkouts(auth.currentUser.uid);
    await refreshProgress(auth.currentUser.uid);
    await loadAchievements(auth.currentUser.uid);
  } catch (err) { console.error('save session failed', err); showNotification('Save failed — see console'); }
}

/* ========== recent workouts ========== */
async function loadRecentWorkouts(uid){
  const container = $('#workoutsContainer');
  if (!container) return;
  container.innerHTML = 'Loading...';
  try {
    // Try server-side ordering first; if an error occurs fallback to client-side sort
    try {
      const snap = await db.collection('sessions').where('uid','==',uid).orderBy('timestamp','desc').limit(50).get();
      if (snap.empty) { container.innerHTML = '<div class="muted">No sessions yet.</div>'; $('#totalMinutes').textContent = 0; $('#totalSessions').textContent = 0; return; }
      container.innerHTML = '';
      let totalMin = 0;
      snap.forEach(doc => {
        const d = doc.data();
        totalMin += d.durationMin || 0;
        const when = d.timestamp ? d.timestamp.toDate().toLocaleString() : 'Just now';
        container.innerHTML += `<div class="recent-row"><strong>${d.type}</strong><div class="muted">${d.sets||0}x${d.reps||0} • ${d.durationMin||0} min • ${d.calories||0} kcal • ${when}</div></div>`;
      });
      $('#totalMinutes').textContent = totalMin;
      $('#totalSessions').textContent = snap.size;
      return;
    } catch (e) {
      // ordering error or missing index — fallback below
      console.warn('orderBy failed, falling back to client-side sort:', e.message || e);
    }

    // Client-side fallback: fetch and sort locally
    const snap2 = await db.collection('sessions').where('uid','==',uid).get();
    if (snap2.empty) { container.innerHTML = '<div class="muted">No sessions yet.</div>'; $('#totalMinutes').textContent = 0; $('#totalSessions').textContent = 0; return; }
    const docs = snap2.docs.map(d => ({ id:d.id, ...d.data(), timeVal: d.data().timestamp ? d.data().timestamp.toDate().getTime() : 0 }));
    docs.sort((a,b)=>b.timeVal - a.timeVal);
    container.innerHTML = '';
    let totalMin = 0;
    docs.forEach(d => {
      totalMin += d.durationMin || 0;
      const when = d.timestamp ? d.timestamp.toDate().toLocaleString() : 'Just now';
      container.innerHTML += `<div class="recent-row"><strong>${d.type}</strong><div class="muted">${d.sets||0}x${d.reps||0} • ${d.durationMin||0} min • ${d.calories||0} kcal • ${when}</div></div>`;
    });
    $('#totalMinutes').textContent = totalMin;
    $('#totalSessions').textContent = docs.length;
  } catch (err) {
    console.error('loadRecentWorkouts top-level error', err);
    container.innerHTML = '<div class="muted">Error loading workouts.</div>';
  }
}

/* ========== progress & charts ========== */
async function refreshProgress(uid){
  try {
    // Calories per day
    const snap = await db.collection('sessions').where('uid','==',uid).get();
    const byDay = {};
    snap.forEach(d => {
      const x = d.data();
      const key = x.timestamp ? toISO(x.timestamp.toDate()) : toISO(new Date());
      byDay[key] = (byDay[key] || 0) + (x.calories || 0);
    });
    const labels = Object.keys(byDay).sort();
    const vals = labels.map(l => byDay[l]);
    if (progressChart) progressChart.destroy();
    if ($('#progressChart')) {
      progressChart = new Chart($('#progressChart').getContext('2d'), {
        type:'bar',
        data: { labels, datasets: [{ label:'Calories/day', data: vals, backgroundColor: '#ff6b4a' }] },
        options: { responsive:true, scales:{ y:{ beginAtZero:true } } }
      });
    }

    // Weight & Steps charts
    await refreshWeightChart(uid);
    await refreshStepsChart(uid);

  } catch (e) { console.error('refreshProgress', e); }
}

async function refreshWeightChart(uid){
  try {
    const snap = await db.collection('users').doc(uid).collection('weights').orderBy('timestamp').get();
    const labels = [], vals = [];
    snap.forEach(d => { const r = d.data(); labels.push(r.timestamp ? r.timestamp.toDate().toLocaleDateString() : ''); vals.push(r.weight); });
    if (weightChart) weightChart.destroy();
    if ($('#weightChart') && labels.length) {
      weightChart = new Chart($('#weightChart').getContext('2d'), {
        type:'line',
        data: { labels, datasets:[{ label:'Weight (kg)', data: vals, borderColor:'#00d1b2', fill:false }] }
      });
    }
  } catch (e) { console.error('refreshWeightChart', e); }
}

async function refreshStepsChart(uid){
  try {
    const snap = await db.collection('users').doc(uid).collection('steps').orderBy('timestamp').get();
    const labels = [], vals = [];
    snap.forEach(d => { const r = d.data(); labels.push(r.date || (r.timestamp ? r.timestamp.toDate().toLocaleDateString() : '')); vals.push(r.steps || 0); });
    if (stepsChart) stepsChart.destroy();
    if ($('#stepsChart') && labels.length) {
      stepsChart = new Chart($('#stepsChart').getContext('2d'), {
        type:'bar',
        data: { labels, datasets:[{ label:'Steps/day', data: vals, backgroundColor:'#4caf50' }] },
        options: { responsive:true, scales:{ y:{ beginAtZero:true } } }
      });
    }
  } catch (e) { console.error('refreshStepsChart', e); }
}

/* ========== Run / Map ========== */
function setupRunControls(user) {
  const mapEl = $('#mapPreview');
  if (!mapEl) return;

  // Initialize Leaflet map once
  if (!runMap) {
    try {
      runMap = L.map(mapEl).setView([20, 0], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(runMap);
      runPoly = L.polyline([], { color: '#ff6b4a', weight: 4 }).addTo(runMap);
    } catch (e) {
      console.warn('Leaflet init', e);
      return;
    }
  }

  let startTime = null;
  let timerInterval = null;

  $('#startRun')?.addEventListener('click', () => {
    if (!navigator.geolocation) return showNotification('Geolocation not supported');
    runPoints = [];
    if (runPoly) runPoly.setLatLngs([]);

    startTime = Date.now();

    // Start a timer that updates every second
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => updateRunStats(startTime), 1000);

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        runPoints.push({ lat, lng, ts: Date.now() });
        if (runPoly) runPoly.addLatLng([lat, lng]);
        if (runMap && runPoints.length === 1) runMap.setView([lat, lng], 15);
        updateRunStats(startTime);
      },
      (err) => showNotification('GPS error: ' + err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );

    mapEl._watchId = watchId;
    $('#startRun').disabled = true;
  });

  $('#stopRun')?.addEventListener('click', () => {
    const watch = mapEl._watchId;
    if (watch) {
      navigator.geolocation.clearWatch(watch);
      mapEl._watchId = null;
    }
    $('#startRun').disabled = false;

    // Stop timer
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  });

  $('#saveRun')?.addEventListener('click', async () => {
    if (!runPoints || runPoints.length < 2)
      return showNotification('No run recorded');

    // Stop timer before saving
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    const { distance, durationMs } = computeRunStats(runPoints);
    let weight = 70;
    try {
      const s = await db.collection('users').doc(user.uid).get();
      if (s.exists) weight = s.data().weight || weight;
    } catch (e) {}

    const hours = durationMs / (1000 * 60 * 60);
    const MET = 8;
    const calories = Math.round(MET * weight * hours);

    try {
      await db.collection('sessions').add({
        uid: user.uid,
        type: 'Run',
        durationMin: Math.round(durationMs / 60000),
        distanceMeters: Math.round(distance),
        calories,
        muscle: 'cardio',
        points: runPoints,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showNotification(`🏁 Run saved — ${(distance / 1000).toFixed(2)} km, ${calories} kcal burned!`);

      runPoints = [];
      if (runPoly) runPoly.setLatLngs([]);
      $('#startRun').disabled = false;
      $('#runStats').textContent = "Dist: 0.00 km • Dur: 0 min • Cal: 0 kcal • Time: 00:00:00 • Pace: —";

      await loadRecentWorkouts(user.uid);
      await refreshProgress(user.uid);
      await loadAchievements(user.uid);
    } catch (e) {
      console.error('saveRun failed', e);
      showNotification('⚠️ Save run failed', 'error');

    }
  });
}

/* ---------- Compute Distance & Duration ---------- */
function computeRunStats(points) {
  if (!points || points.length < 2) return { distance: 0, durationMs: 0 };
  const R = 6371000;
  const toR = (v) => (v * Math.PI) / 180;
  let dist = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dLat = toR(b.lat - a.lat);
    const dLon = toR(b.lng - a.lng);
    const lat1 = toR(a.lat), lat2 = toR(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    dist += 2 * R * Math.asin(Math.sqrt(h));
  }

  const durationMs = points[points.length - 1].ts - points[0].ts;
  return { distance: Math.round(dist), durationMs };
}

/* ---------- Update Run Stats (Live Timer + Pace + Calories) ---------- */
function updateRunStats(startTime = null) {
  const s = computeRunStats(runPoints);
  const km = (s.distance / 1000).toFixed(2);
  const mins = Math.round(s.durationMs / 60000);
  const cal = Math.round(8 * 70 * (s.durationMs / (1000 * 60 * 60)));

  // 🕒 Real-time clock
  let elapsed = "00:00:00";
  if (startTime) {
    const diff = Date.now() - startTime;
    const sec = Math.floor(diff / 1000) % 60;
    const min = Math.floor(diff / 60000) % 60;
    const hr = Math.floor(diff / 3600000);
    elapsed = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // 🏃‍♂️ Live Pace
  let pace = "—";
  if (s.distance > 0) {
    const paceMinPerKm = (s.durationMs / 60000) / (s.distance / 1000);
    pace = `${paceMinPerKm.toFixed(1)} min/km`;
  }

  $('#runStats').textContent = `Dist: ${km} km • Dur: ${mins} min • Cal: ${cal} kcal • Time: ${elapsed} • Pace: ${pace}`;
}

/* ========== Profile, Targets, Achievements ========== */
/* ========== Profile, Targets, Achievements ========== */
async function loadProfile(uid){
  try {
    const snap = await db.collection('users').doc(uid).get();
    const d = snap.exists ? snap.data() : {};
    $('#profName').value = d.name || '';
    $('#profEmail').value = d.email || auth.currentUser.email;
    $('#profWeight').value = d.weight || '';
    $('#profHeight').value = d.height || '';
    $('#weeklyTarget').value = d.weeklyTarget || '';
  } catch (e) { console.error('loadProfile', e); }
}

/* ---------- TARGETS (Enhanced Gamified Version) ---------- */
/* ---------- TARGETS (Enhanced Animated Gamified Version) ---------- */
/* ---------- TARGETS (Refined, Responsive & Non-Overlapping) ---------- */
/* ---------- TARGETS (Upgraded – Modern Fitness Rings Style) ---------- */
/* ---------- Helper: in-page toast (small floating popup) ---------- */
function ensureToastStyles(){
  if (document.getElementById('slf-toast-styles')) return;
  const s = document.createElement('style');
  s.id = 'slf-toast-styles';
  s.textContent = `
  .slf-toast-wrap { position: fixed; left: 50%; transform: translateX(-50%); bottom: 28px; z-index: 99999; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none; }
  .slf-toast { pointer-events:auto; background: linear-gradient(90deg,#ff6b4a,#ffc247); color:#050c14; padding:10px 14px; border-radius:10px; font-weight:700; box-shadow:0 8px 30px rgba(0,0,0,0.6); min-width:220px; text-align:center; }
  .slf-toast.success { background: linear-gradient(90deg,#00e676,#00bfa5); color:#032; }
  `;
  document.head.appendChild(s);
  const wrap = document.createElement('div');
  wrap.className = 'slf-toast-wrap';
  wrap.id = 'slf-toast-wrap';
  document.body.appendChild(wrap);
}
function showToast(text, type='default', timeout=3600){
  ensureToastStyles();
  const wrap = document.getElementById('slf-toast-wrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'slf-toast' + (type==='success'? ' success' : '');
  t.textContent = text;
  wrap.appendChild(t);
  setTimeout(()=> {
    t.style.transition = 'opacity .45s, transform .45s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(12px)';
    setTimeout(()=> t.remove(), 500);
  }, timeout);
}

/* ---------- TARGETS (Upgraded + Achievement popup detection) ---------- */
/* ---------- TARGETS (Upgraded + Robust: works with either #targetcontainer or #targetContainer) ---------- */
async function loadTargets(uid) {
  // be tolerant of HTML id mismatch: accept either 'targetcontainer' or 'targetContainer'
  const c = $('#targetcontainer') || $('#targetContainer') || $('#targetContainer'.toLowerCase && document.getElementById('targetcontainer')) ;
  if (!c) return;

  try {
    const snap = await db.collection('users').doc(uid).collection('targets').get();
    if (snap.empty) {
      c.innerHTML = '<div class="muted">🎯 No active targets yet — set one to begin your solo leveling journey!</div>';
      return;
    }

    // Gather user data to compute progress
    const sessionsSnap = await db.collection('sessions').where('uid', '==', uid).get();
    let totalCal = 0, totalDist = 0;
    sessionsSnap.forEach(d => {
      const s = d.data();
      totalCal += s.calories || 0;
      totalDist += (s.distanceMeters || 0) / 1000;
    });

    const userDoc = await db.collection('users').doc(uid).get();
    const latestWeight = userDoc.exists ? userDoc.data().weight : null;

    // Build HTML
    let html = `<h3 style="margin-bottom:10px;">🎯 Your Active Targets</h3><div class="target-grid">`;

    // We'll also collect DB update promises to set the achieved flag correctly
    const updates = [];

    snap.forEach(doc => {
      const t = doc.data();
      // default current metric for this target
      let current = 0;
      if (t.type === 'Calories') current = totalCal;
      else if (t.type === 'Running') current = totalDist;
      else if (t.type === 'Weight' && latestWeight !== null) current = latestWeight;

      // progress calculation
      let progress = 0;
      if (t.type === 'Weight') {
        // for weight targets we expect value = target weight (lower is better). 
        // If doc contains a 'start' weight use it, otherwise use latestWeight as baseline (if available) resulting in 0% until start exists
        const start = (t.start || latestWeight) || null;
        if (start !== null && t.value !== undefined && start !== t.value) {
          // progress expressed as percent of change from start -> goal
          // if target is lower than start, progress = (start - current) / (start - target)
          // if target is higher than start (gain weight) progress = (current - start) / (target - start)
          if (start > t.value) { // weight loss target
            progress = start === t.value ? 100 : Math.min(100, Math.max(0, ((start - current) / (start - t.value)) * 100));
          } else { // weight gain target
            progress = start === t.value ? 100 : Math.min(100, Math.max(0, ((current - start) / (t.value - start)) * 100));
          }
        } else {
          progress = 0;
        }
      } else {
        if (t.value && t.value > 0) progress = Math.min(100, (current / t.value) * 100);
        else progress = 0;
      }

      const achieved = progress >= 100;
      // ensure DB target doc has 'achieved' boolean (update if mismatch)
      updates.push(db.collection('users').doc(uid).collection('targets').doc(t.type).set({ achieved }, { merge: true }));

      // friendly visuals
      const ringColor = achieved ? '#00e676' : progress > 70 ? '#ffc247' : '#ff6b4a';
      const icon = t.type === 'Calories' ? '🔥' : t.type === 'Running' ? '🏃‍♂️' : '⚖️';
      const label = `${t.value} ${t.unit || ''}`;

      html += `
        <div class="target-card ${achieved ? 'achieved' : ''}" data-target-type="${t.type}">
          <div class="target-header">
            <div class="target-icon">${icon}</div>
            <div class="target-info">
              <strong>${t.type}</strong>
              <small>${label}</small>
            </div>
          </div>

          <div class="progress-ring">
            <svg width="90" height="90">
              <circle class="bg" cx="45" cy="45" r="38"></circle>
              <circle class="fg" cx="45" cy="45" r="38"
                style="stroke-dasharray:238;stroke-dashoffset:${238 - (238 * progress / 100)};stroke:${ringColor};"></circle>
            </svg>
            <div class="ring-text">${progress.toFixed(0)}%</div>
          </div>

          <div class="target-status">${achieved ? '🏁 Goal Achieved!' :
            progress > 70 ? '🔥 Almost there!' :
            progress > 40 ? '💪 Keep pushing!' : '🚀 Just starting!'}</div>
        </div>
      `;
    });

    html += '</div>';
    c.innerHTML = html;

    // execute DB updates for achieved flags
    await Promise.all(updates);

    // Inject UI styles once (idempotent guard)
    if (!document.getElementById('slf-target-styles')) {
      const style = document.createElement('style');
      style.id = 'slf-target-styles';
      style.textContent = `
        .target-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:24px; margin-top:12px; }
        .target-card { background: rgba(255,255,255,0.03); border-radius:14px; padding:14px; text-align:center; transition: transform .2s, box-shadow .2s; }
        .target-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
        .target-card.achieved { background: linear-gradient(135deg,#ffb300,#ff6b4a); color:#050c14; }
        .target-header { display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px; }
        .target-icon { font-size:1.4rem; }
        .progress-ring { position: relative; width:90px; height:90px; margin:8px auto; }
        .progress-ring svg { transform: rotate(-90deg); }
        .progress-ring circle { fill:none; stroke-width:8; }
        .progress-ring .bg { stroke: rgba(255,255,255,0.08); }
        .ring-text { position:absolute; left:50%; top:50%; transform: translate(-50%,-50%); font-weight:700; }
        .target-status { margin-top:8px; font-size:0.9rem; color: #ffb84a; }
      `;
      document.head.appendChild(style);
    }
  } catch (e) {
    console.error('loadTargets error', e);
    c.innerHTML = '<div class="muted">⚠️ Could not load targets.</div>';
  }
}


/* ---------- ACHIEVEMENTS (Compute + Render trophies based on real progress) ---------- */
async function loadAchievements(uid) {
  // keep backward-compatible ids in case of HTML mismatch
  const c = $('#achievementsContainer') || document.getElementById('achievementsContainer') || document.getElementById('achievementscontainer');
  if (!c) return;

  try {
    // Fetch all targets to determine achievements
    const targetsSnap = await db.collection('users').doc(uid).collection('targets').get();
    if (targetsSnap.empty) {
      c.innerHTML = '<div class="muted">No achievements yet. Level up to unlock your first trophy 🏆</div>';
      return;
    }

    // compute current metrics from sessions & user weight
    const sessionsSnap = await db.collection('sessions').where('uid', '==', uid).get();
    let totalCal = 0, totalDist = 0;
    sessionsSnap.forEach(d => {
      const s = d.data();
      totalCal += s.calories || 0;
      totalDist += (s.distanceMeters || 0) / 1000;
    });
    const userDoc = await db.collection('users').doc(uid).get();
    const latestWeight = userDoc.exists ? userDoc.data().weight : null;

    // compute achieved list and ensure DB flags match actual
    const achieved = [];
    const updatePromises = [];
    targetsSnap.forEach(doc => {
      const t = doc.data();
      let current = 0;
      if (t.type === 'Calories') current = totalCal;
      else if (t.type === 'Running') current = totalDist;
      else if (t.type === 'Weight' && latestWeight !== null) current = latestWeight;

      let progress = 0;
      if (t.type === 'Weight') {
        const start = (t.start || latestWeight) || null;
        if (start !== null && t.value !== undefined && start !== t.value) {
          if (start > t.value) progress = Math.min(100, Math.max(0, ((start - current) / (start - t.value)) * 100));
          else progress = Math.min(100, Math.max(0, ((current - start) / (t.value - start)) * 100));
        } else progress = 0;
      } else {
        progress = t.value && t.value > 0 ? Math.min(100, (current / t.value) * 100) : 0;
      }

      const isAchieved = progress >= 100;
      if (isAchieved) achieved.push({ type: t.type, value: t.value, unit: t.unit || '' });

      // ensure DB flag updated if mismatched
      updatePromises.push(db.collection('users').doc(uid).collection('targets').doc(t.type).set({ achieved: isAchieved }, { merge: true }));
    });

    await Promise.all(updatePromises);

    if (!achieved.length) {
      c.innerHTML = '<div class="muted">Keep pushing 💪 — your next milestone awaits!</div>';
      return;
    }

    // render achievements
    let html = `<h3 style="margin-bottom:10px;">🏅 Achievements Unlocked</h3><div class="trophy-grid">`;
    achieved.forEach(a => {
      const color = a.type === 'Calories' ? '#ff6b4a' : a.type === 'Running' ? '#4caf50' : '#ffc247';
      const icon = a.type === 'Calories' ? '🔥' : a.type === 'Running' ? '🏃‍♂️' : '⚖️';
      html += `
        <div class="trophy-card" style="border-color:${color};">
          <div class="trophy-icon" style="color:${color}">${icon}</div>
          <div class="trophy-info">
            <strong>${a.type} Goal</strong>
            <p>${a.value} ${a.unit}</p>
            <span class="badge-status">Unlocked ✅</span>
          </div>
        </div>`;
    });
    html += '</div>';
    c.innerHTML = html;

    // lightweight styles if not already injected
    if (!document.getElementById('slf-trophy-styles')) {
      const style = document.createElement('style');
      style.id = 'slf-trophy-styles';
      style.textContent = `
        .trophy-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin-top:12px; }
        .trophy-card { background: rgba(255,255,255,0.03); border-radius:12px; padding:12px; display:flex; gap:12px; align-items:center; border:2px solid; }
        .trophy-card:hover { transform: translateY(-4px); box-shadow: 0 8px 16px rgba(0,0,0,0.45); }
        .trophy-icon { font-size:1.8rem; filter: drop-shadow(0 0 6px rgba(255,255,255,0.08)); }
        .trophy-info strong { display:block; font-size:1.05em; }
        .trophy-info p { margin:4px 0; color:#ccc; font-size:0.95em; }
        .badge-status { color:#ffb84a; font-size:0.85em; }
      `;
      document.head.appendChild(style);
    }

  } catch (e) {
    console.error('loadAchievements error', e);
    c.innerHTML = '<div class="muted">⚠️ Could not load achievements.</div>';
  }
}


/* ========== Analysis ========== */
/* ---------- ANALYSIS (Training Intensity + Weekly Muscle Balance Chart) ---------- */
/* ---------- ANALYSIS (Balanced Muscle Focus + Weekly Trend Comparison) ---------- */
async function buildAnalysis(uid) {
  const c = $('#analysisContent');
  c.innerHTML = '<div class="muted">Analyzing your training balance...</div>';

  try {
    const normalizeMuscle = m => (m || 'unknown').replace(/[^a-z]/gi, '').toLowerCase();
    const ideal = { legs: 30, chest: 20, back: 20, core: 15, arms: 15 };

    // Fetch user sessions
    const snap = await db.collection('sessions').where('uid', '==', uid).get();
    const sessions = snap.docs.map(d => d.data());
    if (sessions.length === 0) {
      c.innerHTML = '<div class="muted">No training sessions found yet.</div>';
      return;
    }

    // Split sessions by week (this week & previous week)
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeekStart = now - weekMs;
    const lastWeekStart = now - 2 * weekMs;

    const groupCalories = (start, end) => {
      const map = {};
      sessions.forEach(s => {
        const ts = s.timestamp ? s.timestamp.toDate().getTime() : 0;
        if (ts >= start && ts < end) {
          const m = normalizeMuscle(s.muscle);
          map[m] = (map[m] || 0) + (s.calories || 0);
        }
      });
      return map;
    };

    const thisWeek = groupCalories(thisWeekStart, now);
    const lastWeek = groupCalories(lastWeekStart, thisWeekStart);

    const allMuscles = Array.from(new Set([...Object.keys(ideal), ...Object.keys(thisWeek), ...Object.keys(lastWeek)]));
    const totalThis = Object.values(thisWeek).reduce((a, b) => a + b, 0);
    const totalLast = Object.values(lastWeek).reduce((a, b) => a + b, 0);

    /* --- Balanced Muscle Focus --- */
    let html = `<h3>Balanced Muscle Focus</h3>
      <p class="muted">Compare your current week’s training split with the ideal balanced ratio.</p>
      <table class="analysis-table"><thead><tr><th>Muscle</th><th>Ideal %</th><th>Your %</th><th>Status</th></tr></thead><tbody>`;

    allMuscles.forEach(m => {
      const idealPct = ideal[m] || 10;
      const yourPct = totalThis ? ((thisWeek[m] || 0) / totalThis) * 100 : 0;
      let status = 'Balanced ✅';
      if (yourPct < idealPct * 0.6) status = 'Undertrained ⚠️';
      else if (yourPct > idealPct * 1.4) status = 'Overfocused 🔴';
      html += `<tr><td>${m.toUpperCase()}</td><td>${idealPct}%</td><td>${yourPct.toFixed(1)}%</td><td>${status}</td></tr>`;
    });
    html += '</tbody></table>';

    /* --- Weekly Muscle Trend Comparison --- */
    html += `<div class="card" style="margin-top:16px">
      <h3>Week-over-Week Muscle Trend</h3>
      <table class="analysis-table"><thead><tr><th>Muscle</th><th>Last Week %</th><th>This Week %</th><th>Change</th><th>Status</th></tr></thead><tbody>`;

    allMuscles.forEach(m => {
      const lastPct = totalLast ? ((lastWeek[m] || 0) / totalLast) * 100 : 0;
      const thisPct = totalThis ? ((thisWeek[m] || 0) / totalThis) * 100 : 0;
      const change = thisPct - lastPct;
      let status = 'Stable';
      if (change > 3) status = 'Improved ✅';
      else if (change < -3) status = 'Dropped ⚠️';
      html += `<tr><td>${m.toUpperCase()}</td><td>${lastPct.toFixed(1)}%</td><td>${thisPct.toFixed(1)}%</td><td>${change >= 0 ? '+' : ''}${change.toFixed(1)}%</td><td>${status}</td></tr>`;
    });
    html += '</tbody></table></div>';

    /* --- Add Bar Chart for Current Week --- */
    html += `<div class="card" style="margin-top:16px"><h3>Weekly Muscle Balance</h3><canvas id="muscleBalanceChart" height="220"></canvas></div>`;

    c.innerHTML = html;

    // Chart
    const ctx = $('#muscleBalanceChart').getContext('2d');
    const labels = allMuscles.map(m => m.toUpperCase());
    const yourValues = allMuscles.map(m => totalThis ? ((thisWeek[m] || 0) / totalThis) * 100 : 0);
    const idealValues = allMuscles.map(m => ideal[m] || 10);

    if (window.muscleChart) window.muscleChart.destroy();
    window.muscleChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Your %', data: yourValues, backgroundColor: '#ff6b4a' },
          { label: 'Ideal %', data: idealValues, backgroundColor: '#00bcd4' }
        ]
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 60 } },
        plugins: {
          title: { display: true, text: 'Your Weekly Muscle Focus vs Ideal Ratio' }
        }
      }
    });

  } catch (err) {
    console.error('buildAnalysis error:', err);
    c.innerHTML = '<div class="muted">⚠️ Error while computing analysis.</div>';
  }
}



/* ========== Community comparison (runs) ========== */
async function buildCommunityComparison(uid){
  const container = $('#communityComparison');
  if (!container) return;
  container.innerHTML = '<div class="muted">Analyzing your weekly performance...</div>';
  try {
    const s = await db.collection('sessions').where('uid','==',uid).get();
    const sessions = s.docs.map(d => d.data());
    const weekAgo = Date.now() - 7*86400000;
    const runs = sessions.filter(r => r.type && r.type.toLowerCase().includes('run') && r.timestamp && r.timestamp.toDate().getTime() > weekAgo);
    const totalDist = runs.reduce((a,r)=>a + ((r.distanceMeters||0)/1000), 0);
    const totalSessions = runs.length;
    const avgPace = runs.length ? runs.reduce((a,r)=> a + (r.durationMin / ((r.distanceMeters||1000)/1000)), 0) / runs.length : 0;

    // load CSV dataset (if exists) for global stats
    let dists = [], paces = [];
    try {
      const res = await fetch('data/run_or_walk.csv');
      if (res.ok) {
        const txt = await res.text();
        const lines = txt.split(/\r?\n/).filter(Boolean);
        for (let i=1;i<lines.length;i++){
          const cols = lines[i].split(',');
          if (!cols || cols.length < 2) continue;
          const dv = parseFloat(cols[1]); if (!Number.isNaN(dv)) dists.push(dv);
          if (cols.length > 2) { const pv = parseFloat(cols[2]); if (!Number.isNaN(pv)) paces.push(pv); }
        }
      }
    } catch(e){ /* ignore */ }

    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
    const std = (arr,m) => arr.length ? Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length) : 0;
    const gAvgDist = avg(dists) || 10;
    const gAvgPace = avg(paces) || 6;
    const gStdDist = std(dists, gAvgDist) || 3;

    const percentile = (v,m,s) => Math.min(99, Math.max(1, Math.round(50 + ((v - m)/(s||1))*15)));
    const distPct = percentile(totalDist, gAvgDist, gStdDist);
    const sesPct = percentile(totalSessions, 3.5, 1.3);
    const pacePct = percentile(gAvgPace - avgPace, 0, (std(paces, gAvgPace) || 0.8));

    const bar = p => `<div style='width:140px;background:#222;border-radius:8px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px;'><div style='width:${p}%;height:8px;background:#ff6b4a;'></div></div>${p}%`;
    const level = pct => pct >= 80 ? "🏆 Top performer" : pct >= 60 ? "💪 Above average" : pct >= 40 ? "😐 Average" : pct >= 20 ? "⚠️ Below average" : "🔴 Needs improvement";

    let html = `<table class='analysis-table'><thead><tr><th>Metric</th><th>You</th><th>Global Avg</th><th>Percentile</th><th>Status</th></tr></thead><tbody>`;
    html += `<tr><td>Weekly Distance (km)</td><td>${totalDist.toFixed(1)}</td><td>${gAvgDist.toFixed(1)}</td><td>${bar(distPct)}</td><td>${level(distPct)}</td></tr>`;
    html += `<tr><td>Weekly Sessions</td><td>${totalSessions}</td><td>${3.5.toFixed(1)}</td><td>${bar(sesPct)}</td><td>${level(sesPct)}</td></tr>`;
    html += `<tr><td>Avg Pace (min/km)</td><td>${avgPace.toFixed(1)}</td><td>${gAvgPace.toFixed(1)}</td><td>${bar(pacePct)}</td><td>${level(pacePct)}</td></tr>`;
    html += `</tbody></table>`;
    html += `<div class='muted' style='margin-top:10px;'>${distPct>60 && sesPct>60 ? '🔥 You’re training above average compared to global users!' : distPct<40 ? '⚠️ Below global average. Try adding more runs.' : '💪 You’re average — stay consistent!'}</div>`;

    container.innerHTML = html;
  } catch (e) {
    console.error('buildCommunityComparison', e);
    container.innerHTML = '<div class="muted">Unable to load comparison.</div>';
  }
}

/* ========== DOM ready fallback ========== */
document.addEventListener('DOMContentLoaded', () => {
 
  // If user is already signed in, initDashboard will have been called by auth.onAuthStateChanged above.
});

/* ===================================================
   End of app.js
   =================================================== */
