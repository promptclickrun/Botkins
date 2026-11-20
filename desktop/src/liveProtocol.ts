/** Provider wire messages shared by live voice and its protocol tests. */
export function openAiManualTurn(turnMs: number): Record<string, unknown>[] {
  return turnMs >= 250
    ? [{ type: "input_audio_buffer.commit" }, { type: "response.create" }]
    : [{ type: "input_audio_buffer.clear" }];
}

export function geminiManualTurn(action: "start" | "end"): Record<string, unknown> {
  return { realtimeInput: action === "start" ? { activityStart: {} } : { activityEnd: {} } };
}
