// Where "Set up a new Botkins" (src/features/pair/Setup.tsx) sends a person. Plain values, so the tests read them.

/** The latest desktop and terminal downloads, for a Mac, Windows or Linux computer. */
export const DOWNLOAD_URL = "https://github.com/promptclickrun/Botkins/releases/latest";

const RAW = "https://raw.githubusercontent.com/promptclickrun/Botkins/main/deploy/azure/";

/** The Azure portal's "Deploy to Azure" page for deploy/azure: the template and its form, each as an encoded URL. */
export const AZURE_DEPLOY_URL =
  "https://portal.azure.com/#create/Microsoft.Template/uri/" + encodeURIComponent(RAW + "azuredeploy.json") + "/createUIDefinitionUri/" + encodeURIComponent(RAW + "createUiDefinition.json");
