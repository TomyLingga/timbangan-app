"use client";

import { useId, useMemo, useState } from "react";
import { UserRoundCog } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { CheckboxField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import {
  AccessDenied,
  ListEmpty,
  ListError,
  ListSkeleton,
  Notice,
  PageHeader,
  ResultCount,
  SearchField,
} from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAction } from "@/hooks/use-form";
import { formatDateTime } from "@/lib/format";
import { userAdminErrorMessage } from "@/lib/messages";
import { canManageUsers, ROLE_LABELS, roleLabels, rolesForKind, toggleRole } from "@/lib/roles";
import { api } from "@/lib/session";
import type { AdminUser, Page, RoleDefinition, User } from "@/lib/types";

const LIST_LIMIT = 50;

function userPath(user: AdminUser): string {
  return `/api/admin/users/${encodeURIComponent(String(user.id))}`;
}

function RolesSheet({
  account,
  onClose,
  onSaved,
}: {
  account: AdminUser;
  onClose: () => void;
  onSaved: (account: AdminUser) => void;
}) {
  const [selected, setSelected] = useState<string[]>(account.roles);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const roles = useApiQuery("roles", (signal) =>
    api.request<{ items: RoleDefinition[] }>("/api/admin/roles", { signal }),
  );
  // Only roles of the account's own kind: staff roles for staff, partner roles for partners.
  const offered = roles.data ? rolesForKind(roles.data.items, account.kind) : [];

  async function handleSubmit() {
    setFormError(null);
    const outcome = await save.run(() =>
      api.request<{ user: AdminUser }>(`${userPath(account)}/roles`, { method: "PUT", body: { roles: selected } }),
    );
    if (outcome.ok) onSaved(outcome.value.user);
    else setFormError(userAdminErrorMessage(outcome.error));
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Peran ${account.fullName}`}
      description={
        account.kind === "INTERNAL"
          ? "Akun karyawan. Hanya peran karyawan yang bisa dipilih."
          : "Akun perusahaan partner. Hanya peran partner yang bisa dipilih."
      }
      pending={save.pending}
      error={formError ?? (roles.hasError ? userAdminErrorMessage(roles.error) : null)}
      onSubmit={handleSubmit}
    >
      {!roles.data && !roles.hasError ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-6 w-3/5" />
        </div>
      ) : (
        <fieldset className="flex flex-col">
          <legend className="mb-1 text-sm font-medium">Peran</legend>
          {offered.map((role) => (
            <CheckboxField
              key={role.code}
              name={`role-${role.code}`}
              label={ROLE_LABELS[role.code] ?? role.name}
              checked={selected.includes(role.code)}
              onChange={(checked) => setSelected((current) => toggleRole(current, role.code, checked))}
            />
          ))}
        </fieldset>
      )}
    </FormSheet>
  );
}

function UsersPage({ currentUser, onOwnAccountChanged }: { currentUser: User; onOwnAccountChanged: () => void }) {
  const ids = useId();
  const [searchText, setSearchText] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [togglingId, setTogglingId] = useState<AdminUser["id"] | null>(null);

  const search = useDebouncedValue(searchText.trim(), 300);
  const list = useApiQuery(
    `${search}|${reloadToken}`,
    (signal) => api.request<Page<AdminUser>>("/api/admin/users", { query: { q: search, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );

  const columns = useMemo<ReadonlyArray<Column<AdminUser>>>(() => {
    async function setActive(account: AdminUser, isActive: boolean) {
      setTogglingId(account.id);
      setNotice(null);
      try {
        await api.request(userPath(account), { method: "PATCH", body: { isActive } });
        setNotice({
          tone: "success",
          text: `Akun ${account.fullName} ${isActive ? "diaktifkan" : "dinonaktifkan"}.`,
        });
        setReloadToken((token) => token + 1);
      } catch (error) {
        setNotice({ tone: "error", text: userAdminErrorMessage(error) });
      } finally {
        setTogglingId(null);
      }
    }

    return [
      {
        id: "name",
        header: "Nama",
        primary: true,
        cell: (account) => (
          <>
            <span className="font-medium">{account.fullName}</span>
            <span className="block text-xs text-muted-foreground">{account.username}</span>
          </>
        ),
      },
      { id: "kind", header: "Jenis", cell: (account) => (account.kind === "INTERNAL" ? "Karyawan" : "Partner") },
      {
        id: "origin",
        header: "Nomor karyawan atau perusahaan",
        cell: (account) => (account.kind === "INTERNAL" ? account.employeeNo : account.partner?.name) || "-",
      },
      {
        id: "roles",
        header: "Peran",
        wide: true,
        cellClassName: "whitespace-normal",
        cell: (account) =>
          account.roles.length === 0 ? (
            <StatusBadge info={{ label: "Belum ada peran", tone: "warning" }} />
          ) : (
            <span className="flex flex-wrap gap-1">
              {roleLabels(account.roles).map((role) => (
                <Badge key={role} variant="outline">
                  {role}
                </Badge>
              ))}
            </span>
          ),
      },
      {
        id: "active",
        header: "Aktif",
        cell: (account) => (
          <span className="flex items-center gap-2">
            <Switch
              checked={account.isActive}
              disabled={togglingId === account.id}
              onCheckedChange={(checked) => void setActive(account, checked)}
              aria-label={`Akun ${account.fullName} aktif`}
            />
            <span className="text-muted-foreground">{account.isActive ? "Aktif" : "Nonaktif"}</span>
          </span>
        ),
      },
      {
        id: "lastLogin",
        header: "Masuk terakhir",
        cell: (account) =>
          account.lastLoginAt ? (
            <span className="whitespace-nowrap tabular-nums">{formatDateTime(account.lastLoginAt)}</span>
          ) : (
            "Belum pernah"
          ),
      },
    ];
  }, [togglingId]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Pengguna"
        description="Karyawan yang baru pertama kali masuk lewat portal belum punya peran: tetapkan perannya di sini supaya ia bisa memakai aplikasi."
      />

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      </div>

      <SearchField
        id={`${ids}-search`}
        label="Cari pengguna"
        placeholder="Nama atau nama pengguna"
        value={searchText}
        onChange={setSearchText}
      />

      {list.hasError ? (
        <ListError title="Daftar pengguna belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar pengguna" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada pengguna yang cocok"
          hint="Periksa lagi nama atau nama pengguna yang dicari."
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="pengguna" />
          <DataList
            columns={columns}
            rows={list.data.items}
            rowKey={(account) => account.id}
            stale={list.isStale}
            actions={(account) => (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 md:h-8"
                onClick={() => setEditing(account)}
                aria-label={`Atur peran ${account.fullName}`}
              >
                <UserRoundCog aria-hidden="true" />
                Atur peran
              </Button>
            )}
          />
        </div>
      )}

      {editing ? (
        <RolesSheet
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={(account) => {
            setEditing(null);
            setNotice({ tone: "success", text: `Peran ${account.fullName} disimpan.` });
            setReloadToken((token) => token + 1);
            // The admin's own roles decide what this page and the menu may show.
            if (String(account.id) === String(currentUser.id)) onOwnAccountChanged();
          }}
        />
      ) : null}
    </div>
  );
}

export function UsersScreen() {
  const { state, restore } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canManageUsers(state.user)) {
    return <AccessDenied reason="Pengaturan pengguna hanya untuk admin sistem." />;
  }
  return <UsersPage currentUser={state.user} onOwnAccountChanged={restore} />;
}
