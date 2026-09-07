export class SessionExecutionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get isBusy(): boolean { return this.tails.size > 0; }

  async run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, settled);

    try {
      return await result;
    } finally {
      if (this.tails.get(sessionId) === settled) {
        this.tails.delete(sessionId);
      }
    }
  }

  async whenIdle(sessionId: string): Promise<void> {
    await (this.tails.get(sessionId) ?? Promise.resolve());
  }
}
