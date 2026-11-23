// The creation smokes exercise the picker without reading a public marketplace.
export function stubTemplate(app) {
  return app.evaluate(({ ipcMain }) => {
    const agent = {
      id: "archive@demo", name: "Archive Guide", role: "Research assistant", summary: "Finds primary sources.",
      marketplace: "demo", marketplaceName: "Demo", builtIn: false, look: { head: "fathom", palette: "original" },
    };
    ipcMain.removeHandler("agents.browse");
    ipcMain.handle("agents.browse", () => ({ agents: [agent], categories: [] }));
    ipcMain.removeHandler("agents.template");
    ipcMain.handle("agents.template", (_event, id) => {
      if (id !== agent.id) throw new Error("Unknown demo template");
      return { ...agent, instructions: "Cite your sources." };
    });
  });
}
