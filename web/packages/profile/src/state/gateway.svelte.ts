import { api } from "../lib/api";

class GatewayStore {
  tunnelUrl = $state<string | null>(null);
  error = $state<string | null>(null);
  private request: Promise<void> | null = null;

  load(): Promise<void> {
    return this.request ??= this.read();
  }

  private async read(): Promise<void> {
    try {
      const discovery = await api.discovery();
      if (typeof discovery?.tunnel_url !== "string" || !discovery.tunnel_url.trim()) {
        throw new Error("The gateway did not report its tunnel URL.");
      }
      this.tunnelUrl = discovery.tunnel_url.trim();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}

export const gatewayStore = new GatewayStore();
