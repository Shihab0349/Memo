(function () {
  "use strict";

  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_REC = 300;

  let localKeys = [], myKey = null;
  let initFor = null, retryAt = 0, channel = null;
  let other = null, chatOpen = false, firstLoad = true, sending = false;
  let msgs = [], plain = {}, keyCache = {}, secretCache = {};
  let unread = {};
  let pollTimer = null;
  let rendered = {}, seenEl = null;
  let pending = null, blobCache = {}, rec = null;

  /* ---------- styles and screen ---------- */
  const st = document.createElement("style");
  st.textContent =
    ".chatbox{height:48vh;overflow-y:auto;margin-top:12px;padding:2px}" +
    ".contact span.cbadge{margin-left:auto;background:var(--accent);color:#052e16;border-radius:10px;padding:2px 8px;font-weight:700;font-size:12px}" +
    ".chatbar{display:flex;gap:6px;align-items:flex-end;margin-top:10px}" +
    ".chatbar textarea{min-height:44px;height:44px;max-height:120px;min-width:0;flex:1;width:auto}" +
    ".chatbar button{flex:none}" +
    ".pendbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--inset);font-size:13px;word-break:break-all}" +
    ".bubble a{color:inherit;text-decoration:underline;word-break:break-all}" +
    ".bubble img.cimg{display:block;max-width:100%;max-height:300px;border-radius:8px;margin-top:6px}" +
    ".bubble video.cmedia{display:block;width:100%;max-height:320px;border-radius:8px;margin-top:6px;background:#000}" +
    ".bubble audio.cmedia{display:block;width:100%;margin-top:6px}" +
    ".bubble .fname{font-size:13px;word-break:break-all;margin-bottom:4px}" +
    ".bubble .mediaph{font-size:13px;opacity:.7;padding:8px 0}" +
    ".bubble .fileblk button{margin-top:6px}" +
    ".bubble.me button.sec{color:#052e16;border-color:#052e16}";
  document.head.appendChild(st);

  const card = document.createElement("div");
  card.className = "card hidden";
  card.id = "chat";
  card.innerHTML =
    '<div class="row">' +
    '<button class="sec tiny" id="chatBack">&larr; Back</button>' +
    '<div class="av" id="chatAv" style="width:40px;height:40px;font-size:16px"></div>' +
    '<div style="min-width:0"><b id="chatName" style="word-break:break-word"></b>' +
    '<div class="time" id="chatSub">&#128274; End-to-end encrypted</div></div></div>' +
    '<div class="chatbox" id="chatBox"></div>' +
    '<div class="pendbar hidden" id="pendBar"><span id="pendName"></span>' +
    '<button class="sec tiny" id="pendX">Remove</button></div>' +
    '<div class="chatbar">' +
    '<button class="sec small" id="attachBtn" title="Attach a file">&#128206;</button>' +
    '<input type="file" id="chatFile" class="hidden">' +
    '<textarea id="chatText" maxlength="2000" placeholder="Message"></textarea>' +
    '<button class="sec small" id="micBtn" title="Voice message">&#127908;</button>' +
    '<button class="small" id="chatSend">Send</button></div>' +
    '<div class="msg" id="chatMsg"></div>';
  document.body.appendChild(card);
  SCREENS.push("chat");

  /* ---------- helpers ---------- */
  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function safeName(n) {
    return String(n || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100) || "file";
  }
  function linkify(parent, text) {
    const re = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.href = m[1];
      a.textContent = m[1];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function saveBlob(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function validFile(f) {
    if (!f || typeof f !== "object") return null;
    if (typeof f.path !== "string" || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(f.path)) return null;
    if (typeof f.key !== "string" || f.key.length > 64) return null;
    let kind = ["image", "video", "audio", "voice", "file"].indexOf(f.kind) >= 0 ? f.kind : "file";
    const type = String(f.type || "application/octet-stream").slice(0, 100);
    const okType =
      (kind === "image" && type.indexOf("image/") === 0) ||
      (kind === "video" && type.indexOf("video/") === 0) ||
      ((kind === "audio" || kind === "voice") && type.indexOf("audio/") === 0);
    if (!okType) kind = "file";
    return { path: f.path, key: f.key, name: safeName(f.name), type: type, size: Number(f.size) || 0, kind: kind, dur: Number(f.dur) || 0 };
  }

  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("memo-keys", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction("keys").objectStore("keys").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction("keys", "readwrite");
      t.objectStore("keys").put(v, k);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  /* ---------- keys and crypto ---------- */
  async function ensureKey() {
    localKeys = (await idbGet("mk:" + me.id)) || [];
    if (localKeys.length) {
      const last = localKeys[localKeys.length - 1];
      const { data, error } = await sb.from("user_keys").select("id").eq("id", last.id).maybeSingle();
      if (error) throw error;
      if (data) { myKey = last; return; }
    }
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const { data, error } = await sb.from("user_keys").insert({ public_key: jwk }).select("id").single();
    if (error) throw error;
    myKey = { id: data.id, priv: kp.privateKey };
    localKeys.push(myKey);
    await idbSet("mk:" + me.id, localKeys);
  }

  async function latestKey(uid) {
    const { data } = await sb.from("user_keys").select("id, public_key")
      .eq("user_id", uid).order("created_at", { ascending: false }).limit(1);
    return data && data[0];
  }
  async function keyById(id) {
    if (keyCache[id]) return keyCache[id];
    const { data } = await sb.from("user_keys").select("id, public_key").eq("id", id).maybeSingle();
    if (data) keyCache[id] = data;
    return data;
  }
  async function secret(local, theirKey) {
    const ck = local.id + ":" + theirKey.id;
    if (secretCache[ck]) return secretCache[ck];
    const pub = await crypto.subtle.importKey("jwk", theirKey.public_key, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, local.priv, 256);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("memo-chat-v1") },
      hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    secretCache[ck] = aes;
    return aes;
  }
  async function encryptPayload(aes, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes,
      new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
  }
  async function decryptRow(row) {
    if (plain[row.id]) return plain[row.id];
    try {
      const mine = row.sender === me.id;
      const myKeyId = mine ? row.sender_key : row.recipient_key;
      const theirKeyId = mine ? row.recipient_key : row.sender_key;
      const local = localKeys.find((k) => k.id === myKeyId);
      if (!local) return { ok: false };
      const theirKey = await keyById(theirKeyId);
      if (!theirKey) return { ok: false };
      const aes = await secret(local, theirKey);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv) }, aes, unb64(row.ciphertext));
      const o = JSON.parse(new TextDecoder().decode(pt));
      const res = { ok: true, text: typeof o.t === "string" ? o.t : "", file: validFile(o.f) };
      plain[row.id] = res;
      return res;
    } catch (e) { return { ok: false }; }
  }

  /* ---------- files: encrypt, upload, download ---------- */
  async function uploadPending() {
    const p = pending;
    const buf = await p.blob.arrayBuffer();
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    const path = me.id + "/" + crypto.randomUUID();
    const { error } = await sb.storage.from("chatfiles").upload(
      path, new Blob([out], { type: "application/octet-stream" }), { contentType: "application/octet-stream" });
    if (error) throw new Error("Upload failed. Check your connection and try again.");
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    return { path: path, key: b64(raw), name: p.name, type: p.type, size: p.size, kind: p.kind, dur: p.dur || 0 };
  }

  async function fetchFile(m, f) {
    if (blobCache[m.id]) return blobCache[m.id];
    const { data, error } = await sb.storage.from("chatfiles").download(f.path);
    if (error || !data) throw new Error("download");
    const buf = new Uint8Array(await data.arrayBuffer());
    const key = await crypto.subtle.importKey("raw", unb64(f.key), "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
    const url = URL.createObjectURL(new Blob([pt], { type: f.type || "application/octet-stream" }));
    blobCache[m.id] = url;
    return url;
  }
  function revokeAll() {
    Object.keys(blobCache).forEach((k) => URL.revokeObjectURL(blobCache[k]));
    blobCache = {};
  }

  /* ---------- unread badges ---------- */
  async function refreshUnread() {
    if (!me) return;
    const { data } = await sb.rpc("chat_summary");
    unread = {};
    (data || []).forEach((r) => { unread[r.partner] = Number(r.unread); });
    decorate();
  }
  function decorate() {
    const rows = document.querySelectorAll("#contactList .contact");
    rows.forEach((row, i) => {
      const c = contacts[i];
      if (!c) return;
      const old = row.querySelector(".cbadge");
      if (old) old.remove();
      const n = unread[c.id] || 0;
      if (n > 0) {
        const b = document.createElement("span");
        b.className = "cbadge";
        b.textContent = n > 99 ? "99+" : String(n);
        row.appendChild(b);
      }
    });
  }
  const _loadContacts = loadContacts;
  loadContacts = async function () { await _loadContacts(); decorate(); };

  /* ---------- rendering ---------- */
  function saveBtn(url, name, label) {
    const b = el("button", "sec tiny", label || "Save");
    b.onclick = () => saveBlob(url, name);
    return b;
  }

  function fileBlock(m) {
    const f = m.file;
    const wrap = el("div", "fileblk");
    if (f.kind === "image") {
      const ph = el("div", "mediaph", "Loading image...");
      wrap.appendChild(ph);
      fetchFile(m, f).then((url) => {
        ph.remove();
        const img = el("img", "cimg");
        img.alt = "";
        img.src = url;
        wrap.appendChild(img);
        wrap.appendChild(saveBtn(url, f.name));
      }).catch(() => { ph.textContent = "This image could not be loaded."; });
    } else if (f.kind === "video" || f.kind === "audio" || f.kind === "voice") {
      if (f.kind !== "voice") wrap.appendChild(el("div", "fname", f.name));
      const label = f.kind === "video" ? "Load video" : f.kind === "audio" ? "Load audio" : "Play voice message";
      const extra = f.kind === "voice" && f.dur ? " (" + fmtDur(f.dur) + ")" : f.size ? " (" + fmtSize(f.size) + ")" : "";
      const btn = el("button", "sec tiny", "\u25B6 " + label + extra);
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Loading...";
        try {
          const url = await fetchFile(m, f);
          btn.remove();
          const node = el(f.kind === "video" ? "video" : "audio", "cmedia");
          node.controls = true;
          if (f.kind === "video") node.playsInline = true;
          node.src = url;
          wrap.appendChild(node);
          wrap.appendChild(saveBtn(url, f.name));
          node.play().catch(() => {});
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "Could not load. Tap to retry.";
        }
      };
      wrap.appendChild(btn);
    } else {
      wrap.appendChild(el("div", "fname", "\uD83D\uDCCE " + f.name + (f.size ? " (" + fmtSize(f.size) + ")" : "")));
      const btn = el("button", "sec tiny", "\u2B07 Download");
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Downloading...";
        try {
          const url = await fetchFile(m, f);
          saveBlob(url, f.name);
          btn.textContent = "\u2B07 Download again";
        } catch (e) { btn.textContent = "Could not download. Tap to retry."; }
        btn.disabled = false;
      };
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function buildBubble(m) {
    const mine = m.sender === me.id;
    const b = el("div", "bubble " + (mine ? "me" : "them"));
    b.appendChild(el("small", "", new Date(m.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
    if (!m.ok) {
      b.appendChild(document.createTextNode("\uD83D\uDD12 This message can't be opened on this device."));
      return b;
    }
    if (m.file) b.appendChild(fileBlock(m));
    if (m.text) {
      const t = el("div");
      if (m.file) t.style.marginTop = "6px";
      linkify(t, m.text);
      b.appendChild(t);
    }
    return b;
  }

  function renderMsgs() {
    const box = $("chatBox");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (seenEl && seenEl.parentNode) seenEl.remove();
    let added = false;
    msgs.forEach((m) => {
      if (rendered[m.id]) return;
      rendered[m.id] = true;
      box.appendChild(buildBubble(m));
      added = true;
    });
    const last = msgs[msgs.length - 1];
    if (last && last.sender === me.id && last.read_at) {
      if (!seenEl) { seenEl = el("div", "time", "Seen"); seenEl.style.textAlign = "right"; }
      box.appendChild(seenEl);
    }
    if (firstLoad || atBottom || (added && last && last.sender === me.id)) box.scrollTop = box.scrollHeight;
    firstLoad = false;
  }

  async function loadChat() {
    if (!other || !me) return;
    const f = "and(sender.eq." + me.id + ",recipient.eq." + other.id + "),and(sender.eq." + other.id + ",recipient.eq." + me.id + ")";
    const { data, error } = await sb.from("messages")
      .select("id, sender, recipient, sender_key, recipient_key, iv, ciphertext, created_at, read_at")
      .or(f).order("created_at", { ascending: false }).limit(200);
    if (error) return;
    const rows = (data || []).reverse();
    const out = [];
    for (const r of rows) {
      const d = await decryptRow(r);
      out.push(Object.assign({}, r, d));
    }
    msgs = out;
    renderMsgs();
    if (rows.some((r) => r.recipient === me.id && !r.read_at)) {
      await sb.rpc("mark_chat_read", { partner: other.id });
      refreshUnread();
    }
  }

  /* ---------- attachments and recording ---------- */
  function setPending(p) {
    pending = p;
    const label = p.kind === "voice"
      ? "\uD83C\uDFA4 Voice message (" + fmtDur(p.dur || 0) + ")"
      : "\uD83D\uDCCE " + p.name + " (" + fmtSize(p.size) + ")";
    $("pendName").textContent = label;
    $("pendBar").classList.remove("hidden");
  }
  function clearPending() {
    pending = null;
    $("pendBar").classList.add("hidden");
    $("pendName").textContent = "";
  }

  $("attachBtn").onclick = () => { if (!rec) $("chatFile").click(); };

  $("chatFile").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    msg("chatMsg", "");
    if (f.size > MAX_FILE) return msg("chatMsg", "That file is too large (max 25 MB).");
    let blob = f, type = f.type || "application/octet-stream", name = f.name || "file", kind = "file";
    if (type.indexOf("image/") === 0) {
      kind = "image";
      if (!/gif|svg/.test(type)) {
        try {
          blob = await resizeImage(f, 1600, false, 0.82);
          type = "image/jpeg";
          name = name.replace(/\.[^.]+$/, "") + ".jpg";
        } catch (err) { kind = "file"; blob = f; type = f.type || "application/octet-stream"; }
      }
    } else if (type.indexOf("video/") === 0) kind = "video";
    else if (type.indexOf("audio/") === 0) kind = "audio";
    setPending({ blob: blob, name: name, type: type, size: blob.size, kind: kind });
  };

  async function startRec() {
    if (rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return msg("chatMsg", "Voice recording is not supported on this browser.");
    msg("chatMsg", "");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      const mt = types.find((t) => MediaRecorder.isTypeSupported(t));
      const mr = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
      const r = { mr: mr, stream: stream, chunks: [], start: Date.now(), cancel: false, timer: null };
      rec = r;
      mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
      mr.onstop = () => finishRec(r);
      mr.start();
      clearPending();
      $("pendBar").classList.remove("hidden");
      $("pendName").textContent = "\u25CF Recording 0:00 (tap the mic to stop)";
      $("micBtn").textContent = "\u23F9";
      r.timer = setInterval(() => {
        const s = Math.floor((Date.now() - r.start) / 1000);
        $("pendName").textContent = "\u25CF Recording " + fmtDur(s) + " (tap the mic to stop)";
        if (s >= MAX_REC) stopRec(false);
      }, 500);
    } catch (e) { msg("chatMsg", "Microphone access was blocked."); }
  }
  function stopRec(cancel) {
    if (!rec) return;
    rec.cancel = !!cancel;
    try { rec.mr.stop(); } catch (e) { finishRec(rec); }
  }
  function finishRec(r) {
    if (rec === r) rec = null;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    $("micBtn").innerHTML = "&#127908;";
    if (r.cancel || !r.chunks.length) { clearPending(); return; }
    const type = String(r.mr.mimeType || r.chunks[0].type || "audio/webm").split(";")[0];
    const blob = new Blob(r.chunks, { type: type });
    const dur = Math.round((Date.now() - r.start) / 1000);
    const ext = type.indexOf("mp4") >= 0 ? "m4a" : type.indexOf("ogg") >= 0 ? "ogg" : "webm";
    setPending({ blob: blob, name: "voice-message." + ext, type: type, size: blob.size, kind: "voice", dur: dur });
  }
  $("micBtn").onclick = () => { if (rec) stopRec(false); else startRec(); };
  $("pendX").onclick = () => { if (rec) stopRec(true); else clearPending(); };

  /* ---------- open / close / send ---------- */
  window.openChat = async function (c) {
    if (!c || !me) return;
    other = c;
    msgs = [];
    rendered = {};
    seenEl = null;
    firstLoad = true;
    chatOpen = true;
    clearPending();
    paintAvatar($("chatAv"), c.avatar_url, c.display_name);
    $("chatName").textContent = c.display_name;
    msg("chatMsg", "");
    $("chatBox").textContent = "";
    show("chat");
    if (!myKey) { try { await ensureKey(); } catch (e) { msg("chatMsg", "Secure chat could not start. Try again."); return; } }
    await loadChat();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (chatOpen && !document.hidden) loadChat(); }, 5000);
  };

  function closeChat() {
    if (rec) stopRec(true);
    chatOpen = false;
    clearInterval(pollTimer);
    clearPending();
    revokeAll();
    rendered = {};
    other = null;
    show("home");
    loadContacts();
    refreshUnread();
  }
  $("chatBack").onclick = closeChat;

  function setBusy(b) {
    sending = b;
    $("chatSend").disabled = b;
    $("attachBtn").disabled = b;
    $("micBtn").disabled = b;
  }

  $("chatSend").onclick = async () => {
    if (sending || !other) return;
    if (rec) return msg("chatMsg", "Stop the recording first (tap the mic).");
    const text = $("chatText").value.trim();
    if (!text && !pending) return;
    setBusy(true);
    msg("chatMsg", "");
    let uploaded = null;
    try {
      if (!myKey) await ensureKey();
      const theirKey = await latestKey(other.id);
      if (!theirKey) throw new Error("They need to open Memo once to turn on secure chat.");
      const aes = await secret(myKey, theirKey);
      const payload = { t: text };
      if (pending) {
        msg("chatMsg", "Encrypting and uploading...", true);
        uploaded = await uploadPending();
        payload.f = uploaded;
      }
      const enc = await encryptPayload(aes, payload);
      const { error } = await sb.from("messages").insert({
        recipient: other.id, sender_key: myKey.id, recipient_key: theirKey.id,
        iv: enc.iv, ciphertext: enc.ciphertext,
      });
      if (error) {
        if (uploaded) sb.storage.from("chatfiles").remove([uploaded.path]);
        throw new Error("Could not send. You may no longer be connected.");
      }
      $("chatText").value = "";
      $("chatText").style.height = "44px";
      clearPending();
      msg("chatMsg", "");
      await loadChat();
    } catch (e) { msg("chatMsg", e.message || "Could not send."); }
    setBusy(false);
  };
  $("chatText").oninput = function () {
    this.style.height = "44px";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  };

  /* ---------- realtime ---------- */
  function subscribe() {
    if (channel) return;
    const handler = () => { if (chatOpen) loadChat(); else refreshUnread(); };
    channel = sb.channel("memo-msgs-" + me.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, handler)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, handler)
      .subscribe();
  }

  /* ---------- start / stop ---------- */
  async function init() {
    if (initFor === me.id || Date.now() < retryAt) return;
    initFor = me.id;
    try {
      await ensureKey();
      subscribe();
      await refreshUnread();
    } catch (e) {
      console.log("chat init:", e);
      initFor = null;
      retryAt = Date.now() + 8000;
    }
  }
  function teardown() {
    if (rec) stopRec(true);
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollTimer);
    revokeAll();
    myKey = null; localKeys = []; other = null; chatOpen = false;
    msgs = []; plain = {}; keyCache = {}; secretCache = {}; unread = {};
    rendered = {}; seenEl = null; pending = null;
    initFor = null;
  }
  setInterval(() => {
    if (me && initFor !== me.id) init();
    else if (!me && initFor) teardown();
  }, 700);
  setInterval(() => { if (me && initFor === me.id && !document.hidden) refreshUnread(); }, 20000);

  /* ---------- message button on the contact page ---------- */
  const mb = $("msgBtn");
  mb.disabled = false;
  mb.textContent = "Message";
  mb.onclick = () => { if (current) window.openChat(current); };
})();
