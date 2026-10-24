(function () {
  "use strict";

  const FILE_DAYS = 30;
  let deferred = null, doneFor = null;

  /* ---------- manifest and service worker ---------- */
  if (!document.querySelector('link[rel="manifest"]')) {
    const l = document.createElement("link");
    l.rel = "manifest";
    l.href = "manifest.json";
    document.head.appendChild(l);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  /* ---------- extra sections in Edit Profile ---------- */
  const prof = $("profile");
  const backBtn = prof.querySelector('button[onclick="backHome()"]');
  const box = document.createElement("div");
  box.innerHTML =
    '<div id="installBox"><div class="sec-title">Install app</div>' +
    '<p class="sub" id="installHint"></p>' +
    '<button id="installBtn" class="hidden" style="margin-top:0">Install Memo</button></div>' +
    '<div class="sec-title">Blocked users</div>' +
    '<div id="blockedList"></div>' +
    '<p class="sub" id="noBlocked">You have not blocked anyone.</p>' +
    '<div class="msg" id="blockedMsg"></div>';
  while (box.firstChild) prof.insertBefore(box.firstChild, backBtn);

  /* ---------- install ---------- */
  function standalone() {
    return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }
  function updateInstall() {
    const b = $("installBox");
    if (standalone()) { b.classList.add("hidden"); return; }
    b.classList.remove("hidden");
    $("installBtn").classList.toggle("hidden", !deferred);
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $("installHint").textContent = deferred
      ? "Install Memo on your home screen to use it like an app."
      : ios
        ? "On iPhone: tap the Share button, then choose Add to Home Screen."
        : "Open the browser menu and choose Install app (or Add to Home screen).";
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    updateInstall();
  });
  window.addEventListener("appinstalled", function () { deferred = null; updateInstall(); });
  $("installBtn").onclick = async function () {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch (e) { /* ignore */ }
    deferred = null;
    updateInstall();
  };
  updateInstall();

  /* ---------- blocked users and unblock ---------- */
  async function loadBlocked() {
    if (!me) return;
    const { data } = await sb.rpc("my_blocks");
    const rows = data || [];
    const list = $("blockedList");
    list.textContent = "";
    rows.forEach(function (u) {
      const row = el("div", "contact");
      row.style.cursor = "default";
      const info = el("div");
      info.style.flex = "1";
      info.appendChild(el("b", "", u.display_name));
      info.appendChild(el("span", "", "ID: " + u.user_code));
      const b = el("button", "sec tiny", "Unblock");
      b.onclick = async function () {
        if (!confirm("Unblock " + u.display_name + "? They will be able to find your ID again.")) return;
        const { error } = await sb.rpc("unblock_user", { target: u.id });
        if (error) return msg("blockedMsg", "Could not unblock. Try again.");
        msg("blockedMsg", u.display_name + " was unblocked.", true);
        loadBlocked();
      };
      row.appendChild(info);
      row.appendChild(b);
      list.appendChild(row);
    });
    $("noBlocked").classList.toggle("hidden", rows.length > 0);
  }
  $("editBtn").addEventListener("click", function () { msg("blockedMsg", ""); loadBlocked(); });

  /* ---------- housekeeping: remove old files of the signed-in user ---------- */
  async function housekeeping() {
    try {
      const uid = me.id;
      const { data: ex } = await sb.rpc("expired_post_paths");
      const rows = ex || [];
      const paths = rows.filter(function (r) { return r.image_path; }).map(function (r) { return r.image_path; });
      if (paths.length) await sb.storage.from("posts").remove(paths);
      if (rows.length) await sb.rpc("purge_expired_posts");

      const cutoff = Date.now() - FILE_DAYS * 86400000;
      const { data: cf } = await sb.storage.from("chatfiles").list(uid, { limit: 1000 });
      const oldFiles = (cf || [])
        .filter(function (f) { return f.created_at && new Date(f.created_at).getTime() < cutoff; })
        .map(function (f) { return uid + "/" + f.name; });
      if (oldFiles.length) await sb.storage.from("chatfiles").remove(oldFiles);

      const dayAgo = Date.now() - 86400000;
      const cur = me.avatar_url ? String(me.avatar_url).split("/").pop() : "";
      const { data: av } = await sb.storage.from("avatars").list(uid, { limit: 1000 });
      const oldAv = (av || [])
        .filter(function (f) { return f.name !== cur && f.created_at && new Date(f.created_at).getTime() < dayAgo; })
        .map(function (f) { return uid + "/" + f.name; });
      if (oldAv.length) await sb.storage.from("avatars").remove(oldAv);
    } catch (e) { console.log("housekeeping:", e); }
  }
  setInterval(function () {
    if (me && doneFor !== me.id) { doneFor = me.id; setTimeout(housekeeping, 6000); }
    if (!me) doneFor = null;
  }, 1000);
})();
