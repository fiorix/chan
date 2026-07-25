// identity-service public API client. Bearer wrapper, error type,
// and credentialed fetch live in @chan/web-shared.

import { request } from "@chan/web-shared/api";

export { HttpError } from "@chan/web-shared/api";

export type User = {
  id: string;
  email: string;
  display_name: string | null;
  username: string;
  username_edits: number;
  created_at: string;
  updated_at: string;
  avatar_url: string | null;
};

export type Devserver = {
  /// One live devserver id (lowercase hex SHA-256 of the PAT; the
  /// registry's 2nd key). A user can hold several. The dashboard
  /// pairs this with the owned list (which carries the label) to flip
  /// online/offline, and derives the `?d=` disc (first 12 hex chars)
  /// for open/copy links.
  devserver_id: string;
  /// "online" while the tunnel registration is live. The proxy admin
  /// only reports live devservers, so this is the only value.
  status: "online";
};

export type Me = {
  user: User;
  /// Live devserver snapshot for the signed-in user, sourced from the
  /// proxy admin tunnel list (one row per live devserver). Empty when
  /// nothing is connected.
  devservers: Devserver[];
  /// Resolved feature flags for this user. Map of flag key -> bool.
  /// A flag absent from the map = does not exist in the registry
  /// (treat as off). Fresh deploys ship `share_workspaces` off.
  flags: Record<string, boolean>;
};

export type UsernameResponse = {
  username: string;
  edits_remaining: number;
};

export type Token = {
  id: string;
  label: string;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

export type CreatedToken = Token & { secret: string };

export type AuditEntry = {
  id: number;
  ts: string;
  action: string;
  ip: string | null;
  user_agent: string | null;
};

export type ProvidersResponse = { providers: string[] };

export type DevserverGrant = {
  id: string;
  owner_user_id: string;
  devserver_id: string;
  grantee_email: string;
  /// null until the recipient signs in with a verified OAuth email
  /// matching grantee_email. Until then the grant is "pending" and
  /// the recipient cannot open the devserver.
  grantee_user_id: string | null;
  created_at: string;
  accepted_at: string | null;
};

export type OwnedDevserverSummary = {
  devserver_id: string;
  /// Human-friendly name, mirrored from the PAT label.
  label: string;
  grant_count: number;
};

export type IncomingShare = {
  grant_id: string;
  owner_user_id: string;
  owner_username: string;
  owner_display_name: string | null;
  owner_avatar_url: string | null;
  devserver_id: string;
  label: string;
  accepted_at: string;
};

export const api = {
  providers: () => request<ProvidersResponse>("/api/providers"),
  me: () => request<Me>("/api/me"),
  logout: () => request<void>("/api/logout", { method: "POST" }),
  deleteAccount: () => request<void>("/api/profile", { method: "DELETE" }),

  updateUsername: (username: string) =>
    request<UsernameResponse>("/api/me/username", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    }),

  listTokens: () => request<Token[]>("/api/tokens"),
  createToken: (label: string, expires_in: number | null) =>
    request<CreatedToken>("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, expires_in }),
    }),
  revokeToken: (id: string) =>
    request<void>(`/api/tokens/${id}`, { method: "DELETE" }),
  tokenAudit: (id: string) =>
    request<AuditEntry[]>(`/api/tokens/${id}/audit`),

  // NOTE: whole-devserver "open" (root) + the /s/{owner} share-link are
  // intentionally absent. This surface covers sharing management only; the
  // per-tenant share link /s/{owner}/{workspace} exists server-side for a
  // known workspace.

  listDevserverGrants: (devserverId: string) =>
    request<DevserverGrant[]>(`/api/devservers/${encodeURIComponent(devserverId)}/grants`),
  addDevserverGrant: (devserverId: string, grantee_email: string) =>
    request<DevserverGrant>(`/api/devservers/${encodeURIComponent(devserverId)}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantee_email }),
    }),
  deleteDevserverGrant: (id: string) =>
    request<void>(`/api/grants/${id}`, { method: "DELETE" }),

  listOwnedDevservers: () => request<OwnedDevserverSummary[]>("/api/devservers/owned"),
  listIncomingShares: () => request<IncomingShare[]>("/api/devservers/incoming"),
};
