const $ = (id) => document.getElementById(id);

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "get_status" });
  if (!res?.ok) return;
  const s = res.data.settings;
  $("profile-label").value = s.profileLabel || "";
  $("mode").value = s.mode || "all";
  $("group-name").value = s.groupName || "Botkins";
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("saved").textContent = "";
  const patch = {
    profileLabel: $("profile-label").value.trim().slice(0, 40),
    mode: $("mode").value === "group" ? "group" : "all",
    groupName: $("group-name").value.trim().slice(0, 32) || "Botkins",
  };
  const res = await chrome.runtime.sendMessage({ type: "update_settings", patch });
  if (res?.ok) {
    $("saved").textContent = "Saved.";
    setTimeout(() => { $("saved").textContent = ""; }, 2000);
  }
});

void load();
