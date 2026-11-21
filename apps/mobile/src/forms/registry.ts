// Which form a waiting step takes.

import type { WorkRow } from "../api/types";
import { qcReceivingForm, resealForm, sealCheckForm, unloadingForm } from "./incoming";
import { cleanlinessForm, loadingFinishForm, loadingStartForm, qcLoadingForm, sealingForm } from "./outgoing";
import type { FormDefinition } from "./shared";

/**
 * The form of a step, or null when the phone has no form for it (QC of incoming goods, a QC step that waits for
 * a supervisor, and the steps done elsewhere: weighing, check-in, check-out).
 */
export function formFor(step: Pick<WorkRow, "stepCode" | "status" | "result" | "truck">): FormDefinition | null {
  switch (step.stepCode) {
    case "SEAL_CHECK":
      return sealCheckForm;
    case "QC":
      if (step.truck.flowCode !== "IN_CPO" || step.result === "HOLD") return null;
      return qcReceivingForm;
    case "RESEAL":
      return resealForm;
    case "UNLOADING":
      return step.truck.flowCode === "IN_CPO" ? unloadingForm : null;
    case "CLEANLINESS":
      return cleanlinessForm;
    case "QC_LOADING":
      return qcLoadingForm;
    case "LOADING":
      return step.status === "IN_PROGRESS" ? loadingFinishForm : loadingStartForm;
    case "SEALING":
      return sealingForm;
    default:
      return null;
  }
}

/** Why a step has no phone form, in words for the operator. */
export function noFormReason(step: Pick<WorkRow, "stepCode" | "result">): string {
  if (step.stepCode === "QC" && step.result === "HOLD") return "Langkah ini menunggu keputusan QC.";
  return "Langkah ini belum punya form di aplikasi ini.";
}
