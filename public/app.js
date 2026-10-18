/* Media Vault — client. Talks only to this server's authenticated API. */
const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  media: [],
  total: 0,
  view: localStorage.getItem("mv.view") || "grid",
  q: "",
  category: "",
  sort: "date_desc",
  telegram: null,
  queue: new Map(),
  wizard: { loginId: null, step: 1, passwordNeeded: false },
  online: navigator.onLine,
};

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    credentials: "include",
    headers: { ...(options.headers || {}) },
  };
  if (options.raw !== undefined) {
    init.body = options.raw;
  } else if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Network error — check your connection");
  }
  if (res.status === 204) return {};
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- ui helpers

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  $("toasts").appendChild(node);
  setTimeout(() => node.remove(), 5200);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortMime(m) {
  return (m || "").split("/").pop();
}

// ---------------------------------------------------------------- modal

function openModal(build) {
  const back = el("div", { class: "modal-back", role: "dialog", "aria-modal": "true" });
  const modal = el("div", { class: "modal" });
  back.appendChild(modal);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") close();
    },
    { once: true },
  );
  build(modal, close);
  $("modal-root").appendChild(back);
  const focusable = modal.querySelector("button, input, [href]");
  if (focusable) focusable.focus();
  return close;
}

// ---------------------------------------------------------------- auth screens

function showLogin(message) {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-error").textContent = message || "";
}

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    $("who").textContent = me.user.username;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    await Promise.all([loadTelegram(), loadMedia()]);
    connectEvents();
  } catch (err) {
    showLogin(err.status === 401 ? "" : err.message);
  }
}

// ---------------------------------------------------------------- telegram setup

async function loadTelegram() {
  state.telegram = await api("/api/telegram/status").catch(() => null);
  renderStorage();
  const ready = state.telegram?.authorized && state.telegram?.channel?.set;
  $("library").classList.toggle("hidden", !ready);
  $("wizard").classList.toggle("hidden", Boolean(ready));
  if (!ready) showWizardStep(state.telegram?.authorized ? 3 : 1);
}

function renderStorage() {
  const t = state.telegram;
  const strip = $("strip");
  if (!t) {
    strip.className = "strip err";
    strip.textContent = "Telegram status unavailable.";
    strip.classList.remove("hidden");
    $("storage-line").textContent = "Telegram-backed storage";
    return;
  }
  if (!state.online) {
    strip.className = "strip err";
    strip.innerHTML = "";
    strip.append(el("span", { class: "dot off" }), el("span", { class: "grow", text: "You are offline. Uploads are paused until the connection returns." }));
    strip.classList.remove("hidden");
    return;
  }
  if (t.authorized && t.channel.set) {
    strip.classList.add("hidden");
    $("storage-line").textContent = `Storage: ${t.channel.title || "channel"}`;
  } else {
    strip.className = "strip warn";
    strip.innerHTML = "";
    const msg = !t.authorized
      ? "Telegram is not connected yet. Media cannot be stored."
      : "No storage channel is set yet.";
    strip.append(el("span", { class: "dot off" }), el("span", { class: "grow", text: msg }));
    strip.classList.remove("hidden");
  }
}

function showWizardStep(step) {
  state.wizard.step = step;
  $("wizard-step-1").classList.toggle("hidden", step !== 1);
  $("wizard-step-2").classList.toggle("hidden", step !== 2);
  $("wizard-step-3").classList.toggle("hidden", step !== 3);
  const labels = { 1: "Step 1 of 3 — Phone & credentials", 2: "Step 2 of 3 — Verify code", 3: "Step 3 of 3 — Storage channel" };
  $("wizard-steps").textContent = labels[step];
  $("wizard-error").textContent = "";
}

function wizardError(err) {
  $("wizard-error").textContent = err.message || String(err);
}

async function tgStart() {
  const phone = $("tg-phone").value.trim();
  if (!phone) return wizardError(new Error("Enter your phone number"));
  const apiId = $("tg-api-id").value.trim();
  const apiHash = $("tg-api-hash").value.trim();
  try {
    const body = { phone };
    if (apiId) body.apiId = Number(apiId);
    if (apiHash) body.apiHash = apiHash;
    const res = await api("/api/telegram/login/start", { method: "POST", body });
    state.wizard.loginId = res.loginId;
    showWizardStep(2);
  } catch (err) {
    wizardError(err);
  }
}

async function tgSubmit() {
  const code = $("tg-code").value.trim();
  const password = $("tg-password").value;
  try {
    if (state.wizard.passwordNeeded) {
      if (!password) throw new Error("Enter your two-step password");
      await api("/api/telegram/login/password", {
        method: "POST",
        body: { loginId: state.wizard.loginId, password },
      });
    } else {
      if (!code) throw new Error("Enter the login code");
      const res = await api("/api/telegram/login/code", {
        method: "POST",
        body: { loginId: state.wizard.loginId, code },
      });
      if (res.step === "awaiting_password") {
        state.wizard.passwordNeeded = true;
        $("tg-pw-field").classList.remove("hidden");
        $("wizard-error").textContent = "Two-step verification is enabled. Enter your password.";
        return;
      }
    }
    showWizardStep(3);
  } catch (err) {
    wizardError(err);
  }
}

async function tgChannelSave() {
  try {
    const channel = $("tg-channel").value.trim();
    await api("/api/telegram/channel", { method: "POST", body: channel ? { channel } : {} });
    toast("Telegram connected", "ok");
    state.wizard.passwordNeeded = false;
    await loadTelegram();
    if (state.telegram?.channel?.set) await loadMedia();
  } catch (err) {
    wizardError(err);
  }
}

// ---------------------------------------------------------------- library

async function loadMedia() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.category) params.set("category", state.category);
  params.set("sort", state.sort);
  $("library-body").innerHTML = "";
  $("library-body").appendChild(el("div", { class: "state", text: "Loading…" }));
  try {
    const res = await api(`/api/media?${params}`);
    state.media = res.items;
    state.total = res.total;
    renderMeta();
    renderMedia();
  } catch (err) {
    $("library-body").innerHTML = "";
    $("library-body").appendChild(
      el("div", { class: "state" }, [
        el("h2", { text: "Could not load the library" }),
        el("p", { text: err.message }),
        el("button", { class: "btn", onclick: loadMedia, text: "Retry" }),
      ]),
    );
  }
}

function renderMeta() {
  const t = state.telegram;
  const where = t?.channel?.set ? `stored in Telegram${t.channel.title ? ` · ${t.channel.title}` : ""}` : "not connected";
  $("meta-line").textContent = `${state.total} item${state.total === 1 ? "" : "s"} · ${where}`;
}

function renderMedia() {
  const body = $("library-body");
  body.innerHTML = "";
  if (state.media.length === 0) {
    body.appendChild(
      el("div", { class: "state" }, [
        el("h2", { text: state.q || state.category ? "Nothing matches" : "No media yet" }),
        el(
          "p",
          { text: state.q || state.category ? "Try a different search or filter." : "Drop a file above, or choose one from your device." },
        ),
      ]),
    );
    return;
  }
  const container = el("div", { class: state.view === "grid" ? "grid" : "list" });
  for (const m of state.media) container.appendChild(state.view === "grid" ? card(m) : row(m));
  body.appendChild(container);
}

function card(m) {
  const isVideo = m.category === "video";
  const thumb = el("div", { class: "thumb" }, [
    el("span", { class: "kind", text: m.category }),
    el("span", { text: isVideo ? "video" : shortMime(m.mime) }),
  ]);
  return el("article", { class: "card" }, [
    thumb,
    el("div", { class: "body" }, [
      el("div", { class: "name", text: m.name }),
      el("div", { class: "sub" }, [el("span", { text: fmtBytes(m.size) }), el("span", { text: fmtDate(m.uploadedAt) })]),
      el("div", { class: "actions" }, actions(m)),
    ]),
  ]);
}

function row(m) {
  return el("div", { class: "row" }, [
    el("div", {}, [
      el("div", { class: "name", text: m.name }),
      el("div", { class: "sub", text: `${m.category} · ${fmtBytes(m.size)} · ${fmtDate(m.uploadedAt)}` }),
    ]),
    el("div", { class: "sub", text: shortMime(m.mime) }),
    el("div", { class: "actions" }, actions(m)),
  ]);
}

function actions(m) {
  const isVideo = m.category === "video";
  return [
    isVideo
      ? el("button", { class: "btn small", type: "button", onclick: () => preview(m), text: "Preview" })
      : el("a", { class: "btn small", href: `/api/media/${m.id}/stream`, text: "Open" }),
    isVideo
      ? el("button", { class: "btn small", type: "button", onclick: () => playInWatchTogether(m), text: "Play in Watch Together" })
      : null,
    el("button", { class: "btn small", type: "button", onclick: () => rename(m), text: "Rename" }),
    el("button", { class: "btn small danger", type: "button", onclick: () => confirmDelete(m), text: "Delete" }),
  ];
}

function preview(m) {
  openModal((modal, close) => {
    modal.appendChild(
      el("header", {}, [
        el("h2", { text: m.name }),
        el("button", { class: "linkish", type: "button", onclick: close, text: "Close" }),
      ]),
    );
    const video = el("video", { controls: true, playsinline: true, preload: "metadata" });
    video.src = `/api/media/${m.id}/stream`;
    const content = el("div", { class: "content" }, [
      video,
      el("p", { class: "kv", text: `${fmtBytes(m.size)} · ${m.mime} · ${fmtDate(m.uploadedAt)}` }),
      el("div", { class: "row" }, [
        el("button", { class: "btn", type: "button", onclick: () => playInWatchTogether(m), text: "Play in Watch Together" }),
      ]),
    ]);
    modal.appendChild(content);
    video.addEventListener("error", () => {
      content.insertBefore(
        el("p", { class: "state", style: "padding:16px", text: "This browser cannot play this file. Format or codec may be unsupported — try the Open/download link instead." }),
        content.firstChild,
      );
    });
  });
}

async function playInWatchTogether(m) {
  try {
    const room = await api("/api/rooms", { method: "POST", body: { mediaId: m.id } });
    const link = new URL(`/watch.html?room=${room.id}`, location.origin).toString();
    openModal((modal, close) => {
      modal.appendChild(
        el("header", {}, [el("h2", { text: "Play in Watch Together" }), el("button", { class: "linkish", type: "button", onclick: close, text: "Close" })]),
      );
      const input = el("input", { value: link, readonly: true });
      input.style.width = "100%";
      input.style.background = "var(--ink-950)";
      input.style.border = "1px solid var(--line)";
      input.style.borderRadius = "5px";
      input.style.padding = "10px";
      input.style.fontFamily = "var(--font-mono)";
      input.style.fontSize = "12px";
      modal.appendChild(
        el("div", { class: "content" }, [
          el("p", { text: `Room ${room.id} is open with “${m.name}”. Send the link to the other person — playback stays in sync and you can start a call from the room.` }),
          input,
          el("div", { class: "row" }, [
            el("button", { class: "btn primary", type: "button", text: "Open room", onclick: () => (location.href = link) }),
            el("button", {
              class: "btn",
              type: "button",
              text: "Copy link",
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  toast("Room link copied", "ok");
                } catch {
                  input.select();
                  toast("Copy failed — select and copy the field");
                }
              },
            }),
          ]),
          el("p", { class: "kv", text: "Both people sign in to this server, then open the same room." }),
        ]),
      );
    });
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "watch-together:load-media", media: m, roomId: room.id, roomUrl: link }, "*");
    }
  } catch (err) {
    toast(err.message, "err");
  }
}

function rename(m) {
  openModal((modal, close) => {
    const input = el("input", { value: m.name });
    input.style.width = "100%";
    input.className = "btn";
    modal.appendChild(el("header", {}, [el("h2", { text: "Rename" }), el("button", { class: "linkish", type: "button", onclick: close, text: "Close" })]));
    modal.appendChild(
      el("div", { class: "content" }, [
        input,
        el("div", { class: "row" }, [
          el("button", {
            class: "btn primary",
            type: "button",
            text: "Save",
            onclick: async () => {
              try {
                await api(`/api/media/${m.id}`, { method: "PATCH", body: { name: input.value } });
                close();
                await loadMedia();
                toast("Renamed", "ok");
              } catch (err) {
                toast(err.message, "err");
              }
            },
          }),
        ]),
      ]),
    );
  });
}

function confirmDelete(m) {
  openModal((modal, close) => {
    modal.appendChild(el("header", {}, [el("h2", { text: "Delete media" }), el("button", { class: "linkish", type: "button", onclick: close, text: "Close" })]));
    const removeEverywhere = el("button", {
      class: "btn danger",
      type: "button",
      text: "Delete file and entry",
      onclick: async () => {
        try {
          const res = await api(`/api/media/${m.id}`, { method: "DELETE" });
          close();
          await loadMedia();
          toast(res.telegramDeleted ? "Deleted from Telegram and library" : "Removed from library", "ok");
        } catch (err) {
          toast(err.message, "err");
        }
      },
    });
    const removeLocal = el("button", {
      class: "btn",
      type: "button",
      text: "Remove library entry only",
      onclick: async () => {
        try {
          await api(`/api/media/${m.id}?telegram=false`, { method: "DELETE" });
          close();
          await loadMedia();
          toast("Entry removed; the Telegram file was kept", "ok");
        } catch (err) {
          toast(err.message, "err");
        }
      },
    });
    modal.appendChild(
      el("div", { class: "content" }, [
        el("p", { text: `“${m.name}” — ${fmtBytes(m.size)}.` }),
        el("p", { text: "Delete file and entry permanently deletes the file from your Telegram channel (the message is revoked). Remove library entry only keeps the file in Telegram and forgets it here." }),
        el("div", { class: "row" }, [removeEverywhere, removeLocal]),
      ]),
    );
  });
}

// ---------------------------------------------------------------- uploads

function connectEvents() {
  const source = new EventSource("/api/uploads/events");
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "hello") {
      for (const record of payload.records || []) state.queue.set(record.id, decorate(record));
    } else if (payload.record) {
      state.queue.set(payload.record.id, decorate(payload.record, payload.message));
      if (payload.type === "done") loadMedia();
      if (payload.type === "retry" && payload.message) toast(payload.message);
    }
    renderQueue();
  };
  source.onerror = () => {
    /* EventSource reconnects on its own */
  };
}

function decorate(record, message) {
  return { ...record, message: message || (record.status === "error" ? record.error : "") };
}

function ensureQueueVisible() {
  $("queue").classList.remove("hidden");
}

function renderQueue() {
  const entries = [...state.queue.values()];
  if (entries.length === 0) {
    $("queue").classList.add("hidden");
    return;
  }
  ensureQueueVisible();
  const body = $("queue-body");
  body.innerHTML = "";
  for (const u of entries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const pct = Math.round((u.progress || 0) * 100);
    const label =
      u.status === "uploading"
        ? `${pct}% sent`
        : u.status === "processing"
          ? "Storing in Telegram…"
          : u.status === "pending"
            ? "Queued"
            : u.status === "done"
              ? "Done"
              : u.status === "error"
                ? u.message || "Failed"
                : u.status;
    const row = el("div", { class: `qrow ${u.status === "error" ? "error" : u.status === "done" ? "done" : ""}` }, [
      el("div", { class: "qname", text: u.name }),
      el("div", { class: "qstate", text: label }),
      el("div", {}, [
        u.status === "error" || u.status === "pending"
          ? el("button", { class: "btn small", type: "button", text: "Retry", onclick: () => api(`/api/uploads/${u.id}/retry`, { method: "POST" }).catch((e) => toast(e.message, "err")) })
          : null,
        u.status === "done" || u.status === "cancelled"
          ? el("button", { class: "btn small", type: "button", text: "Dismiss", onclick: () => { state.queue.delete(u.id); renderQueue(); } })
          : el("button", { class: "btn small danger", type: "button", text: "Cancel", onclick: () => api(`/api/uploads/${u.id}`, { method: "DELETE" }).catch((e) => toast(e.message, "err")) }),
      ]),
      el("div", { class: "bar" }, [el("span", { style: `width:${pct}%` })]),
    ]);
    body.appendChild(row);
  }
}

async function handleFiles(files) {
  if (!state.online) {
    toast("You are offline", "err");
    return;
  }
  for (const file of files) {
    try {
      await uploadOne(file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, "err");
    }
  }
}

async function uploadOne(file) {
  const created = await api("/api/uploads", {
    method: "POST",
    body: { name: file.name, size: file.size, mime: file.type || "application/octet-stream" },
  });
  const { id, chunkSize, expectedChunks } = created;
  state.queue.set(id, {
    id,
    name: file.name,
    size: file.size,
    progress: 0,
    status: "uploading",
    createdAt: Date.now(),
  });
  renderQueue();

  for (let i = 0; i < expectedChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    await api(`/api/uploads/${id}/chunk/${i}`, {
      method: "PUT",
      raw: file.slice(start, end),
      headers: { "Content-Type": "application/octet-stream" },
    });
    const current = state.queue.get(id);
    if (!current || current.status === "cancelled") return;
    current.progress = end / file.size;
    renderQueue();
  }

  await api(`/api/uploads/${id}/complete`, { method: "POST" });
  const current = state.queue.get(id);
  if (current) current.status = "pending";
  renderQueue();
}

// ---------------------------------------------------------------- sessions

async function openSessions() {
  const { sessions } = await api("/api/auth/sessions");
  openModal((modal, close) => {
    modal.appendChild(el("header", {}, [el("h2", { text: "Active sessions" }), el("button", { class: "linkish", type: "button", onclick: close, text: "Close" })]));
    const content = el("div", { class: "content" });
    for (const s of sessions) {
      content.appendChild(
        el("div", { class: "list" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { text: s.id === state.sessionId ? "This device" : "Signed-in device" }),
              el("div", { class: "sub", text: s.user_agent || "unknown client" }),
            ]),
            el("div", { class: "sub", text: `expires ${fmtDate(s.expires_at)}` }),
            el("button", {
              class: "btn small danger",
              type: "button",
              text: "Revoke",
              onclick: async () => {
                await api(`/api/auth/sessions/${s.id}`, { method: "DELETE" });
                close();
                toast("Session revoked", "ok");
              },
            }),
          ]),
        ]),
      );
    }
    content.appendChild(
      el("div", { class: "row" }, [
        el("button", {
          class: "btn danger",
          type: "button",
          text: "Sign out everywhere",
          onclick: async () => {
            await api("/api/auth/logout-all", { method: "POST" });
            location.reload();
          },
        }),
      ]),
    );
    modal.appendChild(content);
  });
}

// ---------------------------------------------------------------- wiring

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: { username: $("username").value, password: $("password").value },
    });
    $("password").value = "";
    await boot();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

$("sessions-btn").addEventListener("click", () => openSessions().catch((e) => toast(e.message, "err")));

$("tg-start").addEventListener("click", tgStart);
$("tg-submit").addEventListener("click", tgSubmit);
$("tg-channel-save").addEventListener("click", tgChannelSave);

$("choose-btn").addEventListener("click", () => $("file-input").click());
$("drop-choose").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  handleFiles([...e.target.files]);
  e.target.value = "";
});

const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
  }),
);
drop.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files]));

$("search-input").addEventListener(
  "input",
  debounce((e) => {
    state.q = e.target.value.trim();
    loadMedia();
  }, 250),
);
$("category").addEventListener("change", (e) => {
  state.category = e.target.value;
  loadMedia();
});
$("sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  loadMedia();
});
$("view-grid").addEventListener("click", () => setView("grid"));
$("view-list").addEventListener("click", () => setView("list"));

function setView(view) {
  state.view = view;
  localStorage.setItem("mv.view", view);
  $("view-grid").setAttribute("aria-pressed", String(view === "grid"));
  $("view-list").setAttribute("aria-pressed", String(view === "list"));
  renderMedia();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

window.addEventListener("online", () => {
  state.online = true;
  toast("Back online", "ok");
  renderStorage();
  loadMedia();
});
window.addEventListener("offline", () => {
  state.online = false;
  renderStorage();
});

setView(state.view);
boot();
