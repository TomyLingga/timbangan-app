// One route per phone form: POST /api/work/steps/:id/<form>. The module of the step decides who may send it
// (create level); see engine.ts for what every form shares.
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { Guards } from "../auth/guard.js";
import { idParams } from "../http.js";
import { type FormSpec, runForm } from "./engine.js";
import { qcReceivingForm, resealForm, sealCheckForm, unloadingForm } from "./incoming.js";
import { cleanlinessForm, loadingFinishForm, loadingStartForm, qcLoadingForm, sealingForm } from "./outgoing.js";

// each form has its own body type, so the list holds them loosely
const FORMS: [string, FormSpec<any>][] = [
  ["seal-check", sealCheckForm],
  ["qc-receiving", qcReceivingForm],
  ["reseal", resealForm],
  ["unloading", unloadingForm],
  ["cleanliness", cleanlinessForm],
  ["qc-loading", qcLoadingForm],
  ["loading/start", loadingStartForm],
  ["loading/finish", loadingFinishForm],
  ["sealing", sealingForm],
];

export function registerFormRoutes(app: FastifyInstance, context: AppContext, guards: Guards, forms: [string, FormSpec<any>][] = FORMS): void {
  const orm = context.database.db;
  const staff = { preHandler: [guards.authenticate, guards.requireInternal] };
  for (const [path, spec] of forms) {
    app.post(`/api/work/steps/:id/${path}`, staff, async (request) => {
      const { id } = idParams.parse(request.params);
      return runForm(orm, request, id, context.now(), spec);
    });
  }
}
