// Updated by scripts/update-pass-cli.mjs, never by the running app.
export const VERSION = "2.7.1";

export const PINS = {
  "darwin-arm64": { asset: "pass-cli-macos-aarch64", sizeBytes: 39848576, sha256: "0f5f749372c77f279f92463c56c3dda777fc3157e5f90ef49ade17bca7e46ba3" },
  "darwin-x64": { asset: "pass-cli-macos-x86_64", sizeBytes: 42576608, sha256: "ea3a6a133292230008e577ebcdf1a0a604177fd9107fdee287c8ed84ef164cd9" },
  "linux-arm64": { asset: "pass-cli-linux-aarch64", sizeBytes: 37544600, sha256: "43616b8c38b44dae702679b376726889a1f9dc767cf86932b29b03d89a93b283" },
  "linux-x64": { asset: "pass-cli-linux-x86_64", sizeBytes: 54883456, sha256: "3e9520fe79ab4698e03905c8bf0fff4889b3028975e832a5f801a9c82008b612" },
  "win32-x64": { asset: "pass-cli-windows-x86_64.zip", sizeBytes: 15899991, sha256: "d803bea784ee55abe6091fd4e493d8c3cfefaef48748b03760be73401fa3838a", files: { "pass-cli.exe": "a6cfe134e64301da757bddce280bbf167306b194581880f86e5d202ee675463c", "libcrypto-3-x64.dll": "88b1760db84d724cf5bc40be5dcbcd0a835e42c3ed239e397a61f73acabbf4c8" } },
};
