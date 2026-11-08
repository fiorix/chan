// Shared with chan-server::metrics; counters describe the server process.
export interface MetricTraffic {
  active: number; opened: number; receivedBytes: number; sentBytes: number;
  receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null;
}
export interface MetricSample {
  sequence: number; elapsedMs: number; sampledAtMs: number; collectionMicros: number;
  process: {
    uptimeSeconds: number; cpuTimeMs: number; cpuPercent: number | null;
    residentBytes: number; ioScope: "storage_io" | "process_io" | "unavailable";
    readBytes: number | null; writtenBytes: number | null;
    readBytesPerSecond: number | null; writtenBytesPerSecond: number | null;
  } | null;
  network: MetricTraffic; http2: MetricTraffic; yamux: MetricTraffic;
  reverseConnections: MetricTraffic; transferPayload: MetricTraffic;
  transfers: {
    queued: number; running: number; workerCapacity: number; queueCapacity: number;
    finished: number; cancelled: number; stalled: number; panicked: number; refused: number;
  };
  gatewayTunnels: number; tunnelDialFailures: number; reverseListeners: number;
  yamuxWaiting: number; yamuxServing: number; yamuxServiceCapacity: number; yamuxStreamLimit: number;
}
export interface MetricsView {
  schemaVersion: number;
  identity: { instanceId: string; version: string; build: string; pid: number; hostname: string | null };
  latest: MetricSample | null; history: MetricSample[];
  storage: {
    path: string; logicalBytes: number | null; allocatedBytes: number | null;
    files: number | null; sampledAtMs: number | null; scanMillis: number | null; error: string | null;
  };
}
