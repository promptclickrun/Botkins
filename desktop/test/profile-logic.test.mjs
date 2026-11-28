import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmDeleteProfile,
  confirmDisconnectHost,
  confirmRemovePhoto,
  confirmRevokeDevice,
  confirmSignOut,
  DESKTOP_CONFIRM_COPY,
  desktopHostStatus,
  desktopPendingBanner,
  desktopProfileSummary,
  orderDesktopDevices,
} from "../src/profileLogic.ts";

test("desktopHostStatus maps paired/offline/add hosts to badges and short subtitles", () => {
  const own = { serverId: "s1", serverKey: "k1", name: "Mac Studio", hosts: ["10.0.0.2:6365"] };
  assert.deepEqual(desktopHostStatus(own, true), {
    kind: "ready",
    label: "Ready",
    pillClass: "ok",
    subtitle: "Your computer",
  });
  assert.deepEqual(desktopHostStatus({ ...own, member: true }, true), {
    kind: "ready",
    label: "Ready",
    pillClass: "ok",
    subtitle: "You're a member",
  });
  assert.deepEqual(desktopHostStatus({ ...own, hosts: [] }, false), {
    kind: "offline",
    label: "Offline",
    pillClass: "warn",
    subtitle: "Waiting for computer to come online",
  });
  assert.deepEqual(desktopHostStatus({ ...own, member: true }, false), {
    kind: "add",
    label: "Add",
    pillClass: "acc",
    subtitle: "You're a member · open to connect",
  });
});

test("orderDesktopDevices puts current device first and desktopProfileSummary computes subtitles", () => {
  const hosts = [
    { serverId: "s1", serverKey: "k1", name: "Mac Studio", hosts: ["10.0.0.2:6365"] },
    { serverId: "s2", serverKey: "k2", name: "VPS", hosts: ["1.2.3.4:6365"] },
    { serverId: "s3", serverKey: "k3", name: "Old laptop", hosts: [] },
  ];
  const devices = [
    { id: "d2", label: "iPhone", current: false },
    { id: "d1", label: "Mac Studio", current: true },
    { id: "d3", label: "Pixel 9", current: false },
  ];
  assert.deepEqual(orderDesktopDevices(devices).map((d) => d.id), ["d1", "d2", "d3"]);

  const summary = desktopProfileSummary({
    hosts,
    devices,
    pairedServerIds: new Set(["s2"]),
    localServerId: "s1",
  });
  assert.equal(summary.computersCount, 3);
  assert.equal(summary.computersReadyCount, 2);
  assert.equal(summary.computersSubtitle, "2 ready on this computer");
  assert.equal(summary.devicesCount, 3);
  assert.equal(summary.devicesSubtitle, "Mac Studio and 2 more");
});

test("desktopPendingBanner formats single and multiple pending approvals", () => {
  assert.equal(desktopPendingBanner([]), null);
  assert.deepEqual(desktopPendingBanner([{ id: "p1", label: "iPad", code: "482913" }]), {
    title: "A device wants in",
    subtitle: "iPad · code 482 913",
  });
  assert.deepEqual(
    desktopPendingBanner([
      { id: "p1", label: "iPad", code: "482913" },
      { id: "p2", label: "Pixel", code: "111222" },
    ]),
    {
      title: "2 devices want in",
      subtitle: "iPad · code 482 913 (+1 more)",
    },
  );
});

test("HARD RULE (desktop): every destructive profile action calls confirm before the API", () => {
  // 1. Revoke device (blocked on current, confirmed on others)
  {
    const prompts = [];
    const revoked = [];
    assert.equal(confirmRevokeDevice({ id: "d1", current: true }, (m) => { prompts.push(m); return true; }, (id) => revoked.push(id)), false);
    assert.equal(prompts.length, 0);
    assert.equal(revoked.length, 0);

    // Declined confirm -> no API call
    assert.equal(confirmRevokeDevice({ id: "d2", current: false }, (m) => { prompts.push(m); return false; }, (id) => revoked.push(id)), false);
    assert.deepEqual(prompts, [DESKTOP_CONFIRM_COPY.revokeDevice]);
    assert.equal(revoked.length, 0);

    // Accepted confirm -> API called
    assert.equal(confirmRevokeDevice({ id: "d2", current: false }, (m) => { prompts.push(m); return true; }, (id) => revoked.push(id)), true);
    assert.deepEqual(revoked, ["d2"]);
  }

  // 2. Disconnect / remove computer from profile
  {
    const prompts = [];
    let calls = 0;
    assert.equal(confirmDisconnectHost((m) => { prompts.push(m); return false; }, () => { calls += 1; }), false);
    assert.deepEqual(prompts, [DESKTOP_CONFIRM_COPY.disconnectHost]);
    assert.equal(calls, 0);

    assert.equal(confirmDisconnectHost((m) => { prompts.push(m); return true; }, () => { calls += 1; }), true);
    assert.equal(calls, 1);
  }

  // 3. Remove photo
  {
    const prompts = [];
    let calls = 0;
    assert.equal(confirmRemovePhoto((m) => { prompts.push(m); return false; }, () => { calls += 1; }), false);
    assert.deepEqual(prompts, [DESKTOP_CONFIRM_COPY.removePhoto]);
    assert.equal(calls, 0);

    assert.equal(confirmRemovePhoto((m) => { prompts.push(m); return true; }, () => { calls += 1; }), true);
    assert.equal(calls, 1);
  }

  // 4. Sign out
  {
    const prompts = [];
    let calls = 0;
    assert.equal(confirmSignOut((m) => { prompts.push(m); return false; }, () => { calls += 1; }), false);
    assert.deepEqual(prompts, [DESKTOP_CONFIRM_COPY.signOut]);
    assert.equal(calls, 0);

    assert.equal(confirmSignOut((m) => { prompts.push(m); return true; }, () => { calls += 1; }), true);
    assert.equal(calls, 1);
  }

  // 5. Delete profile (typed email mismatch rejects before confirm; declined confirm rejects before API)
  {
    const prompts = [];
    const deleted = [];
    const mismatch = confirmDeleteProfile("wrong@example.com", "colt@example.com", (m) => { prompts.push(m); return true; }, (e) => deleted.push(e));
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error ?? "", /verified profile email/i);
    assert.equal(prompts.length, 0);
    assert.equal(deleted.length, 0);

    const declined = confirmDeleteProfile("colt@example.com", "colt@example.com", (m) => { prompts.push(m); return false; }, (e) => deleted.push(e));
    assert.equal(declined.ok, false);
    assert.deepEqual(prompts, [DESKTOP_CONFIRM_COPY.deleteProfile]);
    assert.equal(deleted.length, 0);

    const accepted = confirmDeleteProfile("colt@example.com", "colt@example.com", (m) => { prompts.push(m); return true; }, (e) => deleted.push(e));
    assert.equal(accepted.ok, true);
    assert.deepEqual(deleted, ["colt@example.com"]);
  }
});
