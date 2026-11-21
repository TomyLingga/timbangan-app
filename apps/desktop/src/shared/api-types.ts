// The shapes of the weighbridge routes (apps/api/src/weighing/routes.ts and exceptions/decide.ts), as far as the
// program reads them. Every answer and every error carries `message` (screen) and `speech` (segments to speak).

export interface Spoken {
  message: string;
  speech: string[];
}

export type Direction = "IN" | "OUT";
export type WeighKind = "GROSS" | "TARE";
export type ExceptionType = "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT";

export interface TripView {
  id: number;
  tripNo: string | null;
  status: string;
  direction: Direction;
  currentStep: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  driverName: string | null;
  partner: { id: number; name: string };
  transporter: { id: number; name: string } | null;
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
}

/** GET /api/weighbridge/card/:uid */
export interface CardAnswer extends Spoken {
  trip: TripView;
  stage: 1 | 2;
  kind: WeighKind;
  /** The plate-reader camera for this stage, from the station config; null when not set. */
  camera: number | null;
  expected: {
    plateNo: string;
    plateDisplay: string;
    docGrossKg: number | null;
    docNetKg: number | null;
    vehicleTareKg: number | null;
  };
}

export interface WeighingView {
  id: number;
  stage: 1 | 2;
  kind: WeighKind;
  weightKg: number;
  weighedAt: string;
  mode: "AUTO" | "EXCEPTION";
  plateRead: string | null;
  plateCheck: string;
  status: string;
}

/** POST /api/weighbridge/weigh: 200 SAVED or PLATE_RETRY, 202 PENDING. */
export type WeighAnswer =
  | (Spoken & { result: "SAVED"; weighing: WeighingView; trip: TripView })
  | (Spoken & { result: "PENDING"; exception: { id: number; type: ExceptionType } })
  | (Spoken & { result: "PLATE_RETRY"; attemptsLeft: number });

export type ExceptionStatus = "PENDING" | "APPROVED" | "REJECTED" | "RETRY" | "CANCELLED" | "EXPIRED";

/** POST /api/weighbridge/exceptions/:id/heartbeat */
export interface HeartbeatAnswer extends Spoken {
  status: ExceptionStatus;
  decision?: "APPROVE" | "REJECT" | "OK" | "ADD_LOAD" | "REDUCE_LOAD";
  result?: "SAVED" | "PENDING" | "NOT_SAVED";
  weighing?: WeighingView;
  trip?: TripView;
  exception?: { id: number; type: ExceptionType };
}

/** POST /api/weighbridge/exceptions/:id/cancel */
export interface CancelAnswer extends Spoken {
  status: "CANCELLED";
}

/** POST /api/weighbridge/manual-plate */
export interface ManualPlateAnswer extends Spoken {
  unlocked: true;
}

/** A call that did not give a 2xx answer: an API error envelope, or no answer at all. */
export type ApiFailure =
  | { kind: "api"; status: number; code: string; message: string; speech: string[]; details: Record<string, unknown> }
  | { kind: "network"; message: string };
