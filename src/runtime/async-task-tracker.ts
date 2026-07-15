/** Tracks related asynchronous work and can wait until no tracked tasks remain. */
export class AsyncTaskTracker {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => {
      this.active.delete(tracked);
    });
    this.active.add(tracked);
    return tracked;
  }

  activeCount(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}
