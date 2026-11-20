import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("MicGate closes during bot output, detects intentional barge-in, and supports push to talk", () => {
  const script = String.raw`
    import { MicGate } from './src/liveInput.ts';
    let now = 0;
    const gate = new MicGate('conversation', () => now);
    gate.playing(true);
    if (gate.frame('AAAA', 0.01).send.length !== 0) throw new Error('sent microphone during bot output');
    for (let i = 0; i < 5; i++) {
      const result = gate.frame('BBBB', 0.9);
      if (i < 4 && result.barge) throw new Error('barge-in triggered too soon');
      if (i === 4 && !result.barge) throw new Error('barge-in was not detected');
    }
    gate.cut();
    now += 500;
    if (gate.frame('CCCC', 0.1).send.length !== 1) throw new Error('microphone did not reopen after cut');
    const push = new MicGate('push', () => now);
    if (push.frame('DDDD', 0.1).send.length !== 0) throw new Error('push-to-talk sent while released');
    push.press();
    if (push.frame('EEEE', 0.1).send.length !== 1) throw new Error('push-to-talk did not open while held');
    push.release();
    if (push.frame('FFFF', 0.1).send.length !== 1) throw new Error('push-to-talk did not preserve its release tail');
    now += 300;
    if (push.frame('GGGG', 0.1).send.length !== 0) throw new Error('push-to-talk reopened without a new press');
    push.press();
    if (push.frame('HHHH', 0.1).send.length !== 1) throw new Error('push-to-talk did not reopen after a new press');
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("manual live voice turns use the provider protocol for OpenAI, Codex and Gemini", () => {
  const script = String.raw`
    import { openAiManualTurn, geminiManualTurn } from './src/liveProtocol.ts';
    const long = openAiManualTurn(300);
    if (long.map((message) => message.type).join(',') !== 'input_audio_buffer.commit,response.create') throw new Error('OpenAI manual turn did not commit and create a response');
    if (openAiManualTurn(100)[0].type !== 'input_audio_buffer.clear') throw new Error('short turn was not cleared');
    if (JSON.stringify(geminiManualTurn('start')) !== JSON.stringify({ realtimeInput: { activityStart: {} } })) throw new Error('Gemini activityStart missing');
    if (JSON.stringify(geminiManualTurn('end')) !== JSON.stringify({ realtimeInput: { activityEnd: {} } })) throw new Error('Gemini activityEnd missing');
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
