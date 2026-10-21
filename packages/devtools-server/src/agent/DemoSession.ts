import type { DeviceSession } from '../transport/devices.ts';

/**
 * Scripted stand-in for UI development without model credentials (--demo-agent).
 * It never pretends to be a model: every reply says so. It does run real device
 * tools, so the chat UI shows genuine tool rows, timings and app data.
 */
export class DemoSession {
  private turn?: string;
  private readonly device: DeviceSession;

  constructor(device: DeviceSession) {
    this.device = device;
  }

  get busy(): boolean {
    return !!this.turn;
  }

  get modelName(): string {
    return 'demo (scripted, no model)';
  }

  async send(text: string, turnId: string): Promise<void> {
    this.turn = turnId;
    const t0 = performance.now();
    const d = this.device;
    d.send({ type: 'chat.status', state: 'thinking', turnId });
    let deviceMs = 0;
    let toolMs = 0;
    const run = async (toolId: string, name: string, summary: string, fn: () => Promise<string>) => {
      d.send({ type: 'chat.tool', turnId, toolId, name, phase: 'start', summary });
      const s = performance.now();
      try {
        const out = await fn();
        const ms = Math.round(performance.now() - s);
        toolMs += ms;
        d.send({ type: 'chat.tool', turnId, toolId, name, phase: 'end', ok: true, durationMs: ms });
        return out;
      } catch (e) {
        d.send({ type: 'chat.tool', turnId, toolId, name, phase: 'end', ok: false, durationMs: Math.round(performance.now() - s) });
        return `error: ${(e as Error).message}`;
      }
    };
    const screen = await run(`${turnId}-1`, 'mobile_get_ui', 'Read UI', async () => {
      const r = await d.rpc<{ text: string }>('getUI', {});
      deviceMs += r.deviceMs;
      return r.result.text;
    });
    const errors = /error|crash|fail/i.test(text)
      ? await run(`${turnId}-2`, 'mobile_get_logs', 'Read JS errors', async () => {
          const r = await d.rpc<{ entries: { message: string }[] }>('getLogs', { errorsOnly: true, limit: 3 });
          deviceMs += r.deviceMs;
          return r.result.entries.map((e) => `- ${e.message.split('\n')[0]}`).join('\n') || '- none captured';
        })
      : undefined;
    const reply = [
      `**Demo agent (no model).** You asked: “${text.slice(0, 80)}”.`,
      '',
      `Here is what the device reported:`,
      '```',
      screen.split('\n').slice(0, 8).join('\n'),
      '```',
      ...(errors ? ['Recent JS errors:', errors] : []),
      '',
      'Start the server with `ANTHROPIC_API_KEY` for real answers.',
    ].join('\n');
    for (const chunk of reply.match(/[\s\S]{1,24}/g) ?? []) {
      if (this.turn !== turnId) return;
      d.send({ type: 'chat.delta', turnId, text: chunk });
      await new Promise((r) => setTimeout(r, 18));
    }
    const totalMs = Math.round(performance.now() - t0);
    d.send({ type: 'chat.done', turnId, ok: true, stats: { totalMs, toolMs, deviceMs, modelMs: totalMs - toolMs, toolCalls: errors ? 2 : 1, model: this.modelName } });
    d.send({ type: 'chat.status', state: 'idle' });
    this.turn = undefined;
  }

  async interrupt(): Promise<void> {
    const t = this.turn;
    this.turn = undefined;
    if (t) {
      this.device.send({ type: 'chat.done', turnId: t, ok: false, error: 'Stopped.' });
      this.device.send({ type: 'chat.status', state: 'idle' });
    }
  }

  close(): void {
    this.turn = undefined;
  }
}
