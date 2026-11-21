"use client";

import { EntityLookup } from "@/components/entity-lookup";
import { api } from "@/lib/session";
import type { Page, Partner, PartnerRef, PartnerRole } from "@/lib/types";

const OPTION_LIMIT = 8;

interface PartnerLookupProps {
  role: PartnerRole;
  label: string;
  placeholder: string;
  value: PartnerRef | null;
  onChange: (partner: PartnerRef | null) => void;
  optional?: boolean;
  error?: string;
  /** Marks the text input, so tests and password managers can tell lookups apart. */
  name: string;
  className?: string;
}

/** Searchable choice of one partner, from GET /api/partners. */
export function PartnerLookup({
  role,
  label,
  placeholder,
  value,
  onChange,
  optional,
  error,
  name,
  className,
}: PartnerLookupProps) {
  return (
    <EntityLookup<Partner>
      label={label}
      placeholder={placeholder}
      name={name}
      optional={optional}
      error={error}
      className={className}
      scope={role}
      search={(text, signal) =>
        api.request<Page<Partner>>("/api/partners", { query: { role, q: text, limit: OPTION_LIMIT }, signal })
      }
      optionKey={(partner) => partner.id}
      optionLabel={(partner) => partner.name}
      valueLabel={value?.name ?? null}
      onSelect={(partner) => onChange({ id: partner.id, name: partner.name })}
      onClear={() => onChange(null)}
      narrowBy="nama"
    />
  );
}

/**
 * Transporter of a registration, from GET /api/lookup/transporters: names
 * only, open to every account that may register (partner accounts included).
 */
export function TransporterLookup({
  label,
  placeholder,
  value,
  onChange,
  optional,
  error,
  name,
  className,
}: Omit<PartnerLookupProps, "role">) {
  return (
    <EntityLookup<PartnerRef>
      label={label}
      placeholder={placeholder}
      name={name}
      optional={optional}
      error={error}
      className={className}
      scope="lookup-transporter"
      search={(text, signal) =>
        api.request<Page<PartnerRef>>("/api/lookup/transporters", { query: { q: text, limit: OPTION_LIMIT }, signal })
      }
      optionKey={(partner) => partner.id}
      optionLabel={(partner) => partner.name}
      valueLabel={value?.name ?? null}
      onSelect={(partner) => onChange({ id: partner.id, name: partner.name })}
      onClear={() => onChange(null)}
      narrowBy="nama"
    />
  );
}
