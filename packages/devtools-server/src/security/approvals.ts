import { randomUUID } from 'node:crypto';
import type { DeviceSession } from '../transport/devices.ts';

/**
 * Approval prompts shown on the device (code edits, Claude Code permission requests).
 * Only paired devices are asked: loopback alone does not prove the app is the
 * developer's, because other OS users, or other apps in a simulator, can reach the port.
 */
export class Approvals {
  private pending = new Map<string, (ok: boolean) => void>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  /** Resolves undefined when the device may not answer or nobody answers in time. */
  ask(device: DeviceSession, title: string, detail: string): Promise<boolean | undefined> {
    if (!device.trusted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, this.timeoutMs);
      this.pending.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      device.send({ type: 'approval.request', id, title, detail, risk: 'high' });
    });
  }

  /** Like ask, but anything other than an explicit yes is a no; unpaired devices are told why. */
  async approve(device: DeviceSession, title: string, detail: string): Promise<boolean> {
    if (!device.trusted) {
      device.send({
        type: 'chat.notice',
        level: 'warning',
        text: `Declined automatically: ${detail} Approving from the app needs pairing: open the menu, choose "Pair this app", and enter the code shown in the server terminal.`,
      });
      return false;
    }
    return (await this.ask(device, title, detail)) === true;
  }

  answer(id: string, approved: boolean): void {
    this.pending.get(id)?.(approved);
    this.pending.delete(id);
  }
}
