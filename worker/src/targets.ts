import type { AppTarget } from "@my/store-shared";
import { Db, type AppRow } from "./db.js";
import type { Env } from "./env.js";
import { HttpError } from "./http.js";

export class TargetDisabledError extends HttpError {
  constructor() { super(409, "Target is disabled."); }
}

export async function requireTarget(env: Env, app: Pick<AppRow, "id" | "platform">, target: AppTarget = app.platform ?? "ios"): Promise<void> {
  if (!(await Db.from(env).appTargets(app.id))[target]) throw new TargetDisabledError();
}
