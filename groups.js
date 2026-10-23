(function () {
  "use strict";

  let ginfo = null, gmembers = [];

  const st = document.createElement("style");
  st.textContent =
    ".sw{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:14px}" +
    ".sw input{width:auto;flex:none}" +
    ".pick{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;background:var(--inset);margin-top:8px}" +
    ".pick input{width:auto;flex:none}" +
    ".gbadge{margin-left:auto;background:var(--accent);color:#052e16;border-radius:10px;padding:2px 8px;font-weight:700;font-size:12px}" +
    ".role{font-size:11px;color:var(--ok);margin-left:6px}" +
    ".mrow{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;background:var(--inset);margin-top:8px}" +
    ".mrow .av{width:40px;height:40px;font-size:16px}" +
    ".mrow .grow{flex:1;min-width:0;word-break:break-word}" +
    ".acts{display:flex;gap:6px;flex-wrap:wrap}";
  document.head.appendChild(st);

  /* ---------- screens ---------- */
  const ng = document.createElement("div");
  ng.className = "card hidden";
  ng.id = "newgroup";
  ng.innerHTML =
    '<h1>New group</h1>' +
    '<label for="ngName">Group name</label>' +
    '<input id="ngName" type="text" maxlength="60" placeholder="Group name">' +
    '<div class="sec-title">Add members (connected contacts)</div>' +
    '<div id="ngPick"></div>' +
    '<p class="sub" id="ngNone"></p>' +
    '<button id="ngCreate">Create group</button>' +
    '<button class="sec" id="ngBack">Back</button>' +
    '<div class="msg" id="ngMsg"></div>';
  document.body.appendChild(ng);

  const gi = document.createElement("div");
  gi.className = "card hidden";
  gi.id = "ginfo";
  gi.innerHTML =
    '<h1 id="giName" style="word-break:break-word"></h1>' +
    '<p class="sub" id="giSub"></p>' +
    '<div id="giAdmin" class="hidden">' +
    '<label for="giRename">Group name</label>' +
    '<div class="row"><input id="giRename" type="text" maxlength="60"><button class="small" id="giRenameBtn">Save</button></div>' +
    '<label class="sw" for="giOnly"><input type="checkbox" id="giOnly"> Only admins can send messages</label>' +
    '</div>' +
    '<div class="sec-title">Members</div>' +
    '<div id="giMembers"></div>' +
    '<div id="giAddBox" class="hidden">' +
    '<div class="sec-title">Add members</div>' +
    '<div id="giAddList"></div>' +
    '<p class="sub" id="giAddNone"></p>' +
    '</div>' +
    '<button class="sec" id="giBack">Back to chat</button>' +
    '<button class="danger" id="giLeave">Leave group</button>' +
    '<button class="danger hidden" id="giDelete">Delete group</button>' +
    '<div class="msg" id="giMsg"></div>';
  document.body.appendChild(gi);

  SCREENS.push("newgroup", "ginfo");

  /* ---------- groups section on the home page ---------- */
  const anchor = $("contactList").previousElementSibling;
  const sec = document.createElement("div");
  sec.innerHTML =
    '<div class="sec-title">Groups</div>' +
    '<div id="groupList"></div>' +
    '<p class="sub" id="noGroups">No groups yet.</p>' +
    '<button class="sec" id="newGroupBtn" style="margin-top:6px">+ New group</button>';
  while (sec.firstChild) anchor.parentNode.insertBefore(sec.firstChild, anchor);

  function ago(iso) {
    if (!iso) return "";
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.floor(m / 60) + " h ago";
    return Math.floor(m / 1440) + " d ago";
  }

  /* ---------- list ---------- */
  window.refreshGroups = async function () {
    if (!me) return;
    const { data } = await sb.rpc("my_groups");
    const rows = data || [];
    const list = $("groupList");
    list.textContent = "";
    rows.forEach((g) => {
      const row = el("div", "contact");
      const av = el("div", "av");
      paintAvatar(av, null, g.name);
      const box = el("div");
      box.appendChild(el("b", "", g.name));
      box.appendChild(el("span", "", g.member_count + " members" + (g.last_at ? "  \u2022 " + ago(g.last_at) : "")));
      row.appendChild(av);
      row.appendChild(box);
      if (Number(g.unread) > 0) row.appendChild(el("span", "gbadge", Number(g.unread) > 99 ? "99+" : String(g.unread)));
      row.onclick = () => window.openGroupChat(g.id);
      list.appendChild(row);
    });
    $("noGroups").classList.toggle("hidden", rows.length > 0);
  };

  const _lc = loadContacts;
  loadContacts = async function () { await _lc(); window.refreshGroups(); };

  let lastMe = null;
  setInterval(() => {
    if (me && me.id !== lastMe) { lastMe = me.id; window.refreshGroups(); }
    if (!me) lastMe = null;
  }, 800);
  setInterval(() => {
    if (me && !document.hidden && !$("home").classList.contains("hidden")) window.refreshGroups();
  }, 20000);

  /* ---------- new group ---------- */
  $("newGroupBtn").onclick = () => {
    $("ngName").value = "";
    msg("ngMsg", "");
    const pick = $("ngPick");
    pick.textContent = "";
    const conn = contacts.filter((c) => c.connected);
    conn.forEach((c) => {
      const row = el("label", "pick");
      row.style.margin = "8px 0 0";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.id;
      const av = el("div", "av");
      av.style.cssText = "width:36px;height:36px;font-size:15px";
      paintAvatar(av, c.avatar_url, c.display_name);
      row.appendChild(cb);
      row.appendChild(av);
      row.appendChild(el("span", "", c.display_name));
      pick.appendChild(row);
    });
    $("ngNone").textContent = conn.length ? "" : "You have no connected contacts yet. You can create the group now and add people later.";
    show("newgroup");
  };
  $("ngBack").onclick = () => show("home");

  $("ngCreate").onclick = async () => {
    const name = $("ngName").value.trim();
    if (!name) return msg("ngMsg", "Enter a group name.");
    const ids = Array.from($("ngPick").querySelectorAll("input:checked")).map((i) => i.value);
    if (ids.length > 49) return msg("ngMsg", "A group can have at most 50 members.");
    const btn = $("ngCreate");
    btn.disabled = true;
    msg("ngMsg", "Creating...", true);
    const { data, error } = await sb.rpc("create_group", { gname: name, member_ids: ids });
    btn.disabled = false;
    if (error || !data) return msg("ngMsg", "Could not create the group. Try again.");
    window.openGroupChat(data);
  };

  /* ---------- group info ---------- */
  async function loadInfo(gid) {
    const [r1, r2] = await Promise.all([sb.rpc("my_groups"), sb.rpc("get_group_members", { gid: gid })]);
    const g = (r1.data || []).find((x) => x.id === gid);
    if (!g) return false;
    ginfo = g;
    gmembers = r2.data || [];
    return true;
  }

  function renderInfo() {
    const admin = ginfo.my_role === "admin";
    $("giName").textContent = ginfo.name;
    $("giSub").textContent = ginfo.member_count + " members \u2022 " + (admin ? "You are an admin" : "You are a member");
    $("giAdmin").classList.toggle("hidden", !admin);
    $("giRename").value = ginfo.name;
    $("giOnly").checked = !!ginfo.only_admins;
    $("giAddBox").classList.toggle("hidden", !admin);
    $("giDelete").classList.toggle("hidden", !admin);

    const list = $("giMembers");
    list.textContent = "";
    gmembers.forEach((m) => {
      const row = el("div", "mrow");
      const av = el("div", "av");
      paintAvatar(av, m.avatar_url, m.display_name);
      const g = el("div", "grow");
      const nm = el("b", "", m.display_name + (m.user_id === me.id ? " (you)" : ""));
      g.appendChild(nm);
      if (m.role === "admin") g.appendChild(el("span", "role", "Admin"));
      row.appendChild(av);
      row.appendChild(g);
      if (admin && m.user_id !== me.id) {
        const acts = el("div", "acts");
        const tg = el("button", "sec tiny", m.role === "admin" ? "Remove admin" : "Make admin");
        tg.onclick = () => act("set_group_admin", { gid: ginfo.id, uid: m.user_id, make: m.role !== "admin" });
        acts.appendChild(tg);
        if (m.role === "member") {
          const rm = el("button", "sec tiny", "Remove");
          rm.onclick = () => {
            if (confirm("Remove " + m.display_name + " from this group?"))
              act("remove_group_member", { gid: ginfo.id, uid: m.user_id });
          };
          acts.appendChild(rm);
        }
        row.appendChild(acts);
      }
      list.appendChild(row);
    });

    const addList = $("giAddList");
    addList.textContent = "";
    if (admin) {
      const inGroup = new Set(gmembers.map((m) => m.user_id));
      const cand = contacts.filter((c) => c.connected && !inGroup.has(c.id));
      cand.forEach((c) => {
        const row = el("div", "mrow");
        const av = el("div", "av");
        paintAvatar(av, c.avatar_url, c.display_name);
        const g = el("div", "grow", c.display_name);
        const b = el("button", "tiny", "Add");
        b.onclick = () => act("add_group_member", { gid: ginfo.id, uid: c.id });
        row.appendChild(av);
        row.appendChild(g);
        row.appendChild(b);
        addList.appendChild(row);
      });
      $("giAddNone").textContent = cand.length ? "" : "No more connected contacts to add.";
    }
  }

  async function act(fn, args) {
    msg("giMsg", "Working...", true);
    const { error } = await sb.rpc(fn, args);
    if (error) {
      const t = String(error.message || "");
      msg("giMsg", /at least one admin/.test(t) ? "A group needs at least one admin." :
        /full/.test(t) ? "This group is full (50 members)." : "That did not work. Try again.");
      return;
    }
    msg("giMsg", "");
    if (await loadInfo(ginfo.id)) renderInfo();
  }

  window.openGroupInfo = async function (g) {
    msg("giMsg", "");
    show("ginfo");
    if (!(await loadInfo(g.id))) { show("home"); return; }
    renderInfo();
  };

  $("giRenameBtn").onclick = () => {
    const n = $("giRename").value.trim();
    if (!n) return msg("giMsg", "Enter a name.");
    act("rename_group", { gid: ginfo.id, new_name: n });
  };
  $("giOnly").onchange = () => act("set_group_policy", { gid: ginfo.id, only_admins: $("giOnly").checked });
  $("giBack").onclick = () => window.openGroupChat(ginfo.id);

  $("giLeave").onclick = async () => {
    if (!confirm("Leave this group? You will stop receiving its messages.")) return;
    const { error } = await sb.rpc("leave_group", { gid: ginfo.id });
    if (error) return msg("giMsg", "Could not leave the group.");
    show("home");
    msg("homeMsg", "You left the group.", true);
    window.refreshGroups();
  };
  $("giDelete").onclick = async () => {
    if (!confirm("Delete this group for everyone? This cannot be undone.")) return;
    const { error } = await sb.rpc("delete_group", { gid: ginfo.id });
    if (error) return msg("giMsg", "Could not delete the group.");
    show("home");
    msg("homeMsg", "Group deleted.", true);
    window.refreshGroups();
  };

  if (me) window.refreshGroups();
})();
