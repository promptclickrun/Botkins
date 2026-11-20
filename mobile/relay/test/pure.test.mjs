// Unit tests of the relay's pure helpers (src/pure.ts). Node reads the TypeScript directly.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { before, describe, it } from "node:test";
import { HOST_PROTOCOL, MAX_SKEW, hostChallenge, hostProof, networkOf, roomOf } from "../src/pure.ts";

describe("networkOf", () => {
  it("leaves IPv4 and local alone", () => {
    assert.equal(networkOf("203.0.113.7"), "203.0.113.7");
    assert.equal(networkOf("local"), "local");
  });

  it("reduces a full IPv6 address to its /64", () => {
    assert.equal(networkOf("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:DB8:1:2:0:0:0:1"), "2001:db8:1:2::/64");
  });

  it("expands :: before it cuts", () => {
    assert.equal(networkOf("2001:db8:1:2::1"), "2001:db8:1:2::/64");
    assert.equal(networkOf("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(networkOf("2001:db8:1::5:6:7:8"), "2001:db8:1:0::/64");
    assert.equal(networkOf("::1"), "0:0:0:0::/64");
    assert.equal(networkOf("::"), "0:0:0:0::/64");
    assert.equal(networkOf("fe80::"), "fe80:0:0:0::/64");
  });

  it("gives every address in one /64 the same answer, and the next /64 another", () => {
    const one = networkOf("2001:db8:1:2::1");
    assert.equal(networkOf("2001:db8:1:2:ffff:ffff:ffff:ffff"), one);
    assert.notEqual(networkOf("2001:db8:1:3::1"), one);
    assert.notEqual(networkOf("2001:db8:2:2::1"), one);
  });

  it("turns an IPv4-mapped address into the IPv4 address", () => {
    assert.equal(networkOf("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(networkOf("::FFFF:203.0.113.7"), "203.0.113.7");
    assert.equal(networkOf("::ffff:cb00:7107"), "203.0.113.7");
    assert.equal(networkOf("0:0:0:0:0:ffff:cb00:7107"), "203.0.113.7");
    assert.equal(networkOf("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  });

  it("drops a zone suffix", () => {
    assert.equal(networkOf("fe80::1%eth0"), "fe80:0:0:0::/64");
    assert.equal(networkOf("2001:db8:1:2::1%3"), "2001:db8:1:2::/64");
    assert.equal(networkOf("::ffff:203.0.113.7%lo"), "203.0.113.7");
  });

  it("returns what it can not parse unchanged", () => {
    for (const odd of ["2001:db8::1::2", "2001:db8:1:2:3:4:5", "1:2:3:4:5:6:7:8:9", "gggg::1", "::ffff:300.1.1.1", "12345::1", ""]) {
      assert.equal(networkOf(odd), odd);
    }
  });
});

describe("hostProof", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" }).x;
  let room = "";
  before(async () => {
    room = await roomOf(key);
  });
  const make = (seconds) => [
    HOST_PROTOCOL,
    "k." + key,
    "t." + seconds,
    "s." + sign(null, Buffer.from(hostChallenge(room, String(seconds))), privateKey).toString("base64url"),
  ];

  it("accepts a good proof up to 300 seconds either way, and no further", async () => {
    const now = 1_800_000_000;
    assert.equal(await hostProof(make(now), room, now), true);
    assert.equal(await hostProof(make(now - MAX_SKEW), room, now), true);
    assert.equal(await hostProof(make(now + MAX_SKEW), room, now), true);
    assert.equal(await hostProof(make(now - MAX_SKEW - 1), room, now), false);
    assert.equal(await hostProof(make(now + MAX_SKEW + 1), room, now), false);
  });

  it("refuses another room, a changed time and a missing part", async () => {
    const now = 1_800_000_000;
    const good = make(now);
    assert.equal(await hostProof(good, "A".repeat(43), now), false);
    assert.equal(await hostProof([good[0], good[1], "t." + (now + 1), good[3]], room, now), false);
    for (let i = 0; i < 4; i++) assert.equal(await hostProof(good.filter((_, at) => at !== i), room, now), false);
    assert.equal(await hostProof([...good, good[1]], room, now), false);
  });
});
