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

test("GeminiLiveSession pairs push-to-talk activity signals, waits for setupComplete, and handles fast double presses", () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { GeminiLiveSession, formatGeminiCloseError } from './src/liveProtocol.ts';

    const sent = [];
    const socket = {
      readyState: 0,
      send(raw) { sent.push(JSON.parse(raw)); },
    };
    const baseSetup = {
      setup: {
        model: 'models/gemini-3.8-live',
        realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH' } },
      },
    };
    const session = new GeminiLiveSession('push', baseSetup, 16000);

    // Nothing goes out before the socket opens or before setupComplete arrives.
    assert.equal(session.press(socket), false);
    assert.equal(session.release(socket), false);
    socket.readyState = 1;
    assert.equal(session.onOpen(socket), true);
    assert.deepEqual(sent, [
      {
        setup: {
          model: 'models/gemini-3.8-live',
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      },
    ]);
    assert.equal(session.press(socket), false);
    assert.equal(session.sendAudio(socket, 'EARLY'), false);
    assert.equal(session.release(socket), false);
    assert.equal(sent.length, 1);

    // After setupComplete, push-to-talk brackets audio between one activityStart and one activityEnd.
    session.onSetupComplete();
    assert.equal(session.sendAudio(socket, 'IDLE'), false);
    assert.equal(session.press(socket), true);
    assert.equal(session.sendAudio(socket, 'ONE'), true);
    // A second press before release ends keeps the existing activity open without sending a duplicate start.
    assert.equal(session.press(socket), true);
    assert.equal(session.sendAudio(socket, 'TWO'), true);
    assert.equal(session.mute(socket, true), false);
    assert.equal(session.release(socket), true);
    // Audio arriving after activityEnd and a duplicate release must be ignored.
    assert.equal(session.sendAudio(socket, 'LATE'), false);
    assert.equal(session.release(socket), false);

    assert.deepEqual(sent.slice(1), [
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { audio: { data: 'ONE', mimeType: 'audio/pcm;rate=16000' } } },
      { realtimeInput: { audio: { data: 'TWO', mimeType: 'audio/pcm;rate=16000' } } },
      { realtimeInput: { activityEnd: {} } },
    ]);
    assert.ok(!sent.some((message) => 'audioStreamEnd' in (message.realtimeInput ?? {})));

    // Precondition close reasons become actionable; other close reasons stay clear.
    const precondition = formatGeminiCloseError('Precondition check failed.', false);
    assert.match(precondition, /precondition/i);
    assert.match(precondition, /restart|switch/i);
    assert.equal(formatGeminiCloseError('Model not found', true), 'Gemini refused the call: Model not found.');
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
