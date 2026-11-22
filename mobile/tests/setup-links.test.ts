// The links "Set up a new Botkins" opens (src/features/pair/setupLinks.ts).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { AZURE_DEPLOY_URL } from "../src/features/pair/setupLinks";

test("Deploy to Azure names the repo's template and form, encoded as the portal wants", () => {
  assert.equal(
    AZURE_DEPLOY_URL,
    "https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fpromptclickrun%2FBotkins%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json",
  );
  // The files it points at are in this repo, where main serves them from.
  for (const file of ["azuredeploy.json", "createUiDefinition.json"]) assert.ok(existsSync(new URL("../../deploy/azure/" + file, import.meta.url)), file);
});

