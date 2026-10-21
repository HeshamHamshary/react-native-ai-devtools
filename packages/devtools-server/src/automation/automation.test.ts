import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdbInput, adbSerialFor, Automation, type OsInput, type Point } from './osInput.ts';
import { toScreen } from '../tools/mobileTools.ts';
import { startServer } from '../server.ts';
import { FakeDevice } from '../testing/FakeDevice.ts';

/** A fake `adb` that records its arguments and answers `devices` / `pidof`. */
function fakeAdb(pids: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'rnad-adb-'));
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'adb');
  const cases = Object.entries(pids)
    .map(([serial, pid]) => `  "-s ${serial} shell pidof aidevtools.example") echo "${pid}";;`)
    .join('\n');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  devices) printf 'List of devices attached\\n${Object.keys(pids).map((s) => `${s}\\tdevice`).join('\\n')}\\n';;\n${cases}\nesac\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('window points become backend coordinates', () => {
  // Android: root view at (0, 63) px on screen, density 2.625.
  assert.deepEqual(toScreen({ x: 100, y: 200 }, { x: 0, y: 63, scale: 2.625, unit: 'px' }, 'px'), { x: 262.5, y: 588 });
  // iOS: points, window at the screen origin.
  assert.deepEqual(toScreen({ x: 100, y: 200 }, { x: 0, y: 0, scale: 3, unit: 'pt' }, 'pt'), { x: 100, y: 200 });
  assert.throws(() => toScreen({ x: 1, y: 1 }, undefined, 'px'), /screen frame/);
});

test('adb input commands are built from points, keys and quoted text', async () => {
  const adb = fakeAdb({});
  const input = new AdbInput(adb.bin, 'emulator-5554');
  await input.tap({ x: 262.5, y: 588.4 });
  await input.swipe({ x: 10, y: 900 }, { x: 10, y: 300 }, 400);
  await input.longPress({ x: 5, y: 6 }, 800);
  await input.typeText("it's 50% off");
  await input.pressKey('enter');
  assert.deepEqual(adb.calls(), [
    '-s emulator-5554 shell input tap 263 588',
    '-s emulator-5554 shell input swipe 10 900 10 300 400',
    '-s emulator-5554 shell input swipe 5 6 5 6 800',
    "-s emulator-5554 shell input text 'it'\\''s%s50\\%%soff'",
    '-s emulator-5554 shell input keyevent 66',
  ]);
});

test('the adb device is the one running the app (matched by pid, never guessed)', async () => {
  const adb = fakeAdb({ 'emulator-5554': '111', 'emulator-5556': '4242' });
  const info = { platform: 'android' as const, osVersion: '16', libraryVersion: '1', window: { width: 1, height: 1, scale: 1 }, bundleId: 'aidevtools.example', pid: 4242 };
  assert.deepEqual(await adbSerialFor(adb.bin, info), { serial: 'emulator-5556' });
  assert.match((await adbSerialFor(adb.bin, { ...info, pid: 9 })).reason ?? '', /none of the adb devices .* pid 9/);
  assert.match((await adbSerialFor(adb.bin, { ...info, pid: undefined })).reason ?? '', /process id/);
});

test('iOS without a simulator or without Maestro gets a reason, not a fallback', async () => {
  const auto = new Automation({ maestro: false });
  const base = { platform: 'ios' as const, osVersion: '26', libraryVersion: '1', window: { width: 1, height: 1, scale: 3 }, bundleId: 'x' };
  assert.match((await auto.for('a', base)).reason ?? '', /physical iPhone/);
  assert.match((await auto.for('b', { ...base, simulatorUdid: 'UDID' })).reason ?? '', /Maestro/);
});

class FakeOs implements OsInput {
  readonly name = 'fake-os';
  readonly unit = 'px' as const;
  calls: string[] = [];
  tap = async (p: Point) => void this.calls.push(`tap ${p.x},${p.y}`);
  longPress = async (p: Point, ms: number) => void this.calls.push(`long ${p.x},${p.y} ${ms}`);
  swipe = async (a: Point, b: Point, ms: number) => void this.calls.push(`swipe ${a.x},${a.y}->${b.x},${b.y} ${ms}`);
  typeText = async (t: string) => void this.calls.push(`type ${t}`);
  pressKey = async (k: string) => void this.calls.push(`key ${k}`);
}

test('mode os: the device prepares and reports, the OS injects; unavailable means no action at all', async () => {
  const os = new FakeOs();
  let available = true;
  const automation = { for: async () => (available ? { input: os } : { reason: 'no emulator attached' }), forget() {}, close: async () => {}, nativeLogs: async () => ({ lines: [] }) } as unknown as Automation;
  const s = await startServer({ port: 0, lan: false, repoRoots: [], allowEdits: false, agent: false, mcp: false, log: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'rnad-state-')), env: {}, automation });
  const d = new FakeDevice(`ws://127.0.0.1:${s.port}`);
  try {
    await d.opened();
    d.hello();
    await d.next('welcome');
    const rpc: string[] = [];
    d.handlers.prepareExternal = (p) => (rpc.push(`prepare ${JSON.stringify(p)}`), { token: 'x1', point: { x: 100, y: 200 }, frame: { x: 0, y: 63, scale: 2, unit: 'px' } });
    d.handlers.finishExternal = (p) => (rpc.push(`finish ${JSON.stringify(p)}`), { ok: true, action: 'tap', mode: 'os-injected', durationMs: 5, target: { ref: 'e5', role: 'button', label: 'Log in' } });
    d.handlers.tap = () => (rpc.push('in-app tap'), { ok: true, action: 'tap', mode: 'semantic', durationMs: 1 });
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await (await fetch(`http://127.0.0.1:${s.port}/api/tool`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ name, args }) })).json()) as {
        content: { text: string }[];
        isError?: boolean;
      };

    const ok = await tool('mobile_tap', { target: 'e5', mode: 'os' });
    assert.match(ok.content[0]!.text, /✓ tap e5 button "Log in" \(mode=os-injected/);
    assert.deepEqual(os.calls, ['tap 200,463']);
    assert.deepEqual(rpc, ['prepare {"action":"tap","target":"e5"}', 'finish {"token":"x1","ok":true,"backend":"fake-os"}']);

    rpc.length = 0;
    available = false;
    const refused = await tool('mobile_tap', { target: 'e5', mode: 'os' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /UNSUPPORTED: no OS-level input for this device: no emulator attached\. No other interaction mode was used\./);
    assert.deepEqual(rpc, [], 'neither prepared nor tapped in-app');

    // An OS failure is reported by the device as a failed action, never as success.
    available = true;
    os.tap = async () => {
      throw new Error('device offline');
    };
    d.handlers.finishExternal = (p) => ({ ok: false, action: 'tap', durationMs: 1, error: { code: 'NATIVE_ERROR', message: `OS automation (${(p as { backend: string }).backend}) failed: ${(p as { error: string }).error}` } });
    const failed = await tool('mobile_tap', { target: 'e5', mode: 'os' });
    assert.match(failed.content[0]!.text, /failed: NATIVE_ERROR[\s\S]*device offline/);
  } finally {
    d.close();
    await s.close();
  }
});
