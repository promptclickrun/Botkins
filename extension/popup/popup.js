const $ = (id) => document.getElementById(id);

let currentSnapshot = null;
let pollTimer = null;

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error || "Extension action failed.");
  return res.data;
}

function showError(msg) {
  const box = $("error-box");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
  } else {
    box.classList.remove("hidden");
    box.textContent = msg;
  }
}

function routeLabel(status) {
  if (!status) return "Off";
  if (status.state === "online") return status.route === "direct" ? "Connected · Direct" : "Connected · Relay";
  if (status.state === "connecting") return "Connecting…";
  if (status.state === "revoked") return "Removed on host";
  return status.error ? status.error.slice(0, 48) : "Offline";
}

function render(snap) {
  currentSnapshot = snap;
  $("master-toggle").checked = snap.settings.enabled !== false;
  $("browser-tag").textContent = snap.settings.profileLabel
    ? `${snap.browserName} · ${snap.settings.profileLabel}`
    : snap.browserName;

  const onlineCount = snap.hosts.filter((h) => h.enabled && h.status?.state === "online").length;
  if (snap.settings.enabled === false) {
    $("subtitle").textContent = "Paused";
  } else if (onlineCount > 0) {
    $("subtitle").textContent = onlineCount === 1 ? "Connected to 1 host" : `Connected to ${onlineCount} hosts`;
  } else if (snap.hosts.some((h) => h.enabled)) {
    $("subtitle").textContent = "Connecting…";
  } else {
    $("subtitle").textContent = "Not connected";
  }

  // Auth views
  $("signed-out-view").classList.toggle("hidden", Boolean(snap.profile || snap.pendingEnroll));
  $("pending-enroll-view").classList.toggle("hidden", !snap.pendingEnroll);
  $("signed-in-view").classList.toggle("hidden", !snap.profile || Boolean(snap.pendingEnroll));

  if (snap.pendingEnroll) {
    $("enroll-code").textContent = snap.pendingEnroll.code;
    startEnrollPolling();
  } else {
    stopEnrollPolling();
  }

  if (snap.profile) {
    $("profile-avatar").textContent = snap.profile.avatar || "🤖";
    $("profile-name").textContent = snap.profile.name || "Botkins Profile";
    $("profile-email").textContent = snap.profile.email || "";
  }

  // Hosts list
  const list = $("hosts-list");
  list.innerHTML = "";
  if (!snap.hosts.length) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.style.margin = "2px 0";
    empty.textContent = snap.profile
      ? "No hosts in your Botkins profile yet. Link a host in Botkins Settings › Profile, or pair directly below."
      : "Sign in to your Botkins profile or pair directly below.";
    list.appendChild(empty);
  } else {
    for (const host of snap.hosts) {
      const row = document.createElement("div");
      row.className = "host-row";

      const info = document.createElement("div");
      info.className = "host-info";
      const name = document.createElement("div");
      name.className = "host-name";
      name.textContent = host.name;
      const sub = document.createElement("div");
      sub.className = "host-sub";
      const dot = document.createElement("span");
      dot.className = "dot " + (host.enabled ? host.status?.state || "offline" : "offline");
      const label = document.createElement("span");
      label.textContent = host.enabled ? routeLabel(host.status) : "Off";
      sub.append(dot, label);
      info.append(name, sub);

      const controls = document.createElement("div");
      controls.className = "row gap-xs";

      const sw = document.createElement("label");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = host.enabled;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        showError("");
        try {
          await send({ type: "toggle_host", serverId: host.serverId, enabled: cb.checked });
          await refresh();
        } catch (err) {
          showError(err.message);
          cb.checked = !cb.checked;
        } finally {
          cb.disabled = false;
        }
      });
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.append(cb, slider);
      controls.appendChild(sw);

      if (host.source === "direct") {
        const rm = document.createElement("button");
        rm.className = "btn ghost small";
        rm.textContent = "×";
        rm.title = "Forget host";
        rm.addEventListener("click", async () => {
          showError("");
          try {
            await send({ type: "forget_host", serverId: host.serverId });
            await refresh();
          } catch (err) {
            showError(err.message);
          }
        });
        controls.appendChild(rm);
      }

      row.append(info, controls);
      list.appendChild(row);
    }
  }

  // Access mode
  const isGroup = snap.settings.mode === "group";
  $("mode-all").classList.toggle("active", !isGroup);
  $("mode-group").classList.toggle("active", isGroup);
  $("mode-hint").textContent = isGroup
    ? `Bots can access tabs in the "${snap.settings.groupName || "Botkins"}" tab group (plus tabs bots open).`
    : "Bots can access all ordinary tabs in this browser profile (except paused or incognito tabs).";

  // Active tab quick action
  const tabRow = $("current-tab-row");
  if (snap.activeTab?.id != null && /^https?:\/\//i.test(snap.activeTab.url || "")) {
    tabRow.classList.remove("hidden");
    $("tab-title").textContent = snap.activeTab.title || snap.activeTab.url;
    const btn = $("btn-tab-action");
    if (isGroup) {
      btn.textContent = "Add to group";
      btn.onclick = async () => {
        try {
          render(await send({ type: "add_tab_to_group", tabId: snap.activeTab.id }));
        } catch (err) {
          showError(err.message);
        }
      };
    } else {
      btn.textContent = snap.activeTab.paused ? "Allow this tab" : "Pause this tab";
      btn.onclick = async () => {
        try {
          render(await send({ type: "toggle_pause_tab", tabId: snap.activeTab.id }));
        } catch (err) {
          showError(err.message);
        }
      };
    }
  } else {
    tabRow.classList.add("hidden");
  }
}

async function refresh() {
  try {
    const snap = await send({ type: "get_status" });
    render(snap);
  } catch (err) {
    showError(err.message);
  }
}

function startEnrollPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const res = await send({ type: "check_profile_signin" });
      if (res.status === "signed_in" || res.status === "expired") {
        stopEnrollPolling();
        await refresh();
      }
    } catch {}
  }, 2500);
}

function stopEnrollPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

$("master-toggle").addEventListener("change", async (e) => {
  showError("");
  try {
    render(await send({ type: "update_settings", patch: { enabled: e.target.checked } }));
  } catch (err) {
    showError(err.message);
  }
});

$("btn-signin").addEventListener("click", async () => {
  showError("");
  $("btn-signin").disabled = true;
  try {
    await send({ type: "start_profile_signin" });
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    $("btn-signin").disabled = false;
  }
});

$("btn-check-enroll").addEventListener("click", async () => {
  showError("");
  try {
    const res = await send({ type: "check_profile_signin" });
    if (res.status === "pending") showError("Still waiting for passkey + approval on profile.botkins.app.");
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

$("btn-reopen-enroll").addEventListener("click", () => {
  if (currentSnapshot?.pendingEnroll?.url) {
    chrome.tabs.create({ url: currentSnapshot.pendingEnroll.url, active: true });
  }
});

$("btn-cancel-enroll").addEventListener("click", async () => {
  showError("");
  await send({ type: "cancel_profile_signin" }).catch(() => {});
  await refresh();
});

$("btn-refresh").addEventListener("click", async () => {
  showError("");
  try {
    await send({ type: "refresh_hosts" });
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

$("btn-signout").addEventListener("click", async () => {
  showError("");
  await send({ type: "sign_out" }).catch(() => {});
  await refresh();
});

$("mode-all").addEventListener("click", async () => {
  render(await send({ type: "update_settings", patch: { mode: "all" } }));
});

$("mode-group").addEventListener("click", async () => {
  render(await send({ type: "update_settings", patch: { mode: "group" } }));
});

$("direct-pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const input = $("direct-pair-input");
  const url = input.value.trim();
  if (!url) return;
  try {
    await send({ type: "pair_direct", url });
    input.value = "";
    await refresh();
  } catch (err) {
    showError(err.message);
  }
});

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void refresh();
