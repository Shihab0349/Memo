(function () {
  "use strict";

  const SUPPORTED = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let busy = false, syncedFor = null, lastEndpoint = null, lastToken = null;

  /* ---------- UI ---------- */
  const prof = $("profile");
  const backBtn = prof.querySelector('button[onclick="backHome()"]');
  const box = document.createElement("div");
  box.innerHTML =
    '<div class="sec-title">Push notifications</div>' +
    '<p class="sub" id="pushState"></p>' +
    '<button id="pushBtn" class="hidden" style="margin-top:0">Turn on notifications</button>' +
    '<button id="pushTest" class="sec hidden">Send a test notification</button>' +
    '<div class="msg" id="pushMsg"></div>';
  while (box.firstChild) prof.insertBefore(box.firstChild, backBtn);

  const hint = document.createElement("p");
  hint.className = "sub hidden";
  hint.id = "pushHint";
  hint.innerHTML = '<a id="pushHintLink">Turn on notifications</a> to get messages and calls even when Memo is closed.';
  const firstTitle = $("home").querySelector(".sec-title");
  firstTitle.parentNode.insertBefore(hint, firstTitle);

  /* ---------- helpers ---------- */
  function keyBytes(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, function (c) { return c.charCodeAt(0); });
  }
  function swReady() {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error("The app is still starting. Reload and try again.")); }, 8000); }),
    ]);
  }
  async function localSub() { const r = await swReady(); return r.pushManager.getSubscription(); }
  function offFlag() { try { return localStorage.getItem("memo-push-off-" + me.id) === "1"; } catch (e) { return false; } }
  function setOff(v) { try { if (v) localStorage.setItem("memo-push-off-" + me.id, "1"); else localStorage.removeItem("memo-push-off-" + me.id); } catch (e) { /* ignore */ } }

  sb.auth.getSession().then(function (r) { if (r.data && r.data.session) lastToken = r.data.session.access_token; });
  sb.auth.onAuthStateChange(function (_e, s) { if (s) lastToken = s.access_token; });

  async function getKey() {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(SUPABASE_URL + "/functions/v1/" + RESET_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ action: "vapid" }),
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok || !d.publicKey) throw new Error(d.error || "Could not get the notification key.");
    return d.publicKey;
  }

  async function subscribeNow() {
    const key = await getKey();
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    const j = sub.toJSON();
    const { error } = await sb.rpc("save_push_subscription", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    if (error) throw new Error("Could not save. Try again.");
    lastEndpoint = j.endpoint;
    return sub;
  }

  /* ---------- state ---------- */
  async function refresh() {
    const st = $("pushState"), btn = $("pushBtn"), tst = $("pushTest");
    if (!SUPPORTED) {
      st.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
        ? "On iPhone, first add Memo to your Home Screen (Share button, then Add to Home Screen), then open Memo from there to turn on notifications."
        : "This browser does not support push notifications.";
      btn.classList.add("hidden"); tst.classList.add("hidden"); hint.classList.add("hidden");
      return;
    }
    if (Notification.permission === "denied") {
      st.textContent = "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
      btn.classList.add("hidden"); tst.classList.add("hidden"); hint.classList.add("hidden");
      return;
    }
    let sub = null;
    try { sub = await localSub(); } catch (e) { /* ignore */ }
    if (sub) lastEndpoint = sub.endpoint;
    const on = !!sub && Notification.permission === "granted";
    st.textContent = on
      ? "On for this device. You will get alerts for messages, requests and calls."
      : "Off. Turn it on to get alerts even when Memo is closed.";
    btn.textContent = on ? "Turn off notifications" : "Turn on notifications";
    btn.classList.remove("hidden");
    tst.classList.toggle("hidden", !on);
    hint.classList.toggle("hidden", on || !me);
  }

  async function turnOn() {
    if (busy) return;
    busy = true;
    msg("pushMsg", "Working...", true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications were not allowed.");
      setOff(false);
      await subscribeNow();
      msg("pushMsg", "Notifications are on.", true);
    } catch (e) { msg("pushMsg", e.message || "Could not turn on notifications."); }
    busy = false;
    refresh();
  }

  async function turnOff() {
    if (busy) return;
    busy = true;
    try {
      const sub = await localSub();
      if (sub) {
        await sb.rpc("remove_push_subscription", { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setOff(true);
      lastEndpoint = null;
      msg("pushMsg", "Notifications are off.", true);
    } catch (e) { msg("pushMsg", "Could not turn off. Try again."); }
    busy = false;
    refresh();
  }

  $("pushBtn").onclick = async function () {
    let sub = null;
    try { sub = await localSub(); } catch (e) { /* ignore */ }
    if (sub && Notification.permission === "granted") turnOff(); else turnOn();
  };
  $("pushHintLink").onclick = turnOn;
  $("pushTest").onclick = async function () {
    msg("pushMsg", "Test sent. Switch to another app or lock your screen to see it.", true);
    const { error } = await sb.rpc("test_push");
    if (error) msg("pushMsg", "Could not send the test.");
  };
  $("editBtn").addEventListener("click", function () { msg("pushMsg", ""); refresh(); });

  /* ---------- keep this device subscribed for the signed-in user ---------- */
  async function autoSync() {
    try {
      if (SUPPORTED && Notification.permission === "granted" && !offFlag()) await subscribeNow();
    } catch (e) { console.log("push sync:", e && e.message); }
    refresh();
  }
  setInterval(function () {
    if (me && syncedFor !== me.id) { syncedFor = me.id; autoSync(); }
    if (!me && syncedFor) { syncedFor = null; hint.classList.add("hidden"); }
  }, 1000);

  /* ---------- log out: stop sending this user's alerts to this device ---------- */
  $("logoutBtn").addEventListener("click", function () {
    try {
      if (lastEndpoint && lastToken) {
        fetch(SUPABASE_URL + "/rest/v1/rpc/remove_push_subscription", {
          method: "POST",
          headers: { apikey: KEY, Authorization: "Bearer " + lastToken, "Content-Type": "application/json" },
          body: JSON.stringify({ p_endpoint: lastEndpoint }),
        }).catch(function () {});
      }
      localSub().then(function (s) { if (s) s.unsubscribe(); }).catch(function () {});
    } catch (e) { /* ignore */ }
  }, true);
})();
