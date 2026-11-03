/** Compatibility URL for the provider UI; reuse normal identity and worker protections. */
import { handleApi } from "../../../lib/server";
async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api\/email-v2\//, "/api/email/");
  return handleApi(new Request(url, request));
}
export const GET = route;
export const POST = route;
export const DELETE = route;
