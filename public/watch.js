/* Watch Together — synchronized playback + WebRTC calls over the same server. */
const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  selfId: null,
  room: null,
  members: [],
  playback: { mediaId: null, isPlaying: false, position: 0, updatedAt: 0, seq: 0 },
  clockOffset: 0,
  ws: null,
  closing: false,
  applying: false,
  dragging: false,
  mediaId: null,
  peers: new Map(),
  localStream: null,
  inCall: false,
};

const ICE_SERVERS = (() => {
  const base = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const extra = JSON.parse(localStorage.getItem("wt.turn") || "null");
    if (extra) return [...base, ...(Array.isArray(extra) ? extra : [extra])];
  } catch {
    /* ignore malformed config */
  }
  return base;
})();

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const init = { method: options.method || "GET", credentials: "include", headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
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
  const data = (res.headers.get("content-type") || "").includes("application/json") ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

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

function openModal(build) {
  const back = el("div", { class: "modal-back", role: "dialog", "aria-modal": "true" });
  const modal = el("div", { class: "modal" });
  back.appendChild(modal);
  const close = () => back.remove();
  back.addEventListener("mousedown", (e) => e.target === back && close());
  document.addEventListener("keydown", (e) => e.key === "Escape" && close(), { once: true });
  build(modal, close);
  $("modal-root").appendChild(back);
  return close;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setStatus(text, kind = "") {
  const node = $("wt-status");
  node.textContent = text;
  node.className = `wt-status ${kind}`;
}

function badge(text) {
  const node = $("wt-badge");
  if (!text) {
    node.classList.add("hidden");
    return;
  }
  node.textContent = text;
  node.classList.remove("hidden");
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
  } catch {
    $("wt-gate").classList.remove("hidden");
    return;
  }
  $("wt-app").classList.remove("hidden");
  $("who").textContent = state.user.username || "";

  const room = (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
  if (room) enterRoom(room);
  else showLobby();
}

// ---------------------------------------------------------------- lobby

function showLobby() {
  $("wt-lobby").classList.remove("hidden");
  $("wt-room").classList.add("hidden");
  $("wt-pick").appendChild(el("p", { class: "hint", text: "Loading…" }));
  loadPicker();
  loadOpenRooms();

  $("wt-join").onclick = () => {
    const code = $("wt-code").value.trim().toUpperCase();
    if (!code) return toast("Enter a room code", "err");
    location.href = `/watch.html?room=${encodeURIComponent(code)}`;
  };
  $("wt-code").addEventListener("keydown", (e) => e.key === "Enter" && $("wt-join").click());
}

async function loadPicker() {
  const host = $("wt-pick");
  try {
    const res = await api("/api/media?category=video&sort=date_desc&limit=30");
    const items = res.items || [];
    host.replaceChildren();
    if (!items.length) {
      host.appendChild(el("p", { class: "hint", text: "No videos in your vault yet. Upload one from the Library." }));
      return;
    }
    for (const item of items) {
      host.appendChild(
        el("button", {
          class: "wt-pick-item",
          type: "button",
          text: item.name,
          onclick: () => createRoomWith(item.id),
        }),
      );
    }
  } catch (err) {
    host.replaceChildren(el("p", { class: "hint", text: err.message }));
  }
}

async function loadOpenRooms() {
  const host = $("wt-open");
  try {
    const res = await api("/api/rooms");
    const rooms = res.rooms || [];
    host.replaceChildren();
    if (!rooms.length) {
      host.appendChild(el("p", { class: "hint", text: "No rooms open right now." }));
      return;
    }
    for (const room of rooms) {
      host.appendChild(
        el("button", {
          class: "wt-pick-item",
          type: "button",
          text: `${room.id} — ${room.members.length} watching`,
          onclick: () => (location.href = `/watch.html?room=${encodeURIComponent(room.id)}`),
        }),
      );
    }
  } catch (err) {
    host.replaceChildren(el("p", { class: "hint", text: err.message }));
  }
}

async function createRoomWith(mediaId) {
  try {
    const res = await api("/api/rooms", { method: "POST", body: { mediaId } });
    location.href = `/watch.html?room=${encodeURIComponent(res.id)}`;
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------------------------------------------------------------- room

function enterRoom(code) {
  state.room = code;
  $("wt-lobby").classList.add("hidden");
  $("wt-room").classList.remove("hidden");
  $("wt-link").textContent = `/watch.html?room=${code}`;
  wireControls();
  connect();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  setStatus("connecting…");
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(state.room)}`);
  state.ws = ws;
  ws.onopen = () => setStatus("in room", "ok");
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (state.closing) return;
    setStatus("reconnecting…", "warn");
    setTimeout(() => !state.closing && connect(), 1500);
  };
  ws.onerror = () => setStatus("connection error", "warn");
}

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
}

function serverNow() {
  return Date.now() + state.clockOffset;
}

function handleMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.selfId = msg.selfId;
      state.clockOffset = msg.serverTime - Date.now();
      state.members = msg.members;
      renderMembers();
      applyPlayback(msg.playback, true);
      break;
    case "peer:join":
      state.members = [...state.members.filter((m) => m.id !== msg.member.id), msg.member];
      renderMembers();
      if (state.inCall) ensurePeer(msg.member.id);
      toast(`${msg.member.username} joined`);
      break;
    case "peer:leave":
      state.members = state.members.filter((m) => m.id !== msg.memberId);
      renderMembers();
      dropPeer(msg.memberId);
      break;
    case "media":
      applyPlayback(msg.playback, true);
      break;
    case "playback":
      applyPlayback(msg.playback, false);
      break;
    case "signal":
      handleSignal(msg.from, msg.data);
      break;
    default:
      break;
  }
}

function renderMembers() {
  const list = $("wt-members");
  list.replaceChildren();
  for (const member of state.members) {
    const you = member.id === state.selfId;
    const calling = state.peers.has(member.id) && state.peers.get(member.id).hasRemote;
    list.appendChild(
      el("li", {}, [
        el("span", { class: `wt-dot ${calling ? "live" : ""}` }),
        el("span", { text: member.username }),
        you ? el("span", { class: "wt-you", text: "you" }) : null,
      ]),
    );
  }
}

// ---------------------------------------------------------------- playback

function applyPlayback(pb, initial) {
  state.playback = pb;
  if (pb.mediaId !== state.mediaId) loadMedia(pb.mediaId);
  const video = $("wt-video");
  const target = pb.isPlaying ? pb.position + Math.max(0, serverNow() - pb.updatedAt) / 1000 : pb.position;

  state.applying = true;
  if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.75) video.currentTime = target;
  if (pb.isPlaying) {
    if (video.paused) video.play().catch(() => badge("Press play to rejoin the stream"));
  } else if (!video.paused) {
    video.pause();
  }
  setTimeout(() => (state.applying = false), 0);
  updatePlayButton();
}

function loadMedia(mediaId) {
  state.mediaId = mediaId;
  const video = $("wt-video");
  const empty = $("wt-empty");
  if (!mediaId) {
    video.removeAttribute("src");
    video.load();
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  video.src = `/api/media/${encodeURIComponent(mediaId)}/stream`;
  video.addEventListener(
    "loadedmetadata",
    () => {
      const pb = state.playback;
      const target = pb.isPlaying ? pb.position + Math.max(0, serverNow() - pb.updatedAt) / 1000 : pb.position;
      if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.75) video.currentTime = target;
      if (pb.isPlaying) video.play().catch(() => badge("Press play to start"));
    },
    { once: true },
  );
  video.addEventListener(
    "error",
    () => badge("This browser cannot play this file — try another in the vault."),
    { once: true },
  );
}

function wireControls() {
  const video = $("wt-video");
  const seek = $("wt-seek");

  $("wt-play").onclick = () => (video.paused ? video.play().catch(() => {}) : video.pause());

  video.onplay = () => {
    if (!state.applying) send({ type: "playback", isPlaying: true, position: video.currentTime });
    updatePlayButton();
  };
  video.onpause = () => {
    if (!state.applying) send({ type: "playback", isPlaying: false, position: video.currentTime });
    updatePlayButton();
  };
  video.onseeked = () => {
    if (!state.applying) send({ type: "playback", position: video.currentTime });
  };
  video.ontimeupdate = () => {
    if (state.dragging) return;
    const dur = video.duration || 0;
    seek.value = dur ? String(Math.round((video.currentTime / dur) * 1000)) : "0";
    $("wt-time").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
  };
  seek.addEventListener("input", () => {
    state.dragging = true;
    const dur = video.duration || 0;
    $("wt-time").textContent = `${fmtTime((Number(seek.value) / 1000) * dur)} / ${fmtTime(dur)}`;
  });
  seek.addEventListener("change", () => {
    state.dragging = false;
    const dur = video.duration || 0;
    if (dur) video.currentTime = (Number(seek.value) / 1000) * dur;
  });

  $("wt-load").onclick = openPicker;
  $("wt-load-2").onclick = openPicker;
  $("wt-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/watch.html?room=${state.room}`);
      toast("Room link copied", "ok");
    } catch {
      toast("Copy failed — use the code shown below");
    }
  };
  $("wt-call-btn").onclick = () => (state.inCall ? leaveCall() : joinCall());
}

function updatePlayButton() {
  $("wt-play").textContent = $("wt-video").paused ? "Play" : "Pause";
}

async function openPicker() {
  try {
    const res = await api("/api/media?category=video&sort=date_desc&limit=50");
    const items = res.items || [];
    openModal((modal, close) => {
      modal.appendChild(
        el("header", {}, [
          el("h2", { text: "Load a file for everyone" }),
          el("button", { class: "linkish", type: "button", onclick: close, text: "Close" }),
        ]),
      );
      const body = el("div", { class: "content wt-pick modal-pick" });
      if (!items.length) body.appendChild(el("p", { class: "hint", text: "No videos in your vault yet." }));
      for (const item of items) {
        body.appendChild(
          el("button", {
            class: "wt-pick-item",
            type: "button",
            text: item.name,
            onclick: () => {
              send({ type: "media", mediaId: item.id });
              close();
            },
          }),
        );
      }
      modal.appendChild(body);
    });
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------------------------------------------------------------- WebRTC

async function joinCall() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    toast("Camera/microphone permission denied", "err");
    return;
  }
  state.inCall = true;
  $("wt-local").srcObject = state.localStream;
  $("wt-local").play().catch(() => {});
  $("wt-call-btn").textContent = "Leave call";
  for (const member of state.members) if (member.id !== state.selfId) ensurePeer(member.id);
  badge("");
}

function leaveCall() {
  state.inCall = false;
  $("wt-call-btn").textContent = "Join call";
  $("wt-local").srcObject = null;
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) track.stop();
    state.localStream = null;
  }
  for (const id of [...state.peers.keys()]) dropPeer(id);
  renderMembers();
}

function ensurePeer(peerId) {
  if (peerId === state.selfId) return null;
  let peer = state.peers.get(peerId);
  if (peer) return peer;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer = { pc, makingOffer: false, hasRemote: false };
  state.peers.set(peerId, peer);

  if (state.localStream) for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "signal", to: peerId, data: { candidate: e.candidate } });
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: "signal", to: peerId, data: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn("negotiation failed", err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.ontrack = (e) => attachRemote(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      peer.hasRemote = true;
      renderMembers();
    }
  };
  return peer;
}

function dropPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  try {
    peer.pc.close();
  } catch {
    /* already closed */
  }
  state.peers.delete(peerId);
  const tile = $(`tile-${peerId}`);
  if (tile) tile.remove();
  renderMembers();
}

async function handleSignal(from, data) {
  const peer = ensurePeer(from);
  if (!peer) return;
  const { pc } = peer;
  const polite = state.selfId < from;

  try {
    if (data.sdp) {
      const offerCollision = data.sdp.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      if (!polite && offerCollision) return;
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription();
        send({ type: "signal", to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.warn("signal handling failed", err);
  }
}

function attachRemote(peerId, stream) {
  const container = $("wt-remotes");
  let tile = $(`tile-${peerId}`);
  if (!tile) {
    const video = el("video", { class: "wt-tile", autoplay: true, playsinline: true });
    video.id = `video-${peerId}`;
    const member = state.members.find((m) => m.id === peerId);
    tile = el("div", { class: "wt-tilewrap" }, [
      video,
      el("span", { class: "wt-tilelabel", text: member ? member.username : "guest" }),
    ]);
    tile.id = `tile-${peerId}`;
    container.appendChild(tile);
  }
  const video = $(`video-${peerId}`);
  if (video.srcObject !== stream) video.srcObject = stream;
  video.play().catch(() => badge("Tap the call tile to hear audio"));
  container.onclick = () => {
    for (const v of container.querySelectorAll("video")) v.play().catch(() => {});
    badge("");
  };
}

window.addEventListener("beforeunload", () => {
  state.closing = true;
  if (state.ws) state.ws.close();
});

boot();
