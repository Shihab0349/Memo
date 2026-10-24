(function () {
  "use strict";

  const RING_MS = 45000;
  let curDm = null, iceCache = null, iceAt = 0;
  let chan = null, subFor = null;
  let call = null, incoming = null;
  let ringCtx = null, ringInt = null, tickInt = null, wake = null, inTimer = null;
  let recentAt = 0, authToken = null;

  /* A Supabase rpc() call only runs when it is awaited or .then() is called. bg() always runs it. */
  function bg(fn, args) {
    return sb.rpc(fn, args).then(function (r) { return r; }, function () { return null; });
  }

  sb.auth.getSession().then(function (r) { authToken = r.data.session ? r.data.session.access_token : null; });
  sb.auth.onAuthStateChange(function (_e, s) { authToken = s ? s.access_token : null; });

  /* "Seen by": record the posts the viewer has seen */
  const _lf = loadFeed;
  loadFeed = async function () {
    await _lf();
    try {
      const ids = feedPosts.filter(function (p) { return p.author !== me.id; }).map(function (p) { return p.id; });
      if (ids.length) await bg("mark_seen", { ids: ids });
    } catch (e) { /* ignore */ }
  };

  /* ---------- styles and screens ---------- */
  const st = document.createElement("style");
  st.textContent =
    "#callUI{position:fixed;inset:0;z-index:9998;background:#0b1220;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center}" +
    "#callUI.hidden,#callUI .hidden{display:none !important}" +
    "#callRemote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}" +
    "#callUI.audioonly #callRemote{opacity:0}" +
    "#callLocal{position:absolute;top:14px;right:14px;width:96px;height:128px;object-fit:cover;border-radius:12px;background:#111;z-index:3;transform:scaleX(-1);border:2px solid rgba(255,255,255,.4)}" +
    "#callUI.audioonly #callLocal{display:none}" +
    "#callInfo{position:relative;z-index:2;text-align:center;padding:20px}" +
    "#callInfo.slim{position:absolute;top:14px;left:14px;text-align:left;padding:0}" +
    "#callInfo.slim .av{display:none}" +
    "#callInfo h1{font-size:24px;margin:14px 0 6px;color:#fff}" +
    "#callInfo.slim h1{font-size:16px;margin:0}" +
    "#callStatus{color:#cbd5e1;font-size:15px}" +
    ".cbtns{position:absolute;bottom:34px;left:0;right:0;display:flex;gap:18px;justify-content:center;z-index:3}" +
    ".cbtn{width:64px;height:64px;border-radius:50%;border:0;margin:0;padding:0;font-size:24px;background:rgba(255,255,255,.2);color:#fff;display:flex;align-items:center;justify-content:center}" +
    ".cbtn.off{background:#fff;color:#0b1220}" +
    ".cbtn.end,.cbtn.dec{background:#dc2626;color:#fff}" +
    ".cbtn.acc{background:#16a34a;color:#fff}" +
    ".toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 16px;border-radius:20px;font-size:14px;z-index:9999;max-width:90%;text-align:center}";
  document.head.appendChild(st);

  const ui = document.createElement("div");
  ui.id = "callUI";
  ui.className = "hidden";
  ui.innerHTML =
    '<video id="callRemote" autoplay playsinline></video>' +
    '<video id="callLocal" autoplay playsinline muted></video>' +
    '<div id="callInfo"><div class="av big" id="callAv"></div><h1 id="callName"></h1><div id="callStatus"></div></div>' +
    '<div class="cbtns" id="inBtns">' +
    '<button class="cbtn dec" id="cDecline" title="Decline">&#10005;</button>' +
    '<button class="cbtn acc" id="cAccept" title="Accept">&#9742;</button></div>' +
    '<div class="cbtns hidden" id="liveBtns">' +
    '<button class="cbtn" id="cMute" title="Mute">&#127908;</button>' +
    '<button class="cbtn" id="cCam" title="Camera">&#127909;</button>' +
    '<button class="cbtn end" id="cEnd" title="End call">&#10005;</button></div>';
  document.body.appendChild(ui);

  /* ---------- call buttons in the chat header ---------- */
  const hdr = $("chatBack").parentNode;
  const bA = el("button", "sec tiny hidden", "\uD83D\uDCDE");
  bA.id = "callBtnA";
  bA.title = "Voice call";
  const bV = el("button", "sec tiny hidden", "\uD83C\uDFA5");
  bV.id = "callBtnV";
  bV.title = "Video call";
  hdr.appendChild(bA);
  hdr.appendChild(bV);
  function setCallBtns(on) {
    bA.classList.toggle("hidden", !on);
    bV.classList.toggle("hidden", !on);
  }
  const _oc = window.openChat;
  window.openChat = function (c) { curDm = c; setCallBtns(true); return _oc(c); };
  const _og = window.openGroupChat;
  window.openGroupChat = function (g) { curDm = null; setCallBtns(false); return _og(g); };
  bA.onclick = () => startCall("audio");
  bV.onclick = () => startCall("video");

  /* ---------- recent calls on the home page ---------- */
  const rsec = document.createElement("div");
  rsec.innerHTML =
    '<div class="sec-title">Recent calls</div>' +
    '<div id="recentList"></div>' +
    '<p class="sub" id="noRecent">No calls yet.</p>';
  const sb0 = $("supportBtn");
  while (rsec.firstChild) sb0.parentNode.insertBefore(rsec.firstChild, sb0);

  function ago(iso) {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.floor(m / 60) + " h ago";
    return Math.floor(m / 1440) + " d ago";
  }
  function dur(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

  async function refreshRecent() {
    if (!me) return;
    recentAt = Date.now();
    const { data } = await sb.rpc("recent_calls");
    const rows = data || [];
    const list = $("recentList");
    list.textContent = "";
    rows.forEach((r) => {
      const missed = r.status === "missed" && r.direction === "in";
      let label;
      if (r.status === "ended" && r.duration > 0) label = (r.direction === "out" ? "Outgoing" : "Incoming") + " \u2022 " + dur(r.duration);
      else if (r.status === "missed") label = r.direction === "in" ? "Missed" : "No answer";
      else if (r.status === "declined") label = "Declined";
      else if (r.status === "ringing" || r.status === "accepted") label = "In progress";
      else label = r.direction === "out" ? "Outgoing" : "Incoming";
      const row = el("div", "contact");
      const box = el("div");
      box.appendChild(el("b", "", (r.kind === "video" ? "\uD83C\uDFA5 " : "\uD83D\uDCDE ") + r.other_name));
      const sp = el("span", "", label + "  \u2022 " + ago(r.created_at));
      if (missed) sp.style.color = "var(--err)";
      box.appendChild(sp);
      row.appendChild(box);
      row.onclick = () => {
        const c = contacts.find((x) => x.id === r.other_id);
        if (c && c.connected) window.openChat(c);
      };
      list.appendChild(row);
    });
    $("noRecent").classList.toggle("hidden", rows.length > 0);
  }

  /* ---------- helpers ---------- */
  function toast(t) {
    const d = el("div", "toast", t);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3500);
  }
  function setUI(c, status, mode) {
    ui.classList.remove("hidden");
    ui.classList.toggle("audioonly", c.kind !== "video");
    paintAvatar($("callAv"), c.peer.avatar_url, c.peer.display_name);
    $("callName").textContent = c.peer.display_name;
    $("callStatus").textContent = status;
    $("callInfo").classList.remove("slim");
    $("inBtns").classList.toggle("hidden", mode !== "incoming");
    $("liveBtns").classList.toggle("hidden", mode !== "live");
    $("cMute").className = "cbtn";
    $("cMute").innerHTML = "&#127908;";
    $("cCam").className = "cbtn" + (c.kind !== "video" ? " hidden" : "");
  }
  function hideUI() { ui.classList.add("hidden"); }

  function startRing() {
    stopRing();
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (ringCtx.resume) ringCtx.resume();
      const beep = () => {
        if (!ringCtx) return;
        const o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.frequency.value = 440;
        g.gain.value = 0.15;
        o.connect(g);
        g.connect(ringCtx.destination);
        o.start();
        o.stop(ringCtx.currentTime + 0.4);
        if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
      };
      beep();
      ringInt = setInterval(beep, 1800);
    } catch (e) { /* silent */ }
  }
  function stopRing() {
    clearInterval(ringInt);
    ringInt = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  async function getIce() {
    if (iceCache && Date.now() - iceAt < 20 * 60 * 1000) return iceCache;
    try {
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch(SUPABASE_URL + "/functions/v1/" + RESET_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ action: "ice" }),
      });
      const d = await r.json();
      if (r.ok && Array.isArray(d.iceServers) && d.iceServers.length) {
        iceCache = d.iceServers;
        iceAt = Date.now();
        return iceCache;
      }
    } catch (e) { /* fall back */ }
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }

  function getMedia(kind) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: kind === "video" ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  }
  function attachLocal(c) {
    if (c.kind === "video") {
      $("callLocal").srcObject = c.stream;
      $("callLocal").play().catch(() => {});
    }
  }
  function newCall(id, role, kind, peer) {
    return { id: id, role: role, kind: kind, peer: peer, iceQ: [], seen: new Set(), buf: [],
      chain: Promise.resolve(), remoteSet: false, connected: false, pc: null, stream: null };
  }

  /* ---------- signalling ---------- */
  async function sendSignal(cid, kind, payload) {
    const { error } = await sb.from("call_signals").insert({ call_id: cid, kind: kind, payload: payload });
    if (error) console.log("signal:", error.message);
  }
  async function flushIce(c) {
    const q = c.iceQ.splice(0);
    for (const cand of q) { try { await c.pc.addIceCandidate(cand); } catch (e) { /* ignore */ } }
  }
  async function applySignal(c, s) {
    if (call !== c || !c.pc) return;
    try {
      if (s.kind === "offer" && c.role === "callee") {
        await c.pc.setRemoteDescription(s.payload);
        c.remoteSet = true;
        await flushIce(c);
        const ans = await c.pc.createAnswer();
        await c.pc.setLocalDescription(ans);
        await sendSignal(c.id, "answer", { type: ans.type, sdp: ans.sdp });
      } else if (s.kind === "answer" && c.role === "caller") {
        await c.pc.setRemoteDescription(s.payload);
        c.remoteSet = true;
        await flushIce(c);
      } else if (s.kind === "ice") {
        if (c.remoteSet) { try { await c.pc.addIceCandidate(s.payload); } catch (e) { /* ignore */ } }
        else c.iceQ.push(s.payload);
      }
    } catch (e) { console.log("apply signal:", e); }
  }
  function drain(c) {
    c.chain = c.chain.then(async () => {
      const items = c.buf.splice(0).sort((a, b) => a.id - b.id);
      for (const s of items) await applySignal(c, s);
    });
  }
  function onSignal(row) {
    if (!call || !row || row.call_id !== call.id || row.sender === me.id) return;
    if (call.seen.has(row.id)) return;
    call.seen.add(row.id);
    call.buf.push(row);
    if (call.pc) drain(call);
  }

  /* ---------- peer connection ---------- */
  function makePC(c) {
    const pc = new RTCPeerConnection({ iceServers: c.ice });
    c.pc = pc;
    c.stream.getTracks().forEach((t) => pc.addTrack(t, c.stream));
    pc.ontrack = (e) => {
      const rv = $("callRemote");
      if (e.streams && e.streams[0] && rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
      rv.play().catch(() => {});
    };
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(c.id, "ice", e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") { clearTimeout(c.disc); onConnected(c); }
      else if (s === "failed" || s === "closed") hangup("Call ended", c);
      else if (s === "disconnected") {
        clearTimeout(c.disc);
        c.disc = setTimeout(() => { if (pc.connectionState !== "connected") hangup("Connection lost.", c); }, 6000);
      }
    };
  }

  function onConnected(c) {
    if (call !== c || c.connected) return;
    c.connected = true;
    clearTimeout(c.timeout);
    stopRing();
    c.t0 = Date.now();
    $("callStatus").textContent = "0:00";
    if (c.kind === "video") $("callInfo").classList.add("slim");
    clearInterval(tickInt);
    tickInt = setInterval(() => {
      $("callStatus").textContent = dur(Math.floor((Date.now() - c.t0) / 1000));
    }, 1000);
    if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => { wake = l; }).catch(() => {});
  }

  /* ---------- start / answer / end ---------- */
  async function startCall(kind) {
    if (call || incoming) return;
    if (!curDm || !window.RTCPeerConnection || !navigator.mediaDevices) return toast("Calls are not supported on this browser.");
    const peer = { id: curDm.id, display_name: curDm.display_name, avatar_url: curDm.avatar_url };
    let stream;
    try { stream = await getMedia(kind); }
    catch (e) { return toast(kind === "video" ? "Camera or microphone access was blocked." : "Microphone access was blocked."); }
    const { data: cid, error } = await sb.rpc("start_call", { callee_id: peer.id, call_kind: kind });
    if (error || !cid) {
      stream.getTracks().forEach((t) => t.stop());
      const t = String((error && error.message) || "");
      return toast(/busy/.test(t) ? "They are on another call." : /connected/.test(t) ? "You are not connected with this user." : "Could not start the call.");
    }
    const c = newCall(cid, "caller", kind, peer);
    c.stream = stream;
    call = c;
    setUI(c, "Calling...", "live");
    attachLocal(c);
    c.ice = await getIce();
    if (call !== c) return;
    makePC(c);
    try {
      const offer = await c.pc.createOffer();
      await c.pc.setLocalDescription(offer);
      await sendSignal(c.id, "offer", { type: offer.type, sdp: offer.sdp });
    } catch (e) { hangup("Could not start the call.", c); return; }
    c.timeout = setTimeout(() => { if (call === c && !c.connected) hangup("No answer", c); }, RING_MS);
    refreshRecent();
  }

  async function showIncoming(row) {
    if (call || incoming) return;
    if (Date.now() - new Date(row.created_at).getTime() > RING_MS) return;
    incoming = { id: row.id, caller: row.caller, kind: row.kind, peer: { id: row.caller, display_name: "Memo user", avatar_url: null } };
    const { data } = await sb.from("profiles").select("display_name, avatar_url").eq("id", row.caller).maybeSingle();
    if (!incoming || incoming.id !== row.id) return;
    if (data) incoming.peer = { id: row.caller, display_name: data.display_name, avatar_url: data.avatar_url };
    setUI({ kind: row.kind, peer: incoming.peer }, row.kind === "video" ? "Incoming video call" : "Incoming voice call", "incoming");
    startRing();
    clearTimeout(inTimer);
    inTimer = setTimeout(() => dismissIncoming(""), RING_MS);
  }
  function dismissIncoming(text) {
    stopRing();
    clearTimeout(inTimer);
    incoming = null;
    hideUI();
    if (text) toast(text);
    refreshRecent();
  }

  $("cDecline").onclick = () => {
    if (!incoming) return;
    const id = incoming.id;
    dismissIncoming("");
    bg("respond_call", { cid: id, accept: false });
  };

  $("cAccept").onclick = async () => {
    const row = incoming;
    if (!row || call) return;
    stopRing();
    clearTimeout(inTimer);
    incoming = null;
    const c = newCall(row.id, "callee", row.kind, row.peer);
    call = c;
    setUI(c, "Connecting...", "live");
    try { c.stream = await getMedia(row.kind); }
    catch (e) {
      call = null;
      hideUI();
      bg("respond_call", { cid: row.id, accept: false });
      return toast("Microphone or camera access was blocked.");
    }
    attachLocal(c);
    const { data: okAcc, error } = await sb.rpc("respond_call", { cid: row.id, accept: true });
    if (error || !okAcc) { cleanup(c); hideUI(); return toast("The call has ended."); }
    c.ice = await getIce();
    if (call !== c) return;
    makePC(c);
    const { data } = await sb.from("call_signals").select("id, call_id, sender, kind, payload")
      .eq("call_id", c.id).order("id");
    (data || []).forEach(onSignal);
    drain(c);
    c.timeout = setTimeout(() => { if (call === c && !c.connected) hangup("Could not connect.", c); }, 30000);
    refreshRecent();
  };

  function cleanup(c) {
    clearTimeout(c.timeout);
    clearTimeout(c.disc);
    clearInterval(tickInt);
    stopRing();
    try { if (c.pc) { c.pc.onconnectionstatechange = null; c.pc.close(); } } catch (e) { /* ignore */ }
    if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
    $("callRemote").srcObject = null;
    $("callLocal").srcObject = null;
    if (wake) { try { wake.release(); } catch (e) { /* ignore */ } wake = null; }
    if (call === c) call = null;
  }
  function endLocal(text) {
    const c = call;
    if (!c) return;
    cleanup(c);
    hideUI();
    if (text) toast(text);
    refreshRecent();
  }
  function hangup(text, c) {
    const cur = c || call;
    if (!cur || call !== cur) return;
    const id = cur.id;
    endLocal(text || "Call ended");
    bg("end_call", { cid: id });
  }
  $("cEnd").onclick = () => hangup("Call ended");

  $("cMute").onclick = function () {
    if (!call || !call.stream) return;
    const tr = call.stream.getAudioTracks();
    const on = tr.some((t) => t.enabled);
    tr.forEach((t) => { t.enabled = !on; });
    this.classList.toggle("off", on);
    this.innerHTML = on ? "&#128263;" : "&#127908;";
  };
  $("cCam").onclick = function () {
    if (!call || !call.stream) return;
    const tr = call.stream.getVideoTracks();
    const on = tr.some((t) => t.enabled);
    tr.forEach((t) => { t.enabled = !on; });
    this.classList.toggle("off", on);
  };

  /* ---------- realtime ---------- */
  function onCallRow(row, ev) {
    if (!me || !row) return;
    if (ev === "INSERT" && row.callee === me.id && row.status === "ringing") { showIncoming(row); return; }
    if (incoming && incoming.id === row.id && row.status !== "ringing") {
      dismissIncoming(row.status === "missed" ? "Missed call" : "");
      return;
    }
    if (call && call.id === row.id) {
      if (["ended", "declined", "missed"].indexOf(row.status) >= 0) {
        endLocal(row.status === "declined" ? "Call declined" : row.status === "missed" ? "No answer" : "Call ended");
      } else if (row.status === "accepted" && call.role === "caller" && !call.connected) {
        $("callStatus").textContent = "Connecting...";
      }
    }
    refreshRecent();
  }

  function subscribe() {
    if (chan) return;
    chan = sb.channel("memo-calls-" + me.id)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls" }, (p) => onCallRow(p.new, "INSERT"))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls" }, (p) => onCallRow(p.new, "UPDATE"))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "call_signals" }, (p) => onSignal(p.new))
      .subscribe();
  }
  async function checkRinging() {
    if (!me || call || incoming) return;
    const since = new Date(Date.now() - RING_MS).toISOString();
    const { data } = await sb.from("calls").select("id, caller, callee, kind, status, created_at")
      .eq("callee", me.id).eq("status", "ringing").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1);
    if (data && data[0]) showIncoming(data[0]);
  }

  /* While a call is active: check its status every 3 s and send a heartbeat every 10 s */
  async function pollActive() {
    const c = call;
    if (!c) return;
    const { data } = await sb.from("calls").select("status").eq("id", c.id).maybeSingle();
    if (!data || call !== c) return;
    if (["ended", "declined", "missed"].indexOf(data.status) >= 0) {
      endLocal(data.status === "declined" ? "Call declined" : data.status === "missed" ? "No answer" : "Call ended");
    }
  }
  setInterval(pollActive, 3000);
  setInterval(() => { if (call) bg("ping_call", { cid: call.id }); }, 10000);

  /* Closing the page or tab ends the call right away */
  window.addEventListener("pagehide", () => {
    const c = call;
    if (!c || !authToken) return;
    try {
      fetch(SUPABASE_URL + "/rest/v1/rpc/end_call", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + authToken },
        body: JSON.stringify({ cid: c.id }),
      });
    } catch (e) { /* ignore */ }
  });

  function teardown() {
    if (call) { const id = call.id; cleanup(call); bg("end_call", { cid: id }); }
    dismissIncoming("");
    hideUI();
    if (chan) { sb.removeChannel(chan); chan = null; }
    subFor = null;
    iceCache = null;
  }

  setInterval(() => {
    if (me && subFor !== me.id) { subFor = me.id; subscribe(); refreshRecent(); checkRinging(); }
    else if (!me && subFor) teardown();
  }, 800);
  setInterval(() => { if (me && !document.hidden) checkRinging(); }, 4000);
  setInterval(() => { if (me && !document.hidden && Date.now() - recentAt > 30000) refreshRecent(); }, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && me) { checkRinging(); refreshRecent(); } });
})();
