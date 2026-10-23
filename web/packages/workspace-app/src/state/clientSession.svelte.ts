import { clientHolder, onClientDetached } from "../api/clientSession";
import { api } from "../api/client";
import { request } from "../api/transport";
import { notify } from "./notify.svelte";

export const clientSession = $state({ id: "", detached: false, requestId: null as string | null, busy: false });
let pendingIdentifications: string[] = [];
const answersInFlight = new Set<string>();

function showPendingIdentification(): void {
  const requestId = pendingIdentifications[0] ?? null;
  clientSession.requestId = requestId;
  clientSession.busy = requestId !== null && answersInFlight.has(requestId);
}

onClientDetached(() => {
  clientSession.detached = true;
  pendingIdentifications = [];
  answersInFlight.clear();
  showPendingIdentification();
});

export function identifyClient(requestId: string): void {
  if (!pendingIdentifications.includes(requestId)) pendingIdentifications.push(requestId);
  showPendingIdentification();
}

export function endClientIdentification(requestId: string): void {
  const index = pendingIdentifications.indexOf(requestId);
  if (index !== -1) pendingIdentifications.splice(index, 1);
  answersInFlight.delete(requestId);
  showPendingIdentification();
}

export function syncClientIdentifications(requestIds: readonly string[]): void {
  const present = new Set(requestIds);
  pendingIdentifications = pendingIdentifications.filter((id) => present.has(id));
  const retained = new Set(pendingIdentifications);
  for (const id of requestIds) {
    if (retained.has(id)) continue;
    pendingIdentifications.push(id);
    retained.add(id);
  }
  for (const id of answersInFlight) {
    if (!present.has(id)) answersInFlight.delete(id);
  }
  showPendingIdentification();
}

export async function answerClientIdentification(accept: boolean): Promise<void> {
  const requestId = clientSession.requestId;
  if (!requestId || answersInFlight.has(requestId)) return;
  answersInFlight.add(requestId);
  showPendingIdentification();
  try {
    await api.windowReply({ requestId, payload: { client_id: accept ? clientSession.id : null } });
  } catch (error) {
    notify(`session identification: ${(error as Error).message}`);
    endClientIdentification(requestId);
  }
}

export async function reconnectClient(): Promise<void> {
  clientSession.busy = true;
  try {
    await request("POST", "/api/session/resume", { holder: clientHolder() });
    window.location.reload();
  } catch (error) {
    notify(`session reconnect: ${(error as Error).message}`);
    clientSession.busy = false;
  }
}
