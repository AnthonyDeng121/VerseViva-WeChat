import type { TaskRef } from './api.ts';

export type TaskStorage = {
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  remove(key: string): void;
};

// Only IDs, no token/audio/feedback. Namespace by verified owner AND deployment.
export class PendingTasks {
  constructor(private storage: TaskStorage, private origin: string) {}
  private key(owner: string) { return `verseviva:tasks:v1:${encodeURIComponent(this.origin)}:${encodeURIComponent(owner)}`; }
  read(owner: string): TaskRef[] {
    let value: unknown;
    try { value = this.storage.read(this.key(owner)); } catch { return []; }
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is TaskRef => item && typeof item === 'object'
      && (item.kind === 'song' || item.kind === 'practice')
      && typeof item.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.id)).slice(0, 20);
  }
  add(owner: string, ref: TaskRef) {
    const value = this.read(owner).filter((item) => item.kind !== ref.kind || item.id !== ref.id);
    this.storage.write(this.key(owner), [...value, ref].slice(-20));
  }
  remove(owner: string, ref: TaskRef) {
    const value = this.read(owner).filter((item) => item.kind !== ref.kind || item.id !== ref.id);
    if (value.length) this.storage.write(this.key(owner), value);
    else this.storage.remove(this.key(owner));
  }
}
