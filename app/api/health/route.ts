export async function GET() {
  return Response.json({
    status: "ok",
    service: "fundraising-os",
    timestamp: new Date().toISOString(),
  });
}
