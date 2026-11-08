/** Build the service command with the token supplied through its environment. */
export function tunnelCommand(tunnelUrl?: string | null): string {
  const endpoint = tunnelUrl
    ? shellArgument(tunnelUrl)
    : "<this gateway's tunnel URL>";
  return `export CHAN_TUNNEL_TOKEN=<token>\nchan devserver start --tunnel-url ${endpoint}`;
}

function shellArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:%@-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
