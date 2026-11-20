// electron-builder `win.signtoolOptions.sign` hook: signs each file with Azure Artifact (Trusted)
// Signing through jsign, so a Mac or Linux build host can sign Windows files.
// Needs `jsign` on PATH and an `az login` that holds the "Artifact Signing Certificate Profile Signer" role.
const { execFileSync } = require("node:child_process");

const endpoint = process.env.BOTKINS_SIGN_ENDPOINT || "eus.codesigning.azure.net";
const account = process.env.BOTKINS_SIGN_ACCOUNT;
const profile = process.env.BOTKINS_SIGN_PROFILE;

let token;
function accessToken() {
  token ??= execFileSync(
    "az",
    ["account", "get-access-token", "--resource", "https://codesigning.azure.net", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf8" },
  ).trim();
  return token;
}

exports.default = async function sign(config) {
  // Microsoft's own binaries keep Microsoft's signature, as on the Mac (build.mac.signIgnore).
  if (/[\\/]node_modules[\\/]@microsoft[\\/]/.test(config.path)) return;
  if (!account) throw new Error("Set BOTKINS_SIGN_ACCOUNT to your signing account name.");
  if (!profile) throw new Error("Set BOTKINS_SIGN_PROFILE to the Artifact Signing certificate profile name.");
  execFileSync(
    "jsign",
    [
      "--storetype", "TRUSTEDSIGNING",
      "--keystore", endpoint,
      "--storepass", "env:BOTKINS_JSIGN_TOKEN",
      "--alias", `${account}/${profile}`,
      "--alg", "SHA-256",
      "--tsaurl", "http://timestamp.acs.microsoft.com",
      "--tsmode", "RFC3161",
      "--name", config.name,
      "--replace",
      config.path,
    ],
    { env: { ...process.env, BOTKINS_JSIGN_TOKEN: accessToken() }, stdio: ["ignore", "inherit", "inherit"] },
  );
};
