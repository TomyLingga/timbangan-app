// Every shape the app exchanges with the API, in one module so it can be aligned with apps/api in one place.
//
// Source of each shape:
//   FROM CODE  read from apps/api/src (file named next to the type), as it was on 21 November 2026.
//   GUESSED    the route does not exist yet; shaped from docs/fase-5-rancangan.md section 4 and the old forms.
// Dates travel as ISO strings.

// --- errors ------------------------------------------------------------------------------------------------

/** FROM CODE apps/api/src/errors.ts: every refusal is `{ error: { code, message, fields? } }`. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields?: { field: string; message: string }[];
    [key: string]: unknown;
  };
}

// --- accounts and permissions ------------------------------------------------------------------------------

export type PermissionLevel = "VIEW" | "CREATE" | "EDIT";

/** FROM CODE apps/api/src/auth/permissions.ts (ModuleCode). */
export type ModuleCode =
  | "contracts"
  | "drivers"
  | "vehicles"
  | "destinations"
  | "delivery_orders"
  | "registrations"
  | "gate"
  | "rfid_cards"
  | "users"
  | "weighbridge"
  | "approvals"
  | "qc"
  | "qc_approvals"
  | "security_check"
  | "unloading"
  | "loading"
  | "sealing"
  | "reports"
  | "plant_masters";

/** FROM CODE apps/api/src/auth/guard.ts (Account); GET /api/me answers `{ user: Account }`. */
export interface Account {
  id: number;
  kind: "INTERNAL" | "PARTNER";
  username: string;
  fullName: string;
  permissions: Partial<Record<string, PermissionLevel>>;
  partner: { id: number; name: string; isSupplier: boolean; isTransporter: boolean; isCustomer: boolean } | null;
}

export interface MeResponse {
  user: Account;
}

/**
 * POST /api/auth/login with `client: "mobile"`.
 * FROM CODE for username and password (apps/api/src/auth/routes.ts); GUESSED: `client` and `refreshToken` in the
 * answer (the route does not read `client` yet and puts the refresh token in a cookie).
 */
export interface LoginRequest {
  username: string;
  password: string;
  client: "android" | "ios";
}
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: Account;
}

/** FROM CODE apps/api/src/auth/routes.ts: POST /api/auth/refresh and /api/auth/logout with the refresh token in the body (docs section 4). */
export interface RefreshRequest {
  refreshToken: string;
}
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

// --- work list ---------------------------------------------------------------------------------------------

/** Flow codes from apps/api/migrations/0002_seed.sql. */
export type FlowCode = "IN_CPO" | "IN_GOODS" | "OUT_BULK" | "OUT_PACKED";

/** The step codes that have a phone form (apps/api/migrations/0002_seed.sql, docs section 3). */
export type FormStepCode = "SEAL_CHECK" | "QC" | "RESEAL" | "UNLOADING" | "CLEANLINESS" | "QC_LOADING" | "LOADING" | "SEALING";

/** FROM CODE apps/api/src/work/view.ts (WorkTruck). */
export interface WorkTruck {
  tripId: number;
  tripNo: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  direction: "IN" | "OUT";
  flowCode: FlowCode | string;
  product: { id: number; name: string } | null;
  partner: { id: number; name: string };
  transporter: { id: number; name: string } | null;
  driverName: string | null;
}

/** FROM CODE apps/api/src/work/view.ts (WorkRow); GET /api/work/steps answers `{ items: WorkRow[] }`. */
export interface WorkRow {
  id: number;
  stepCode: string;
  name: string;
  module: string | null;
  status: "READY" | "IN_PROGRESS" | string;
  result: string | null;
  attempt: number;
  readyAt: string | null;
  startedAt: string | null;
  truck: WorkTruck;
}

export interface WorkListResponse {
  items: WorkRow[];
}

/** FROM CODE apps/api/src/work/view.ts (FormParameter). */
export interface FormParameter {
  code: string;
  name: string;
  unit: string;
  decimals: number;
  minValid: number;
  maxValid: number;
  required: boolean;
  spec: { min: number | null; max: number | null } | null;
}

export interface TankChoice {
  id: number;
  code: string;
  name: string;
}

/** A seal on the truck that this plant put there (FROM CODE view.ts sealsInPlace). */
export interface SealInPlace {
  id: number;
  sealId: number | null;
  sealNo: string;
  kind: string;
  position: string | null;
  appliedAt: string | null;
}

/** FROM CODE apps/api/src/work/view.ts (loadHistory). */
export interface HistoryEntry {
  stepCode: string;
  name: string;
  attempt: number;
  status: string;
  result: string | null;
  finishedAt: string | null;
  note: string | null;
  summary: Record<string, unknown> | null;
}

/** FROM CODE apps/api/src/work/view.ts (loadFormData). `letter` only for incoming trucks. */
export interface FormData {
  letter: { docGrossKg: number | null; docTareKg: number | null; docNetKg: number | null; allocations?: unknown[] } | null;
  declaredSeals: { id: number; sealNo: string; kind: string }[];
  tanks: TankChoice[];
  parameters: FormParameter[];
  sealsInPlace: SealInPlace[];
  history: HistoryEntry[];
}

/** FROM CODE GET /api/work/steps/:id (apps/api/src/work/routes.ts). */
export interface StepDetailResponse {
  step: WorkRow;
  form: FormData;
}

/** FROM CODE GET /api/work/find?barcode= | plate= | cardUid=. */
export interface FindResponse {
  truck: WorkTruck;
  steps: Omit<WorkRow, "truck">[];
}

/** FROM CODE GET /api/work/seals/available (needs sealing CREATE). */
export interface AvailableSeal {
  id: number;
  sealNo: string;
  kind: "LOCIS" | "CUSTOMS" | string;
}
export interface AvailableSealsResponse {
  items: AvailableSeal[];
}

/** FROM CODE POST /api/files: multipart, field `file`, one JPEG/PNG/WebP up to 5 MB, answers 201 `{ id }`. */
export interface FileUploadResponse {
  id: number;
}

// --- form bodies -------------------------------------------------------------------------------------------

/** FROM CODE apps/api/src/work/incoming.ts (sealCheckBody), route `seal-check`. */
export interface SealCheckBody {
  clientUuid: string;
  seals: { sealNo: string; intact: boolean; note?: string }[];
  result: "PASS" | "FAIL";
  remark?: string;
  photoFileIds?: number[];
}

export type ReceivingReason = "FFA_OUT" | "MI_OUT" | "FFA_MI_OUT";

/** FROM CODE apps/api/src/work/incoming.ts (qcReceivingBody), route `qc-receiving`. */
export interface QcReceivingBody {
  clientUuid: string;
  values: { FFA: number; MOISTURE: number; IMPURITIES?: number };
  disposition: "OK" | "HOLD" | "NOT_OK";
  reasonCode?: ReceivingReason;
  remark?: string;
}

/** FROM CODE apps/api/src/work/incoming.ts (resealBody), route `reseal`. */
export interface ResealBody {
  clientUuid: string;
  seals: { sealId: number }[];
  remark?: string;
}

/** FROM CODE apps/api/src/work/incoming.ts (unloadingBody), route `unloading`. Booleans: true = found / on / open / active. */
export interface UnloadingBody {
  clientUuid: string;
  tankId: number;
  doorNo: number;
  wood: boolean;
  wire: boolean;
  plastic: boolean;
  handbrakeOn: boolean;
  engineOn: boolean;
  manholeOpen: boolean;
  dischargeValveActive: boolean;
  tankEmpty: true;
  remark?: string;
  photoFileIds?: number[];
}

/** FROM CODE apps/api/src/work/outgoing.ts: keys of the six container items of the cleanliness check (labels from the old form). */
export type CleanlinessItemKey = "containerClean" | "noLiquid" | "noForeignObject" | "noPestOrNajis" | "wallsCleanDryNoLeak" | "noOdor";
/** FROM CODE: keys of the nozzle items (outgoing bulk only). */
export type NozzleItemKey = "flashLight" | "nozzleVisual" | "nozzleOdor";

/** FROM CODE: route `cleanliness`. Every item true = OK. `nozzle` is null for packed goods. */
export interface CleanlinessBody {
  clientUuid: string;
  /** true = OK. The nozzle items are required for outgoing bulk and left out for packed goods. */
  items: Record<CleanlinessItemKey, boolean> & Partial<Record<NozzleItemKey, boolean>>;
  nozzleNo?: number;
  disposition: "OK" | "NOT_OK";
  conclusion?: string;
}

/** GUESSED: route `qc-loading`. Values keyed by quality parameter code (FFA, MNI, IV, ...). */
export interface QcLoadingBody {
  clientUuid: string;
  values: Record<string, number>;
  tankId: number;
  blendTankId?: number;
  remark?: string;
}

/** GUESSED: route `loading/start`. `startedAt` is the phone's time, because a queued start can arrive late. */
export interface LoadingStartBody {
  clientUuid: string;
  startedAt: string;
}

/** FROM CODE: route `loading/finish`. */
export interface LoadingFinishBody {
  clientUuid: string;
  finishedAt: string;
  temperatureC: number;
  qualityOk: boolean;
  handbrakeOn: boolean;
  engineOff: boolean;
  remark?: string;
}

/** GUESSED: route `sealing`. `removed` marks seals of an earlier loading as opened (after "tambah"/"kurangi muatan"). */
export interface SealingBody {
  clientUuid: string;
  seals: { sealId: number }[];
  removed: { tripSealId: number; reason: string }[];
  remark?: string;
  photoFileIds?: number[];
}

/** FROM CODE apps/api/src/work/engine.ts (runForm): the answer of every form, also for a resend of the same uuid. */
export interface FormAnswer {
  step: { id: number; stepCode: string; name: string; status: string; result: string | null } | null;
  trip: unknown;
  next: { id: number; stepCode: string; name: string } | null;
  [key: string]: unknown;
}

// --- decisions ---------------------------------------------------------------------------------------------

/** FROM CODE apps/api/src/db/schema.ts via exceptions/service.ts. */
export type ExceptionType = "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT" | "QC_HOLD";
export type ExceptionStatus = "PENDING" | "APPROVED" | "REJECTED" | "RETRY" | "CANCELLED" | "EXPIRED";

/** FROM CODE apps/api/src/exceptions/service.ts (loadExceptionViews). */
export interface ExceptionView {
  id: number;
  type: ExceptionType | string;
  status: ExceptionStatus | string;
  decision: string | null;
  trip: { id: number; tripNo: string | null; plateNo: string | null; plateDisplay: string | null };
  station: { id: number; code: string | null; name: string | null } | null;
  stage: number | null;
  expectedValue: number | null;
  actualValue: number | null;
  diffValue: number | null;
  diffPct: number | null;
  tolerancePct: number | null;
  liveWeightKg: number | null;
  liveWeightAt: string | null;
  plateRead: string | null;
  plateNo: string | null;
  approverModule: string;
  raisedAt: string;
  decidedAt: string | null;
  decidedBy: { id: number; fullName: string | null } | null;
  reason: string | null;
  reportNo: string | null;
  weighingId: number | null;
  /** For QC_HOLD (apps/api/src/work/incoming.ts): plateNo, disposition, reasonCode, values, remark. */
  context: Record<string, unknown>;
}

export interface ExceptionListResponse {
  items: ExceptionView[];
}
export interface ExceptionResponse {
  exception: ExceptionView;
}

export type DecisionCode = "APPROVE" | "REJECT" | "OK" | "ADD_LOAD" | "REDUCE_LOAD";

/** FROM CODE apps/api/src/exceptions/decide.ts (decideBody). */
export interface DecideBody {
  decision: DecisionCode;
  reason?: string;
  updateMasterTare?: boolean;
}
