/** Serialize executable tools within one harness run; client tools remain client-owned. */
export function sequenceTools<T extends Record<string, any>>(tools: T): T {
  let tail: Promise<unknown> = Promise.resolve();
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (typeof tool?.execute !== "function") return [name, tool];
    return [name, {
      ...tool,
      execute: (input: unknown, options: { abortSignal?: AbortSignal }) => {
        const result = tail.then(() => {
          // A queued side effect must not start after the turn was interrupted.
          options?.abortSignal?.throwIfAborted();
          return tool.execute(input, options);
        });
        // Keep the original rejection for the SDK, but let later calls proceed.
        tail = result.catch(() => undefined);
        return result;
      },
    }];
  })) as T;
}
