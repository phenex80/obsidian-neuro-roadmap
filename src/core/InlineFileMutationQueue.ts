/** Serializes Neuro Roadmap inline Markdown mutations per vault path. */
export class InlineFileMutationQueue {
  private readonly queuesByPath = new Map<string, Promise<void>>();
  private disposed = false;

  run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Inline Markdown mutation service is unavailable after unload.'));
    }

    const previous = this.queuesByPath.get(path) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queuesByPath.set(path, tail);
    void tail.then(() => {
      if (this.queuesByPath.get(path) === tail) {
        this.queuesByPath.delete(path);
      }
    });
    return result;
  }

  dispose(): void {
    this.disposed = true;
  }
}
