import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DeviceInfo } from 'react-native-agent-devtools-protocol';
import { redactText } from 'react-native-agent-devtools-protocol';

export interface Point {
  x: number;
  y: number;
}

/**
 * Input injected by the operating system's automation layer from outside the app:
 * the same path a finger takes (hit-testing, gesture recognizers, the RN responder
 * system). Results of actions through it are reported as `os-injected`.
 */
export interface OsInput {
  readonly name: string;
  /** Coordinate unit the backend expects: physical pixels or points. */
  readonly unit: 'px' | 'pt';
  tap(p: Point): Promise<void>;
  longPress(p: Point, ms: number): Promise<void>;
  swipe(from: Point, to: Point, ms: number): Promise<void>;
  /** Type into the focused field, key by key. */
  typeText(text: string): Promise<void>;
  pressKey(key: 'enter' | 'back'): Promise<void>;
  /** Tap the element showing this exact text (native alerts on iOS). */
  tapText?(text: string): Promise<void>;
}

export interface DeviceIdentity extends DeviceInfo {
  simulatorUdid?: string;
  pid?: number;
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ------------------------------------------------------------------------- adb

export function findAdb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const home of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    const p = home && join(home, 'platform-tools', 'adb');
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/** Quote one argument for the device's /bin/sh (adb shell joins its arguments). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `adb shell input`: Android's own input injection (InputManager), delivered like real touches. */
export class AdbInput implements OsInput {
  readonly name = 'adb';
  readonly unit = 'px' as const;
  private readonly adb: string;
  readonly serial: string;

  constructor(adb: string, serial: string) {
    this.adb = adb;
    this.serial = serial;
  }

  private async input(...args: string[]): Promise<void> {
    const r = await run(this.adb, ['-s', this.serial, 'shell', 'input', ...args]);
    if (r.code !== 0) throw new Error(`adb input ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }

  tap(p: Point) {
    return this.input('tap', String(Math.round(p.x)), String(Math.round(p.y)));
  }

  longPress(p: Point, ms: number) {
    const x = String(Math.round(p.x));
    const y = String(Math.round(p.y));
    return this.input('swipe', x, y, x, y, String(Math.round(ms)));
  }

  swipe(from: Point, to: Point, ms: number) {
    return this.input('swipe', ...[from.x, from.y, to.x, to.y].map((n) => String(Math.round(n))), String(Math.round(ms)));
  }

  async typeText(text: string) {
    // `input text` treats %s as a space; send in chunks so long text doesn't hit shell limits.
    for (let i = 0; i < text.length; i += 40) await this.input('text', shq(text.slice(i, i + 40).replace(/%/g, '\\%').replace(/ /g, '%s')));
  }

  pressKey(key: 'enter' | 'back') {
    return this.input('keyevent', key === 'enter' ? '66' : '4');
  }
}

/** The adb device running this app: matched by the app's process id, never guessed. */
export async function adbSerialFor(adb: string, device: DeviceIdentity): Promise<{ serial?: string; reason?: string }> {
  const list = await run(adb, ['devices']);
  if (list.code !== 0) return { reason: 'adb is not responding' };
  const serials = list.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]!);
  if (!serials.length) return { reason: 'no Android device or emulator is attached to adb' };
  if (!device.bundleId || !device.pid) return { reason: 'the app did not report its package and process id (rebuild the app)' };
  for (const serial of serials) {
    const r = await run(adb, ['-s', serial, 'shell', 'pidof', device.bundleId], 5_000);
    if (r.stdout.trim().split(/\s+/).includes(String(device.pid))) return { serial };
  }
  return { reason: `none of the adb devices (${serials.join(', ')}) runs ${device.bundleId} with pid ${device.pid}` };
}

// --------------------------------------------------------------------- Maestro

/** One long-lived `maestro mcp` process (its XCUITest/UiAutomator driver stays warm). */
export class MaestroDriver {
  private client?: Promise<Client>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly command: string;

  constructor(command = 'maestro') {
    this.command = command;
  }

  static async available(command = 'maestro'): Promise<boolean> {
    return (await run(command, ['--version'], 20_000)).code === 0;
  }

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const c = new Client({ name: 'react-native-agent-devtools', version: '1' }, { capabilities: {} });
      // Local devices only: the viewer stays off and cloud tools are never called.
      await c.connect(new StdioClientTransport({ command: this.command, args: ['mcp', '--no-viewer'], stderr: 'ignore' }));
      return c;
    })().catch((e: unknown) => {
      this.client = undefined;
      throw e;
    });
    return this.client;
  }

  /** Run Maestro commands on one device, one batch at a time. */
  run(deviceId: string, appId: string, commands: string): Promise<void> {
    const next = this.queue.then(async () => {
      const c = await this.connect();
      const r = await c.callTool({ name: 'run', arguments: { device_id: deviceId, yaml: `appId: ${appId}\n---\n${commands}` } }, undefined, { timeout: 60_000 });
      const text = (r.content as { type: string; text?: string }[] | undefined)?.find((b) => b.type === 'text')?.text ?? '';
      let ok = !r.isError;
      let message = text;
      try {
        const parsed = JSON.parse(text) as { success?: boolean; message?: string };
        ok = ok && parsed.success !== false;
        message = parsed.message ?? text;
      } catch {
        // plain-text result
      }
      if (!ok) throw new Error(`Maestro: ${message.slice(0, 300)}`);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    const c = await this.client?.catch(() => undefined);
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }
}

const pt = (p: Point) => `"${Math.round(p.x)},${Math.round(p.y)}"`;
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** OS-level input through Maestro (XCUITest on the iOS simulator). */
export class MaestroInput implements OsInput {
  readonly name = 'maestro';
  readonly unit: 'px' | 'pt';
  private readonly driver: MaestroDriver;
  private readonly deviceId: string;
  private readonly appId: string;

  constructor(driver: MaestroDriver, deviceId: string, appId: string, unit: 'px' | 'pt') {
    this.driver = driver;
    this.deviceId = deviceId;
    this.appId = appId;
    this.unit = unit;
  }

  private run(commands: string) {
    return this.driver.run(this.deviceId, this.appId, commands);
  }

  tap(p: Point) {
    return this.run(`- tapOn:\n    point: ${pt(p)}\n    retryTapIfNoChange: false`);
  }

  longPress(p: Point) {
    return this.run(`- longPressOn:\n    point: ${pt(p)}`);
  }

  swipe(from: Point, to: Point, ms: number) {
    return this.run(`- swipe:\n    start: ${pt(from)}\n    end: ${pt(to)}\n    duration: ${Math.round(ms)}`);
  }

  typeText(text: string) {
    return this.run(`- inputText: ${JSON.stringify(text)}`);
  }

  pressKey(key: 'enter' | 'back') {
    return this.run(`- pressKey: ${key === 'enter' ? 'Enter' : 'back'}`);
  }

  tapText(text: string) {
    return this.run(`- tapOn: ${JSON.stringify(`^${regexEscape(text)}$`)}`);
  }
}

// -------------------------------------------------------------------- registry

export interface AutomationOptions {
  /** Allow Maestro (default true when installed). */
  maestro?: boolean;
  adbPath?: string;
}

/** Picks the OS-level input backend for a connected app, or says why there is none. */
export class Automation {
  private readonly opts: AutomationOptions;
  private maestro?: MaestroDriver;
  private maestroOk?: Promise<boolean>;
  private cache = new Map<string, Promise<{ input?: OsInput; reason?: string }>>();

  constructor(opts: AutomationOptions = {}) {
    this.opts = opts;
  }

  private maestroAvailable(): Promise<boolean> {
    if (this.opts.maestro === false) return Promise.resolve(false);
    this.maestroOk ??= MaestroDriver.available();
    return this.maestroOk;
  }

  for(deviceId: string, info: DeviceIdentity): Promise<{ input?: OsInput; reason?: string }> {
    let entry = this.cache.get(deviceId);
    if (!entry) {
      entry = this.resolve(info);
      this.cache.set(deviceId, entry);
      // Don't remember failures: the developer may start an emulator or install Maestro.
      void entry.then((r) => !r.input && this.cache.delete(deviceId));
    }
    return entry;
  }

  forget(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  private async resolve(info: DeviceIdentity): Promise<{ input?: OsInput; reason?: string }> {
    if (info.platform === 'android') {
      const adb = this.opts.adbPath ?? findAdb();
      if (!adb) return { reason: 'adb was not found (set ANDROID_HOME)' };
      const { serial, reason } = await adbSerialFor(adb, info);
      return serial ? { input: new AdbInput(adb, serial) } : { reason: reason ?? 'device not found in adb' };
    }
    if (!info.simulatorUdid) {
      return { reason: 'OS-level input on a physical iPhone needs an XCUITest runner signed for the device, which is not supported yet' };
    }
    if (!(await this.maestroAvailable())) {
      return { reason: 'OS-level input on the iOS simulator uses Maestro (XCUITest); install it (https://maestro.dev, Apache-2.0) and restart the server' };
    }
    if (!info.bundleId) return { reason: 'the app did not report its bundle id' };
    this.maestro ??= new MaestroDriver();
    return { input: new MaestroInput(this.maestro, info.simulatorUdid, info.bundleId, 'pt') };
  }

  /**
   * Native log lines of the app's own process, read on this computer: logcat for the
   * app's pid (Android), the unified log for the simulator process (iOS). JS console
   * output is excluded on Android (it is already in mobile_get_logs). Redacted.
   */
  async nativeLogs(info: DeviceIdentity, opts: { errorsOnly: boolean; limit: number; seconds: number }): Promise<{ lines: string[]; source?: string; reason?: string }> {
    if (!info.pid) return { lines: [], reason: 'the app did not report its process id (rebuild the app)' };
    let lines: string[];
    let source: string;
    if (info.platform === 'android') {
      const adb = this.opts.adbPath ?? findAdb();
      if (!adb) return { lines: [], reason: 'adb was not found (set ANDROID_HOME)' };
      const { serial, reason } = await adbSerialFor(adb, info);
      if (!serial) return { lines: [], reason };
      const r = await run(adb, ['-s', serial, 'logcat', '-d', '-v', 'time', `--pid=${info.pid}`, '-t', String(Math.max(200, opts.limit * 10)), ...(opts.errorsOnly ? ['*:W'] : [])], 20_000);
      if (r.code !== 0) return { lines: [], reason: `adb logcat failed: ${r.stderr.trim().slice(0, 200)}` };
      lines = r.stdout.split('\n').filter((l) => l.trim() && !/ReactNativeJS|^-----/.test(l));
      if (opts.errorsOnly) lines = lines.filter((l) => /^\S+ \S+ [EFW]\//.test(l));
      source = `adb logcat (${serial}, pid ${info.pid})`;
    } else {
      if (!info.simulatorUdid) return { lines: [], reason: 'native logs of a physical iPhone are not available here (use Console.app or Xcode)' };
      const predicate = `processID == ${info.pid}${opts.errorsOnly ? ' AND (messageType == error OR messageType == fault)' : ''}`;
      const r = await run('xcrun', ['simctl', 'spawn', info.simulatorUdid, 'log', 'show', '--last', `${opts.seconds}s`, '--style', 'compact', '--predicate', predicate], 30_000);
      if (r.code !== 0) return { lines: [], reason: `log show failed: ${r.stderr.trim().slice(0, 200)}` };
      lines = r.stdout.split('\n').filter((l) => l.trim() && !/^(Timestamp|Filtering the log data)/.test(l));
      source = `simulator unified log (pid ${info.pid})`;
    }
    return { lines: lines.slice(-opts.limit).map((l) => redactText(l).slice(0, 400)), source };
  }

  async close(): Promise<void> {
    await this.maestro?.close();
  }
}
