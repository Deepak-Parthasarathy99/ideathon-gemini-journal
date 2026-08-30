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

const views = {
  signin: el("view-signin"),
  chat: el("view-chat"),
  insights: el("view-insights"),
};
const log = el("log");
const empty = el("empty");
const composer = el("composer");
const messageBox = el("message");
const sendBtn = el("send");

let auth = null;
let busy = false;

// ---------------------------------------------------------------- helpers

function show(view) {
  views.signin.dataset.active = String(view === "signin");
  views.chat.dataset.active = String(view === "chat");
  views.insights.dataset.active = String(view === "insights");
  for (const [id, active] of [
    ["tab-journal", view === "chat"],
    ["tab-insights", view === "insights"],
  ]) {
    el(id).dataset.active = String(active);
    el(id).setAttribute("aria-selected", String(active));
  }
}

let snackTimer;
function toast(text) {
  el("snackbar-text").textContent = text;
  el("snackbar").dataset.open = "true";
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => {
    el("snackbar").dataset.open = "false";
  }, 5000);
}

function bubble(role, text) {
  empty.hidden = true;
  const div = document.createElement("div");
  div.className = `bubble bubble--${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function typingBubble() {
  empty.hidden = true;
  const div = document.createElement("div");
  div.className = "bubble bubble--assistant bubble--typing";
  div.innerHTML = "<i></i><i></i><i></i>";
  div.setAttribute("aria-label", "Assistant is typing");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
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
      show("signin");
      el("account").hidden = true;
      el("tabs").hidden = true;
      return;
    }

    show("chat");
    el("account").hidden = false;
    el("tabs").hidden = false;

    const avatar = el("avatar");
    avatar.textContent = (user.displayName || user.email || "?")
      .trim()
      .charAt(0)
      .toUpperCase();

    try {
      await api("/api/me");
      const { messages } = await api("/api/messages");
      log.querySelectorAll(".bubble").forEach((b) => b.remove());
      messages.forEach((m) => bubble(m.role === "user" ? "user" : "assistant", m.text));
      empty.hidden = messages.length > 0;
    } catch (error) {
      toast(error.message);
      return;
    }

    // The zero-blank-page opener: Echo speaks first, from memory.
    try {
      const { opener } = await api("/api/opener");
      const div = bubble("assistant", opener);
      div.classList.add("bubble--opener");
    } catch {
      // A missing opener should never block the journal itself.
    }
  });
}

// --------------------------------------------------------------- insights

let insightsLoaded = false;

function renderInsights(report) {
  el("insights-meta").textContent =
    `Read from your last ${report.entry_count} entries.`;

  const themes = el("insights-themes");
  themes.innerHTML = "";
  (report.themes || []).forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "insights__chip";
    chip.textContent = t;
    themes.appendChild(chip);
  });

  el("insights-mood").textContent = report.mood_arc;
  el("insights-observation").textContent = report.observation;
  el("insights-suggestion").textContent = report.suggestion;
}

async function loadInsights(refresh = false) {
  el("insights-empty").hidden = true;
  el("insights-error").hidden = true;
  el("insights-report").hidden = true;
  el("insights-loading").hidden = false;

  try {
    const path = refresh ? "/api/insights?refresh=true" : "/api/insights";
    const { insights } = await api(path);
    el("insights-loading").hidden = true;

    // No report and no error means there simply isn't enough written yet.
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

el("tab-journal").addEventListener("click", () => show("chat"));
el("tab-insights").addEventListener("click", () => {
  show("insights");
  if (!insightsLoaded) loadInsights();
});
el("insights-refresh").addEventListener("click", () => loadInsights(true));
el("insights-retry").addEventListener("click", () => loadInsights(true));

// ---------------------------------------------------------------- actions

el("signin").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    if (error.code !== "auth/popup-closed-by-user") {
      toast("Sign-in didn't complete. Try again.");
    }
  }
});

el("signout").addEventListener("click", () => signOut(auth));

el("clear").addEventListener("click", async () => {
  try {
    await api("/api/messages", { method: "DELETE" });
    log.querySelectorAll(".bubble").forEach((b) => b.remove());
    empty.hidden = false;
    insightsLoaded = false;
  } catch (error) {
    toast(error.message);
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageBox.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  messageBox.value = "";
  messageBox.style.height = "auto";

  bubble("user", text);
  const typing = typingBubble();

  try {
    const { reply } = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: text }),
    });
    typing.remove();
    bubble("assistant", reply);
  } catch (error) {
    typing.remove();
    bubble("error", error.message);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    messageBox.focus();
  }
});

// Enter sends, Shift+Enter makes a new line.
messageBox.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

// Grow the box with the text.
messageBox.addEventListener("input", () => {
  messageBox.style.height = "auto";
  messageBox.style.height = `${Math.min(messageBox.scrollHeight, 160)}px`;
});

start();
