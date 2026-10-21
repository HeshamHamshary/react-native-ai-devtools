import type { Role } from 'react-native-agent-devtools-protocol';

interface RefEntry {
  ref: string;
  fingerprint: string;
  lastSeen: number;
  testID?: string;
  role?: Role;
  label?: string;
}

/**
 * Assigns short refs (`e1`, `e2`, …) to element fingerprints and keeps them stable
 * across snapshots for as long as the element persists. A fingerprint is a hash of
 * the element's structural path (component types + keys/indices), so re-renders keep
 * the same ref while a different element at the same position after navigation does not.
 */
export class RefRegistry {
  private byFingerprint = new Map<string, RefEntry>();
  private byRef = new Map<string, RefEntry>();
  private nextId = 1;
  private generation = 0;

  beginSnapshot(): number {
    this.generation++;
    if (this.byFingerprint.size > 3000) this.evict(50);
    return this.generation;
  }

  assign(fingerprint: string, meta: { testID?: string; role?: Role; label?: string }): string {
    let e = this.byFingerprint.get(fingerprint);
    if (!e) {
      e = { ref: `e${this.nextId++}`, fingerprint, lastSeen: this.generation };
      this.byFingerprint.set(fingerprint, e);
      this.byRef.set(e.ref, e);
    }
    e.lastSeen = this.generation;
    e.testID = meta.testID;
    e.role = meta.role;
    e.label = meta.label;
    return e.ref;
  }

  lookup(ref: string): RefEntry | undefined {
    return this.byRef.get(ref);
  }

  /** True if `ref` was seen in the most recent snapshot. */
  isCurrent(ref: string): boolean {
    return this.byRef.get(ref)?.lastSeen === this.generation;
  }

  private evict(maxAge: number): void {
    for (const [fp, e] of this.byFingerprint) {
      if (this.generation - e.lastSeen > maxAge) {
        this.byFingerprint.delete(fp);
        this.byRef.delete(e.ref);
      }
    }
  }
}
