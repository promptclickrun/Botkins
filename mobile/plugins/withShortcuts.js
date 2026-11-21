const { IOSConfig, withXcodeProject } = require("expo/config-plugins");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

// App Intents metadata must be extracted from the application target. The system runs these
// actions in Botkins, where the existing pairing and React Native runtime are available.
module.exports = config => withXcodeProject(config, mod => {
  const groupName = mod.modRequest.projectName;
  const project = mod.modResults;
  for (const name of ["ChatShortcuts.swift", "ShortcutPickers.swift"]) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: "../plugins/shortcuts/" + name, groupName, project });
  }
  const assets = "targets/widgets/assets";
  for (const name of readdirSync(join(mod.modRequest.projectRoot, assets)).filter(file => /^provider-[a-z]+\.png$/.test(file))) {
    IOSConfig.XcodeUtils.addResourceFileToGroup({ filepath: "../" + assets + "/" + name, groupName, project, isBuildFile: true });
  }
  return mod;
});
