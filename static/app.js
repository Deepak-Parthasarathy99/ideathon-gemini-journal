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
let reflectTimer = null;
let lastSaved = "";
let reflectedText = null;   // the text Daybook has already answered
let busy = false;
let session = 0;
let entryLoad = 0;
let calendarLoad = 0;
let timelineLoad = 0;
let insightsLoad = 0;
let entryLoading = false;
let loadedDate = null;
let savePromise = null;
let nextBefore = null;
let pendingChat = null;
const requests = new Set();
const sameEntry = (epoch, date, load) => epoch === session && date === openDate && load === entryLoad;
class StaleRequest extends Error {}

// Short enough that the pause never reads as the app being stuck. Leaving
// the text box entirely counts as finishing and skips the wait.
const REFLECT_AFTER_MS = 1800;
const REFLECT_MIN_CHARS = 25;

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
  const user = auth?.currentUser;
  const epoch = session;
  if (!user) throw new Error("Sign in to continue.");
  const controller = new AbortController();
  requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 75000);
  const current = () => epoch === session && auth?.currentUser?.uid === user.uid;
  try {
    const token = await user.getIdToken();
    if (!current()) throw new StaleRequest();
    const response = await fetch(path, {
      ...options, signal: controller.signal,
      headers: {"Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {})},
    });
    const body = await response.json().catch(() => ({}));
    if (!current()) throw new StaleRequest();
    if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Please check your input and retry.");
    return body;
  } catch (error) {
    if (!current()) throw new StaleRequest();
    if (error.name === "AbortError") throw new Error("The request timed out. Your draft is kept; please retry.");
    throw error;
  } finally {
    clearTimeout(timeout);
    requests.delete(controller);
  }
}

/** Wipe every trace of whoever was signed in before.
 *  The journal lives in the DOM as well as in Firestore, and sign-out has to
 *  clear both — otherwise the next person to sign in on this device sees the
 *  previous person's entries until their own data arrives. */
function resetUserUI() {
  session += 1;
  entryLoad += 1;
  requests.forEach(controller => controller.abort());
  requests.clear();
  busy = false;
  entryLoading = false;
  savePromise = null;
  pendingChat = null;
  nextBefore = null;
  el("say-text").value = "";
  el("say-text").disabled = false;
  el("entry").readOnly = true;
  el("save-retry").hidden = true;
  el("timeline-more").hidden = true;
  el("insights-loading").hidden = true;
  el("theme-menu").hidden = true;
  el("account").setAttribute("aria-expanded", "false");
  for (const id of ["reflection-text", "prompt-text", "prompt-from", "insights-mood", "insights-observation", "insights-suggestion", "insights-meta", "nav-email", "avatar"]) el(id).textContent = "";
  el("insights-themes").innerHTML = "";
  clearTimeout(saveTimer);
  clearTimeout(reflectTimer);
  openDate = null;
  loadedDate = null;
  lastSaved = "";
  reflectedText = null;
  el("entry").value = "";
  el("entry-saved").textContent = "";
  el("prompt").hidden = true;
  el("reflection").hidden = true;
  el("reflect-cta").hidden = true;
  el("reflect-hint").hidden = true;
  el("thinking").hidden = true;
  el("thread").hidden = true;
  el("thread").innerHTML = "";
  el("say").hidden = true;
  el("timeline-list").innerHTML = "";
  el("cal-grid").innerHTML = "";
  el("week-bars").innerHTML = "";
  el("week-label").textContent = "";
  el("insights-report").hidden = true;
  el("insights-error").hidden = true;
  el("insights-empty").hidden = true;
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
    el(nav).setAttribute("aria-current", on ? "page" : "false");
  }
}

// ---------------------------------------------------------------- entry

async function openEntry(dateStr) {
  if (busy) { toast("Let Daybook finish before changing days."); return; }
  if (openDate !== dateStr && el("say-text").value.trim()) {
    toast("Send or clear your reply before changing days."); return;
  }
  const mine = session;
  // Flush the old day before changing the date used by autosave.
  if (!entryLoading && !(await save())) return;
  if (mine !== session) return;
  const load = ++entryLoad;
  clearTimeout(saveTimer);
  clearTimeout(reflectTimer);
  entryLoading = true;
  el("entry").readOnly = true;
  const previousDate = loadedDate;
  openDate = dateStr;
  try {
    const data = await api(`/api/entries/${dateStr}`);
    if (!sameEntry(mine, dateStr, load)) return;
    loadedDate = dateStr;
    showPane("entry");
    const d = parse(dateStr);
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    const {date, weekday} = heading(dateStr);
    el("entry-date").textContent = date;
    el("entry-weekday").textContent = weekday;
    el("entry-saved").textContent = "";
    el("entry").value = data.entry.text || "";
    lastSaved = el("entry").value;
    el("entry").readOnly = false;
    entryLoading = false;
    el("say-text").value = "";
    pendingChat = null;
    for (const id of ["thread", "say", "reflection", "reflect-cta", "reflect-hint", "thinking", "prompt"]) el(id).hidden = true;
    el("thread").innerHTML = "";
    reflectedText = data.entry.reflection ? lastSaved.trim() : null;
    autosize();
    if (data.entry.reflection) showReflection(data.entry.reflection);
    else queueReflection();
    (data.thread || []).forEach(m => addTurn(m.role === "user" ? "user" : "echo", m.text));
    if (data.thread?.length) el("say").hidden = false;
    if (dateStr === today() && !lastSaved.trim()) loadOpener();
    refreshCalendar();
  } catch (error) {
    if (!sameEntry(mine, dateStr, load)) return;
    openDate = previousDate;
    entryLoading = false;
    el("entry").readOnly = !previousDate;
    toast(error.message);
  }
}

function showReflection(text) {
  el("reflection-text").textContent = text;
  el("reflection").hidden = false;
  el("reflect-cta").hidden = true;
  el("reflect-hint").hidden = true;
  el("thinking").hidden = true;
  // Replying is the obvious next move, so the box is simply there.
  el("say").hidden = false;
}

/** Daybook reads once you have stopped, not because you asked it to.
 *  Skipped while one is in flight, and never twice for the same text.
 *
 *  The hint goes up the moment there is enough to read, so the pause is
 *  something the person is expecting rather than a screen doing nothing.
 */
function queueReflection() {
  clearTimeout(reflectTimer);
  const text = el("entry").value.trim();
  const ready = text.length >= REFLECT_MIN_CHARS && text !== reflectedText;

  el("reflect-hint").hidden = !ready || !el("thinking").hidden;
  if (!busy && text && text !== reflectedText) {
    el("reflect-cta").hidden = false;
    el("reflect-failed").textContent = "";
    el("reflect").textContent = "Read this entry";
  }
  if (!text || text === reflectedText) el("reflect-cta").hidden = true;
  if (!ready) return;

  reflectTimer = setTimeout(reflectNow, REFLECT_AFTER_MS);
}

async function reflectNow() {
  const text = el("entry").value.trim();
  if (busy || entryLoading || !openDate || !text || text === reflectedText) return;
  const epoch = session, date = openDate, load = entryLoad;
  busy = true;
  clearTimeout(reflectTimer);
  el("reflect-cta").hidden = true;
  el("reflect-hint").hidden = true;
  el("thinking").hidden = false;
  try {
    if (!(await save())) throw new Error("Your writing has not saved. Use Retry save before asking Daybook.");
    if (!sameEntry(epoch, date, load) || el("entry").value.trim() !== text) return;
    const {reflection} = await api(`/api/entries/${date}/reflect`, {method: "POST"});
    if (!sameEntry(epoch, date, load) || el("entry").value.trim() !== text) return;
    reflectedText = text;
    showReflection(reflection);
  } catch (error) {
    if (!sameEntry(epoch, date, load)) return;
    el("reflect-failed").textContent = error.message;
    el("reflect").textContent = "Try again";
    el("reflect-cta").hidden = false;
    toast(error.message);
  } finally {
    if (sameEntry(epoch, date, load)) {
      busy = false;
      el("thinking").hidden = true;
      el("reflect-hint").hidden = true;
    }
  }
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
  // Collapse before measuring: inside a flex column, "auto" lets the box
  // claim the leftover space and scrollHeight then reports that instead of
  // the text.
  box.style.height = "0px";
  const needed = box.scrollHeight;
  // An empty page should look like a page. Once there is writing on it the
  // box follows the text, so what comes next sits under the last line
  // instead of a screen away from it.
  box.style.height = `${Math.max(box.value.trim() ? 96 : 260, needed)}px`;
}

async function loadOpener() {
  const epoch = session, date = openDate, load = entryLoad;
  try {
    const { opener, from } = await api("/api/opener");
    if (!sameEntry(epoch, date, load) || el("entry").value.trim()) return;
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
  if (entryLoading) return false;
  if (!openDate) return true;
  if (savePromise) return savePromise;
  const epoch = session, date = openDate, load = entryLoad;
  const operation = (async () => {
    try {
      while (sameEntry(epoch, date, load) && el("entry").value.trim() !== lastSaved.trim()) {
        const text = el("entry").value;
        const {entry} = await api(`/api/entries/${date}`, {
          method: "PUT", body: JSON.stringify({text, expected_text: lastSaved.trim()}),
        });
        if (!sameEntry(epoch, date, load)) return false;
        lastSaved = entry.text;
        insightsLoaded = false;
        insightsLoad += 1;
        el("insights-report").hidden = true;
        el("save-retry").hidden = true;
        if (!entry.reflection) {
          el("reflection").hidden = true;
          // Keep an unsent chat draft visible.
          if (!el("say-text").value.trim()) el("say").hidden = true;
          reflectedText = null;
        }
      }
      if (!sameEntry(epoch, date, load)) return false;
      el("entry-saved").textContent = lastSaved.trim() ? "Saved" : "";
      refreshCalendar();
      return true;
    } catch (error) {
      if (sameEntry(epoch, date, load)) {
        el("entry-saved").textContent = "Not saved";
        el("save-retry").hidden = false;
        toast(error.message);
      }
      return false;
    }
  })();
  savePromise = operation;
  try { return await operation; }
  finally { if (savePromise === operation) savePromise = null; }
}

// -------------------------------------------------------------- calendar

async function refreshCalendar() {
  const epoch = session, request = ++calendarLoad;
  if (!calMonth) calMonth = new Date();
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, "0")}`;
  el("cal-label").textContent = `${MONTHS[m]} ${y}`;

  let written = [];
  try {
    ({ days: written } = await api(`/api/calendar/${prefix}`));
  } catch { return; }
  if (epoch !== session || request !== calendarLoad) return;
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
    b.dataset.date = dateStr;
    if (has.has(dateStr)) b.dataset.written = "true";
    if (dateStr === now) b.dataset.today = "true";
    if (dateStr > now) { b.disabled = true; b.dataset.in = "false"; }
    else b.addEventListener("click", () => openEntry(dateStr));
    b.setAttribute("aria-label", `${heading(dateStr).date}, ${y}${has.has(dateStr) ? ", has an entry" : ""}`);
    grid.appendChild(b);
  }

  markCalendarSelection();
  refreshWeek();
}

/** Which day you are reading, which is not the same as which day it is.
 *  Today keeps its own ring so it stays findable while you browse. */
function markCalendarSelection() {
  document
    .querySelectorAll(".cal__day")
    .forEach((b) => {
      b.dataset.selected = String(b.dataset.date === openDate);
      b.setAttribute("aria-pressed", b.dataset.selected);
    });
}

async function refreshWeek() {
  const epoch = session, request = calendarLoad;
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
  const months = [...new Set([iso(monday).slice(0, 7), iso(sunday).slice(0, 7)])];
  try {
    const values = await Promise.all(months.map(m => api(`/api/calendar/${m}`)));
    if (epoch !== session || request !== calendarLoad) return;
    renderWeek(new Set(values.flatMap(v => v.days)));
  } catch { /* Calendar remains usable if the activity summary fails. */ }
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

async function loadTimeline(more = false) {
  const epoch = session, request = ++timelineLoad;
  el("timeline-more").disabled = true;
  let entries = [], next_before = null;
  try {
    ({ entries, next_before } = await api(more && nextBefore ? `/api/entries?before=${nextBefore}` : "/api/entries"));
  } catch (error) {
    if (epoch !== session || request !== timelineLoad) return;
    el("timeline-more").disabled = false;
    toast(error.message);
    return;
  }

  if (epoch !== session || request !== timelineLoad) return;
  nextBefore = next_before;
  el("timeline-more").disabled = false;
  el("timeline-more").hidden = !nextBefore;
  const list = el("timeline-list");
  if (!more) list.innerHTML = "";
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
    row.querySelector(".day__tag").textContent = e.reflection ? "Daybook replied" : "";
    row.addEventListener("click", () => openEntry(e.date));
    list.appendChild(row);
  });
}

// -------------------------------------------------------------- insights

let insightsLoaded = false;

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
  const epoch = session, request = ++insightsLoad;
  el("insights-error").hidden = true;
  el("insights-empty").hidden = true;
  el("insights-report").hidden = true;
  el("insights-loading").hidden = false;

  try {
    const { insights } = await api(`/api/insights?day=${today()}&refresh=${refresh}`);
    if (epoch !== session || request !== insightsLoad) return;
    el("insights-loading").hidden = true;

    // Everything here comes from the person's own entries. With nothing to
    // read, say so plainly rather than showing an invented example.
    if (!insights) {
      el("insights-empty").hidden = false;
      return;
    }
    renderInsights(insights);
    el("insights-report").hidden = false;
    insightsLoaded = true;
  } catch (error) {
    if (epoch !== session || request !== insightsLoad) return;
    el("insights-loading").hidden = true;
    el("insights-error-detail").textContent = error.message;
    el("insights-error").hidden = false;
  }
}

// ------------------------------------------------------------------ theme
// Three states, and "system" is the default: most people never open this,
// and following their machine is the right answer for them.

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else delete root.dataset.theme;

  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    const on = b.dataset.themeChoice === choice;
    b.dataset.active = String(on);
    b.setAttribute("aria-checked", String(on));
  });
}

function storedTheme() {
  try {
    return localStorage.getItem("daybook-theme") || "system";
  } catch {
    return "system";
  }
}

function setTheme(choice) {
  try {
    if (choice === "system") localStorage.removeItem("daybook-theme");
    else localStorage.setItem("daybook-theme", choice);
  } catch {
    // A browser refusing storage should still switch for this visit.
  }
  applyTheme(choice);
}

applyTheme(storedTheme());

// ------------------------------------------------------------------- boot

/** Stop holding the page back, whichever way things resolved. */
function booted() {
  el("booting").hidden = true;
}

async function start() {
  let config;
  try {
    config = await fetch("/api/config").then((r) => r.json());
  } catch {
    booted();
    el("view-signin").dataset.active = "true";
    toast("Couldn't reach the server.");
    return;
  }
  if (!config.apiKey) {
    booted();
    el("view-signin").dataset.active = "true";
    toast("Firebase isn't configured yet. See README.");
    return;
  }

  auth = getAuth(initializeApp(config));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      resetUserUI();
      el("view-signin").dataset.active = "true";
      el("app").hidden = true;
      booted();
      return;
    }

    resetUserUI();
    el("view-signin").dataset.active = "false";
    el("app").hidden = false;
    showPane("entry");
    booted();

    el("avatar").textContent = (user.displayName || user.email || "?").trim().charAt(0).toUpperCase();
    el("nav-email").textContent = user.email || "";

    const epoch = session;
    try {
      await api("/api/me");
      if (epoch !== session) return;
    } catch (error) {
      if (epoch === session) toast(error.message);
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

el("account").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = el("theme-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  el("account").setAttribute("aria-expanded", String(open));
});

document.querySelectorAll("[data-theme-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    setTheme(b.dataset.themeChoice);
    el("theme-menu").hidden = true;
    el("account").setAttribute("aria-expanded", "false");
  })
);

document.addEventListener("click", (event) => {
  const menu = el("theme-menu");
  if (!menu.hidden && !menu.contains(event.target)) {
    menu.hidden = true;
    el("account").setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el("theme-menu").hidden) {
    el("theme-menu").hidden = true;
    el("account").setAttribute("aria-expanded", "false");
  }
});

el("signout").addEventListener("click", () => el("confirm-signout").showModal());
el("confirm-cancel").addEventListener("click", () => el("confirm-signout").close());
el("confirm-ok").addEventListener("click", async () => {
  if (busy) { toast("Wait for Daybook to finish before signing out."); return; }
  if (el("say-text").value.trim()) { toast("Send or clear your reply before signing out."); return; }
  const epoch = session;
  if (!(await save()) || epoch !== session) return;
  try { await signOut(auth); el("confirm-signout").close(); }
  catch (error) { toast(error.message); }
});

el("nav-today").addEventListener("click", () => openEntry(today()));
el("nav-timeline").addEventListener("click", async () => {
  const epoch = session;
  if (await save() && epoch === session) { showPane("timeline"); loadTimeline(); }
});
el("nav-insights").addEventListener("click", async () => {
  const epoch = session;
  if (!(await save()) || epoch !== session) return;
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

el("entry").addEventListener("input", () => {
  el("reflection").hidden = true;
  autosize();
  queueSave();
  queueReflection();
});

// Leaving the box says you have finished, so read it now rather than
// counting down again.
el("entry").addEventListener("blur", () => {
  save();
  clearTimeout(reflectTimer);
  if (el("entry").value.trim().length >= REFLECT_MIN_CHARS) reflectNow();
});

el("reflect").addEventListener("click", reflectNow);

el("say").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el("say-text");
  const text = input.value.trim();
  if (!text || busy || entryLoading || !openDate) return;
  const epoch = session, date = openDate, load = entryLoad;
  busy = true;
  input.disabled = true;
  if (!pendingChat || pendingChat.text !== text || pendingChat.date !== date) {
    pendingChat = {text, date, id: crypto.randomUUID()};
  }
  const requestId = pendingChat.id;
  const bubble = addTurn("user", text);
  const waiting = addTurn("echo", "…");
  try {
    if (!(await save())) throw new Error("Save your entry before sending a reply.");
    if (!sameEntry(epoch, date, load)) return;
    const {reply} = await api(`/api/entries/${date}/thread`, {
      method: "POST", body: JSON.stringify({message: text, request_id: requestId}),
    });
    if (!sameEntry(epoch, date, load)) return;
    waiting.textContent = reply;
    input.value = "";
    pendingChat = null;
  } catch (error) {
    if (!sameEntry(epoch, date, load)) return;
    waiting.remove(); bubble.remove();
    addTurn("error", error.message);
  } finally {
    if (sameEntry(epoch, date, load)) {
      busy = false;
      input.disabled = false;
      input.focus();
    }
  }
});

el("save-retry").addEventListener("click", () => save());
el("timeline-more").addEventListener("click", () => loadTimeline(true));
el("pick-date").max = today();
el("pick-date").addEventListener("change", event => {
  if (event.target.value && event.target.value <= today()) openEntry(event.target.value);
});
window.addEventListener("beforeunload", event => {
  if ((openDate && el("entry").value.trim() !== lastSaved.trim()) || el("say-text").value.trim() || savePromise) {
    event.preventDefault(); event.returnValue = "";
  }
});

start().catch(() => { booted(); el("view-signin").dataset.active = "true"; toast("Could not start sign-in. Please reload and try again."); });
