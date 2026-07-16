import { PROTOCOL_VERSION, type BootstrapClient } from "@awari/core";
import type {
  BootstrapRequest,
  BootstrapResponse,
  ContactHint,
  RegisterHintRequest,
  RegisterHintResponse,
  RoomId,
} from "@awari/protocol";

/**
 * The real, shared awari bootstrap service — genesis/leader-hint discovery
 * for the game's shared room, so unrelated tabs/browsers actually find each
 * other instead of each silently becoming its own room's genesis leader
 * (see `manualBootstrap.ts`, kikorin's former stand-in, still used for the
 * unrelated "paste a peer id" manual-connect override — see this repo's
 * specs/decisions/0009-real-bootstrap-service.md, not awari's own,
 * differently-numbered ADR 0009 that `manualBootstrap.ts` itself refers to).
 *
 * Calls this app's own `/api/bootstrap(/hints)` routes, not the service's
 * URL directly — the live service sends no `Access-Control-Allow-Origin`,
 * so a browser calling it cross-origin is blocked outright. Those routes
 * (`apps/web/src/app/api/bootstrap/`) are a thin same-origin proxy that
 * forwards server-to-server, where CORS doesn't apply at all.
 */
const DEFAULT_BASE_URL = "";

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`bootstrap-service ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function createHttpBootstrapClient(baseUrl: string = DEFAULT_BASE_URL): BootstrapClient {
  return {
    resolve(request: BootstrapRequest): Promise<BootstrapResponse> {
      return postJson<BootstrapResponse>(baseUrl, "/api/bootstrap", request);
    },
    async registerHint(roomId: RoomId, hint: ContactHint): Promise<void> {
      const body: RegisterHintRequest = { roomId, protocolVersion: PROTOCOL_VERSION, hint };
      const response = await postJson<RegisterHintResponse>(baseUrl, "/api/bootstrap/hints", body);
      if (response.status !== "registered") {
        throw new Error(`bootstrap-service rejected hint registration: ${response.status}`);
      }
    },
  };
}
