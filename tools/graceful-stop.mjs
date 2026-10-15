// Convert process signals into a cooperative stop request. Callers must stop claiming new work,
// allow already-dispatched paid units to finish, and only then exit. This keeps a normal operator
// pause from creating orphaned `started` receipts.
export function installGracefulStop({ emitter = process } = {}) {
  const controller = new AbortController();
  const request = signalName => {
    if (!controller.signal.aborted) controller.abort(signalName);
  };
  const onInterrupt = () => request('SIGINT');
  const onTerminate = () => request('SIGTERM');
  emitter.on('SIGINT', onInterrupt);
  emitter.on('SIGTERM', onTerminate);
  return Object.freeze({
    signal: controller.signal,
    request,
    dispose() {
      emitter.off('SIGINT', onInterrupt);
      emitter.off('SIGTERM', onTerminate);
    },
  });
}
