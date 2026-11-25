// ChatGPT Responses SSE as consumed by the real bundled Pi in no-account integration tests.
export function modelReply(id, name, args, text = "Done") {
  const item = name ? { id: "fc_" + id, call_id: "call_" + id, type: "function_call", name, arguments: JSON.stringify(args), status: "completed" }
    : { id: "msg_" + id, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed" };
  const response = { id: "resp_" + id, status: "in_progress", output: [] };
  const event = (type, data) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";
  const body = event("response.created", { response }) +
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(name ? { arguments: "" } : { content: [] }) } }) +
    (name ? event("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments })
      : event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text })) +
    event("response.output_item.done", { output_index: 0, item }) +
    event("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
