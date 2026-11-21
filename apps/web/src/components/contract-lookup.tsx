"use client";

import { EntityLookup } from "@/components/entity-lookup";
import { formatQuantity } from "@/lib/format";
import { api } from "@/lib/session";
import type { Contract, ContractList, Direction } from "@/lib/types";

const OPTION_LIMIT = 8;

interface ContractLookupProps {
  direction: Direction;
  label: string;
  placeholder: string;
  name: string;
  /** The chosen contract, or null. Pass null to use the lookup for adding to a list. */
  value: Pick<Contract, "contractNo"> | null;
  onSelect: (contract: Contract) => void;
  onClear?: () => void;
  /** Contracts already taken elsewhere on the form; they are left out of the options. */
  exclude?: ReadonlyArray<string | number>;
  optional?: boolean;
  error?: string;
  hint?: string;
  className?: string;
}

/** Searchable choice of one open contract, from GET /api/contracts. */
export function ContractLookup({
  direction,
  label,
  placeholder,
  name,
  value,
  onSelect,
  onClear,
  exclude = [],
  optional,
  error,
  hint,
  className,
}: ContractLookupProps) {
  const excluded = new Set(exclude.map(String));
  return (
    <EntityLookup<Contract>
      label={label}
      placeholder={placeholder}
      name={name}
      optional={optional}
      error={error}
      hint={hint}
      className={className}
      scope={`${direction}|${[...excluded].join(",")}`}
      search={async (text, signal) => {
        const page = await api.request<ContractList>("/api/contracts", {
          query: { direction, q: text, limit: OPTION_LIMIT + excluded.size },
          signal,
        });
        const items = page.items.filter((contract) => !excluded.has(String(contract.id))).slice(0, OPTION_LIMIT);
        return { items, total: Math.max(page.total - excluded.size, items.length) };
      }}
      optionKey={(contract) => contract.id}
      optionLabel={(contract) => contract.contractNo}
      optionDetail={(contract) =>
        [contract.partner.name, contract.product.name, formatQuantity(contract.qtyContract, contract.uom)].join(" · ")
      }
      valueLabel={value?.contractNo ?? null}
      onSelect={onSelect}
      onClear={onClear}
      narrowBy="nomor kontrak"
    />
  );
}
