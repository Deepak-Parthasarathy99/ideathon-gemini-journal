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

// Short enough that the pause never reads as the app being stuck. Leaving
// the text box entirely counts as finishing and skips the wait.
const REFLECT_AFTER_MS = 1800;
const REFLECT_MIN_CHARS = 40;

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
  clearTimeout(reflectTimer);
  openDate = null;
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
  el("reflect-hint").hidden = true;
  el("thinking").hidden = true;

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

  reflectedText = data.entry.reflection ? el("entry").value.trim() : null;
  if (data.entry.reflection) showReflection(data.entry.reflection);
  else queueReflection();

  (data.thread || []).forEach((m) => addTurn(m.role === "user" ? "user" : "echo", m.text));
  if (data.thread && data.thread.length) el("thread").hidden = false;

  // The opener belongs to today only — older days already have their answer.
  el("prompt").hidden = true;
  if (dateStr === today() && !el("entry").value.trim()) loadOpener();
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
  if (!ready) return;

  reflectTimer = setTimeout(reflectNow, REFLECT_AFTER_MS);
}

async function reflectNow() {
  const text = el("entry").value.trim();
  if (busy || !openDate || text.length < REFLECT_MIN_CHARS || text === reflectedText) return;

  busy = true;
  clearTimeout(reflectTimer);
  el("reflect-cta").hidden = true;
  el("reflect-hint").hidden = true;
  el("thinking").hidden = false;
  try {
    await save();
    const { reflection } = await api(`/api/entries/${openDate}/reflect`, { method: "POST" });
    reflectedText = text;
    showReflection(reflection);
  } catch (error) {
    el("thinking").hidden = true;
    el("reflect-hint").hidden = true;
    el("reflect-failed").textContent = error.message;
    el("reflect-cta").hidden = false;
    console.error("reflection failed:", error.message);
    toast(error.message);
  } finally {
    busy = false;
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
      el("say").hidden = true;
      reflectedText = null;
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
    row.querySelector(".day__tag").textContent = e.reflection ? "Daybook replied" : "";
    row.addEventListener("click", () => { showPane("entry"); openEntry(e.date); });
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
  el("insights-error").hidden = true;
  el("insights-empty").hidden = true;
  el("insights-report").hidden = true;
  el("insights-loading").hidden = false;

  try {
    const { insights } = await api(refresh ? "/api/insights?refresh=true" : "/api/insights");
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

el("entry").addEventListener("input", () => {
  autosize();
  queueSave();
  queueReflection();
});

// Leaving the box says you have finished, so read it now rather than
// counting down again.
el("entry").addEventListener("blur", () => {
  save();
  clearTimeout(reflectTimer);
  reflectNow();
});

el("reflect").addEventListener("click", reflectNow);

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
