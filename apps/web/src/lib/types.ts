// Shapes taken from the API contract. Fields the contract leaves open
// (state values, numeric fields that may arrive as strings) are typed loosely.

export type UserKind = "INTERNAL" | "PARTNER";

export interface PartnerRef {
  id: string | number;
  name: string;
}

export interface User {
  id: string | number;
  kind: UserKind;
  username: string;
  fullName: string;
  roles: string[];
  partner: PartnerRef | null;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

export type Direction = "IN" | "OUT";

export interface Contract {
  id: string | number;
  contractNo: string;
  direction: Direction;
  partner: PartnerRef;
  product: { id: string | number; name: string; category: string | null };
  qtyContract: number | string | null;
  uom: string | null;
  tolerancePct: number | string | null;
  certificate: string | null;
  validFrom: string | null;
  validUntil: string | null;
  customerPoNo: string | null;
  state: string;
  syncedAt: string | null;
}

export interface ContractList {
  items: Contract[];
  total: number;
}

export interface SyncResult {
  contracts: number;
  partners: number;
  products: number;
  skipped: number;
  durationMs: number;
}

export interface SyncRun {
  id: string | number;
  entity: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  rowsUpserted: number | null;
  error: string | null;
}

export interface SyncRunList {
  items: SyncRun[];
}
