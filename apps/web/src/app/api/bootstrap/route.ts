// Same-origin proxy to the real, shared awari-bootstrap-service — see
// specs/decisions/0009-real-bootstrap-service.md. The service itself sends
// no Access-Control-Allow-Origin header, so a browser calling it directly
// cross-origin is blocked outright; this route makes the request
// server-to-server (no CORS involved at all) and just forwards the result.
const BOOTSTRAP_SERVICE_URL = "https://awari-bootstrap-service.vercel.app";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetch(`${BOOTSTRAP_SERVICE_URL}/api/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
