import { healthResponse } from "$lib/server/health";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => healthResponse("GET");
export const HEAD: RequestHandler = () => healthResponse("HEAD");
