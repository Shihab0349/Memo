(function () {
  "use strict";

  let localKeys = [], myKey = null;
  let initFor = null, retryAt = 0, channel = null;
  let other = null, chatOpen = false, firstLoad = true, sending = false;
  let msgs = [], plain = {}, keyCache = {}, secretCache = {};
  let unread = {};
  let pollTimer = null;

  /* ---------- styles and screen ---------- */
  const st = document.createElement("style");
  st.textContent =
    ".chatbox{height:52vh;overflow-y:auto;margin-top:12px;padding:2px}" +
    ".contact span.cbadge{margin-left:auto;background:var(--accent);color:#052e16;border-radius:10px;padding:2px 8px;font-weight:700;font-size:12px}" +
    ".chatbar{display:flex;gap:8px;align-items:flex-end;margin-top:10px}" +
    ".chatbar textarea{min-height:44px;height:44px;max-height:120px}";
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
    '<div class="chatbar"><textarea id="chatText" maxlength="2000" placeholder="Message"></textarea>' +
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
  async function encryptText(aes, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes,
      new TextEncoder().encode(JSON.stringify({ t: text })));
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
      const res = { ok: true, text: JSON.parse(new TextDecoder().decode(pt)).t };
      plain[row.id] = res;
      return res;
    } catch (e) { return { ok: false }; }
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

  /* ---------- chat screen ---------- */
  function renderMsgs() {
    const box = $("chatBox");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = "";
    let lastMine = -1;
    msgs.forEach((m, i) => { if (m.sender === me.id) lastMine = i; });
    msgs.forEach((m, i) => {
      const mine = m.sender === me.id;
      const b = el("div", "bubble " + (mine ? "me" : "them"));
      b.appendChild(el("small", "", new Date(m.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
      b.appendChild(document.createTextNode(m.ok ? m.text : "\uD83D\uDD12 This message can't be opened on this device."));
      box.appendChild(b);
      if (mine && i === lastMine && m.read_at) {
        const s = el("div", "time", "Seen");
        s.style.textAlign = "right";
        box.appendChild(s);
      }
    });
    if (firstLoad || atBottom) box.scrollTop = box.scrollHeight;
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

  window.openChat = async function (c) {
    if (!c || !me) return;
    other = c;
    msgs = [];
    firstLoad = true;
    chatOpen = true;
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
    chatOpen = false;
    clearInterval(pollTimer);
    other = null;
    show("home");
    loadContacts();
    refreshUnread();
  }
  $("chatBack").onclick = closeChat;

  $("chatSend").onclick = async () => {
    if (sending || !other) return;
    const text = $("chatText").value.trim();
    if (!text) return;
    sending = true;
    $("chatSend").disabled = true;
    msg("chatMsg", "");
    try {
      if (!myKey) await ensureKey();
      const theirKey = await latestKey(other.id);
      if (!theirKey) throw new Error("They need to open Memo once to turn on secure chat.");
      const aes = await secret(myKey, theirKey);
      const enc = await encryptText(aes, text);
      const { error } = await sb.from("messages").insert({
        recipient: other.id, sender_key: myKey.id, recipient_key: theirKey.id,
        iv: enc.iv, ciphertext: enc.ciphertext,
      });
      if (error) throw new Error("Could not send. You may no longer be connected.");
      $("chatText").value = "";
      $("chatText").style.height = "44px";
      await loadChat();
    } catch (e) { msg("chatMsg", e.message || "Could not send."); }
    sending = false;
    $("chatSend").disabled = false;
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
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollTimer);
    myKey = null; localKeys = []; other = null; chatOpen = false;
    msgs = []; plain = {}; keyCache = {}; secretCache = {}; unread = {};
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
