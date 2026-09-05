// Firebase Auth in the browser, then every API call carries the ID token.
// Loaded from Google's own CDN — no third-party script host.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const el = (id) => document.getElementById(id);

let auth = null;
let openDate = null;      // the entry on screen, YYYY-MM-DD
let calMonth = null;      // first of the month the calendar is showing
let saveTimer = null;
let lastSaved = "";
let busy = false;

// --------------------------------------------------------------- dates
// The browser owns the notion of "today": a server in UTC would file an
// evening entry in Chennai under tomorrow.

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const today = () => iso(new Date());
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function heading(dateStr) {
  const d = parse(dateStr);
  return { date: `${MONTHS[d.getMonth()]} ${d.getDate()}`, weekday: DAYS[d.getDay()] };
}

// -------------------------------------------------------------- helpers

let snackTimer;
function toast(text) {
  el("snackbar-text").textContent = text;
  el("snackbar").dataset.open = "true";
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => (el("snackbar").dataset.open = "false"), 5000);
}

/** Every authenticated call goes through here, so the token is never forgotten. */
async function api(path, options = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("signed out");

  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Something went wrong.");
  }
  return response.json();
}

/** Wipe every trace of whoever was signed in before.
 *  The journal lives in the DOM as well as in Firestore, and sign-out has to
 *  clear both — otherwise the next person to sign in on this device sees the
 *  previous person's entries until their own data arrives. */
function resetUserUI() {
  clearTimeout(saveTimer);
  openDate = null;
  lastSaved = "";
  el("entry").value = "";
  el("entry-saved").textContent = "";
  el("prompt").hidden = true;
  el("reflection").hidden = true;
  el("reflect-cta").hidden = true;
  el("thread").hidden = true;
  el("thread").innerHTML = "";
  el("say").hidden = true;
  el("timeline-list").innerHTML = "";
  el("cal-grid").innerHTML = "";
  el("week-bars").innerHTML = "";
  el("week-label").textContent = "";
  el("insights-report").hidden = true;
  el("insights-error").hidden = true;
  el("insights-sample").hidden = true;
  insightsLoaded = false;
}

function showPane(name) {
  for (const [pane, nav] of [
    ["pane-entry", "nav-today"],
    ["pane-timeline", "nav-timeline"],
    ["pane-insights", "nav-insights"],
  ]) {
    const on = pane === `pane-${name}`;
    el(pane).dataset.active = String(on);
    el(nav).dataset.active = String(on);
  }
}

// ---------------------------------------------------------------- entry

async function openEntry(dateStr) {
  openDate = dateStr;
  const { date, weekday } = heading(dateStr);
  el("entry-date").textContent = date;
  el("entry-weekday").textContent = weekday;
  el("entry-saved").textContent = "";

  el("thread").innerHTML = "";
  el("thread").hidden = true;
  el("say").hidden = true;
  el("reflection").hidden = true;
  el("reflect-cta").hidden = true;

  let data;
  try {
    data = await api(`/api/entries/${dateStr}`);
  } catch (error) {
    toast(error.message);
    return;
  }

  el("entry").value = data.entry.text || "";
  lastSaved = el("entry").value;
  autosize();

  if (data.entry.reflection) showReflection(data.entry.reflection);
  else el("reflect-cta").hidden = !el("entry").value.trim();

  (data.thread || []).forEach((m) => addTurn(m.role === "user" ? "user" : "echo", m.text));
  if (data.thread && data.thread.length) {
    el("thread").hidden = false;
    el("say").hidden = false;
  }

  // The opener belongs to today only — older days already have their answer.
  el("prompt").hidden = true;
  if (dateStr === today() && !el("entry").value.trim()) loadOpener();
}

function showReflection(text) {
  el("reflection-text").textContent = text;
  el("reflection").hidden = false;
  el("reflect-cta").hidden = true;
}

function addTurn(role, text) {
  const div = document.createElement("div");
  div.className = `turn turn--${role}`;
  div.textContent = text;
  el("thread").appendChild(div);
  el("thread").hidden = false;
  return div;
}

function autosize() {
  const box = el("entry");
  box.style.height = "auto";
  box.style.height = `${Math.max(220, box.scrollHeight)}px`;
}

async function loadOpener() {
  try {
    const { opener, from } = await api("/api/opener");
    el("prompt-text").textContent = opener;
    el("prompt-from").textContent = from
      ? `From ${heading(from).date}`
      : "To get you started";
    el("prompt").hidden = false;
  } catch {
    // A missing opener should never block the page.
  }
}

// Autosave: quiet, frequent, and it never calls the model.
function queueSave() {
  clearTimeout(saveTimer);
  el("entry-saved").textContent = "";
  saveTimer = setTimeout(save, 900);
}

async function save() {
  const text = el("entry").value;
  if (!openDate || text === lastSaved) return;
  try {
    const { entry } = await api(`/api/entries/${openDate}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    });
    lastSaved = text;
    el("entry-saved").textContent = text.trim() ? "Saved" : "";
    // Editing clears an earlier reflection server-side; mirror that here.
    if (!entry.reflection) {
      el("reflection").hidden = true;
      el("reflect-cta").hidden = !text.trim();
    }
    refreshCalendar();
  } catch (error) {
    el("entry-saved").textContent = "Not saved";
    toast(error.message);
  }
}

// -------------------------------------------------------------- calendar

async function refreshCalendar() {
  if (!calMonth) calMonth = new Date();
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, "0")}`;
  el("cal-label").textContent = `${MONTHS[m]} ${y}`;

  let written = [];
  try {
    ({ days: written } = await api(`/api/calendar/${prefix}`));
  } catch {
    // A calendar that can't load should not take the page with it.
  }
  const has = new Set(written);

  const grid = el("cal-grid");
  grid.innerHTML = "";
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;          // Monday-first
  const count = new Date(y, m + 1, 0).getDate();
  const now = today();

  for (let i = 0; i < lead; i++) grid.appendChild(document.createElement("span"));

  for (let d = 1; d <= count; d++) {
    const dateStr = `${prefix}-${String(d).padStart(2, "0")}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cal__day";
    b.textContent = String(d);
    b.dataset.in = "true";
    if (has.has(dateStr)) b.dataset.written = "true";
    if (dateStr === now) b.dataset.today = "true";
    if (dateStr > now) { b.disabled = true; b.dataset.in = "false"; }
    else b.addEventListener("click", () => { showPane("entry"); openEntry(dateStr); });
    grid.appendChild(b);
  }

  renderWeek(has);
}

function renderWeek(written) {
  const bars = el("week-bars");
  bars.innerHTML = "";
  const now = new Date();
  let count = 0;

  // Monday of the current week through Sunday.
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = iso(d);
    const span = document.createElement("span");
    if (written.has(key)) { span.dataset.on = "true"; count++; }
    if (key === today()) span.dataset.today = "true";
    bars.appendChild(span);
  }

  el("week-label").textContent =
    count === 0 ? "Nothing written this week yet"
    : count === 1 ? "Written 1 day this week"
    : `Written ${count} days this week`;
}

// -------------------------------------------------------------- timeline

async function loadTimeline() {
  let entries = [];
  try {
    ({ entries } = await api("/api/entries"));
  } catch (error) {
    toast(error.message);
    return;
  }

  const list = el("timeline-list");
  list.innerHTML = "";
  el("timeline-empty").hidden = entries.length > 0;

  entries.slice().reverse().forEach((e) => {
    const d = parse(e.date);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "day";
    row.innerHTML =
      `<span class="day__when"><span class="day__num"></span><span class="day__mon"></span></span>` +
      `<span class="day__body"><p class="day__text"></p><span class="day__tag"></span></span>`;
    row.querySelector(".day__num").textContent = String(d.getDate());
    row.querySelector(".day__mon").textContent = MONTHS[d.getMonth()];
    row.querySelector(".day__text").textContent = e.text;
    row.querySelector(".day__tag").textContent = e.reflection ? "Echo replied" : "";
    row.addEventListener("click", () => { showPane("entry"); openEntry(e.date); });
    list.appendChild(row);
  });
}

// -------------------------------------------------------------- insights

let insightsLoaded = false;

const SAMPLE_INSIGHTS = {
  entry_count: 12,
  themes: ["work pressure", "sleep", "a course you started", "calls home"],
  mood_arc:
    "The first week reads tense and clipped. The last few entries are longer " +
    "and calmer — the change shows up right after you started walking in the evenings.",
  observation:
    "Sleep appears in eight of the twelve entries, and every day you described " +
    "as difficult followed a night you called restless.",
  suggestion:
    "Try writing one line before bed instead of after work. Your evening entries " +
    "are consistently kinder to you than your midday ones.",
};

function renderInsights(report) {
  el("insights-meta").textContent = `Read from your last ${report.entry_count} entries.`;
  const themes = el("insights-themes");
  themes.innerHTML = "";
  (report.themes || []).forEach((t) => {
    const chip = document.createElement("span");
    chip.textContent = t;
    themes.appendChild(chip);
  });
  el("insights-mood").textContent = report.mood_arc;
  el("insights-observation").textContent = report.observation;
  el("insights-suggestion").textContent = report.suggestion;
}

async function loadInsights(refresh = false) {
  el("insights-error").hidden = true;
  el("insights-report").hidden = true;
  el("insights-loading").hidden = false;

  try {
    const { insights } = await api(refresh ? "/api/insights?refresh=true" : "/api/insights");
    el("insights-loading").hidden = true;

    // Nothing written yet: a clearly-labelled example beats a dead end, so
    // the feature explains itself on a brand-new account.
    if (!insights) {
      renderInsights(SAMPLE_INSIGHTS);
      el("insights-sample").hidden = false;
      el("insights-meta").hidden = true;
      el("insights-refresh").hidden = true;
      el("insights-report").hidden = false;
      return;
    }

    el("insights-sample").hidden = true;
    el("insights-meta").hidden = false;
    el("insights-refresh").hidden = false;
    renderInsights(insights);
    el("insights-report").hidden = false;
    insightsLoaded = true;
  } catch (error) {
    el("insights-loading").hidden = true;
    el("insights-error-detail").textContent = error.message;
    el("insights-error").hidden = false;
  }
}

// ------------------------------------------------------------------- boot

async function start() {
  let config;
  try {
    config = await fetch("/api/config").then((r) => r.json());
  } catch {
    toast("Couldn't reach the server.");
    return;
  }
  if (!config.apiKey) {
    toast("Firebase isn't configured yet. See README.");
    return;
  }

  auth = getAuth(initializeApp(config));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      resetUserUI();
      el("view-signin").dataset.active = "true";
      el("app").hidden = true;
      return;
    }

    resetUserUI();
    el("view-signin").dataset.active = "false";
    el("app").hidden = false;
    showPane("entry");

    el("avatar").textContent = (user.displayName || user.email || "?").trim().charAt(0).toUpperCase();
    el("nav-email").textContent = user.email || "";

    try {
      await api("/api/me");
    } catch (error) {
      toast(error.message);
      return;
    }

    calMonth = new Date();
    await openEntry(today());
    refreshCalendar();
  });
}

// ---------------------------------------------------------------- actions

const SIGNIN_ERRORS = {
  "auth/unauthorized-domain":
    "This site isn't authorised for sign-in yet. Add it under Firebase " +
    "Authentication > Settings > Authorized domains.",
  "auth/operation-not-allowed": "Google sign-in isn't switched on for this project yet.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and retry.",
  "auth/invalid-api-key": "The Firebase configuration for this site is wrong.",
  "auth/api-key-not-valid": "The Firebase configuration for this site is wrong.",
  "auth/network-request-failed": "Couldn't reach Google. Check your connection.",
};

el("signin").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user") return;
    console.error("sign-in failed:", error.code, error.message);
    toast(SIGNIN_ERRORS[error.code] || `Sign-in failed (${error.code}).`);
  }
});

el("signout").addEventListener("click", () => el("confirm-signout").showModal());
el("confirm-cancel").addEventListener("click", () => el("confirm-signout").close());
el("confirm-ok").addEventListener("click", () => {
  el("confirm-signout").close();
  signOut(auth);
});

el("nav-today").addEventListener("click", () => { showPane("entry"); openEntry(today()); });
el("nav-timeline").addEventListener("click", () => { showPane("timeline"); loadTimeline(); });
el("nav-insights").addEventListener("click", () => {
  showPane("insights");
  if (!insightsLoaded) loadInsights();
});
el("insights-refresh").addEventListener("click", () => loadInsights(true));
el("insights-retry").addEventListener("click", () => loadInsights(true));

el("cal-prev").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() - 1);
  refreshCalendar();
});
el("cal-next").addEventListener("click", () => {
  calMonth.setMonth(calMonth.getMonth() + 1);
  refreshCalendar();
});

el("entry").addEventListener("input", () => { autosize(); queueSave(); });
el("entry").addEventListener("blur", save);

el("reflect").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  const btn = el("reflect");
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    await save();
    const { reflection } = await api(`/api/entries/${openDate}/reflect`, { method: "POST" });
    showReflection(reflection);
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = "Ask Echo to read this";
  }
});

el("talk").addEventListener("click", () => {
  el("thread").hidden = false;
  el("say").hidden = false;
  el("say-text").focus();
});

el("say").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = el("say-text").value.trim();
  if (!text || busy) return;

  busy = true;
  el("say-text").value = "";
  addTurn("user", text);
  const waiting = addTurn("echo", "…");

  try {
    const { reply } = await api(`/api/entries/${openDate}/thread`, {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
    waiting.textContent = reply;
  } catch (error) {
    waiting.remove();
    addTurn("error", error.message);
  } finally {
    busy = false;
    el("say-text").focus();
  }
});

start();
