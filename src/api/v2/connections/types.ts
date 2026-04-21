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

export function mapComposioToResponse(
  conn: ConnectedAccountRetrieveResponse | ConnectedAccountListResponseItem,
  deviceId: string,
): ConnectionResponse {
  const slug = conn.toolkit.slug;
  return {
    connectionId: conn.id,
    serviceId: slug,
    serviceName: slug,
    composioEntityId: deviceId,
    composioConnectionId: conn.id,
    status: conn.status,
  };
}
