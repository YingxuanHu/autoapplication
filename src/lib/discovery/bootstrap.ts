import { syncWorker } from "./worker";

export function ensureDiscoveryWorkerStarted(): void {
  if (!syncWorker.getStats().isRunning) {
    syncWorker.start();
  }
}
