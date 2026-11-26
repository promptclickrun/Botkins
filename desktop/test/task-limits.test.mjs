import test from "node:test";
import assert from "node:assert/strict";
import { taskLimits, taskLimitField } from "../desktop/task-limits.mjs";
import { changeSettings } from "../desktop/preferences.mjs";

test("task limits: the setting wins, then the environment, then the default", () => {
  assert.deepEqual(taskLimits({}, {}), { tasksMax: 2, tasksPerBot: 1, defaults: { tasksMax: 2, tasksPerBot: 1 } });
  const env = { BOTKINS_TASKS_MAX: "6", BOTKINS_TASKS_PER_BOT: "3" };
  assert.deepEqual(taskLimits({}, env), { tasksMax: 6, tasksPerBot: 3, defaults: { tasksMax: 6, tasksPerBot: 3 } });
  assert.deepEqual(taskLimits({ tasksMax: 4, tasksPerBot: 2 }, env), { tasksMax: 4, tasksPerBot: 2, defaults: { tasksMax: 6, tasksPerBot: 3 } });
});

test("task limits: environment values clamp to the range, and junk is ignored", () => {
  assert.deepEqual(taskLimits({}, { BOTKINS_TASKS_MAX: "99", BOTKINS_TASKS_PER_BOT: "0" }), { tasksMax: 16, tasksPerBot: 1, defaults: { tasksMax: 16, tasksPerBot: 1 } });
  assert.equal(taskLimits({}, { BOTKINS_TASKS_MAX: "lots" }).tasksMax, 2);
  assert.equal(taskLimits({}, { BOTKINS_TASKS_MAX: "2.5" }).tasksMax, 2);
  assert.equal(taskLimits({ tasksMax: 40 }, {}).tasksMax, 2, "a bad saved value falls back");
});

test("task limits: setPreferences takes whole numbers in range, null clears, anything else is refused", () => {
  assert.equal(changeSettings({}, { tasksMax: 16 }).tasksMax, 16);
  assert.equal(changeSettings({}, { tasksPerBot: 8 }).tasksPerBot, 8);
  assert.equal(Object.hasOwn(changeSettings({ tasksMax: 5 }, { tasksMax: null }), "tasksMax"), false);
  for (const value of [0, 17, 2.5, "4", true, undefined]) assert.throws(() => changeSettings({}, { tasksMax: value }), /Choose 1 to 16 tasks at once/);
  for (const value of [0, 9, -1]) assert.throws(() => taskLimitField("tasksPerBot", value), /Choose 1 to 8/);
});
