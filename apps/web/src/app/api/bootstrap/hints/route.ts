// Same-origin proxy counterpart to ../route.ts, for the hints endpoint —
// see that file's comment.
const BOOTSTRAP_SERVICE_URL = "https://awari-bootstrap-service.vercel.app";

export async function POST(req: Request) {
  const body = await req.text();
  const upstream = await fetch(`${BOOTSTRAP_SERVICE_URL}/api/bootstrap/hints`, {
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
