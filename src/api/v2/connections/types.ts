import type {
  ConnectedAccountListResponseItem,
  ConnectedAccountRetrieveResponse,
} from "@composio/core";

export type ConnectionResponse = {
  connectionId: string;
  serviceId: string;
  serviceName: string;
  composioEntityId: string;
  composioConnectionId: string;
  status: string;
};

// Collapse REVOKED into EXPIRED on the wire. Both states require the user to
// re-run the OAuth flow, and iOS already has reconnect UX for EXPIRED; keeping
// the status set narrow avoids forcing every client version to learn REVOKED.
function normalizeStatus(status: string): string {
  return status === "REVOKED" ? "EXPIRED" : status;
}

export function mapComposioToResponse(
  conn: ConnectedAccountRetrieveResponse | ConnectedAccountListResponseItem,
  accountId: string,
): ConnectionResponse {
  const slug = conn.toolkit.slug;
  return {
    connectionId: conn.id,
    serviceId: slug,
    serviceName: slug,
    composioEntityId: accountId,
    composioConnectionId: conn.id,
    status: normalizeStatus(conn.status),
  };
}
