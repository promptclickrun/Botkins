export default function dialogs(pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    const question = await ctx.ui.select("Fixture question", ["Team", "Public"]);
    const form = typeof ctx.ui.formDialog === "function"
      ? await ctx.ui.formDialog('<form><label>Message <input name="message" required></label></form>')
      : undefined;
    const plan = await ctx.ui.confirm("Execute the fixture plan?", "Fixture preview");
    return { systemPrompt: JSON.stringify({ question, message: form?.data.message, plan }) };
  });
}
