"use client";

import { useId, useMemo, useState } from "react";
import { ShieldCheck, ShieldOff, UserRoundCog } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField } from "@/components/form-fields";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAction } from "@/hooks/use-form";
import { formatDateTime } from "@/lib/format";
import { userAdminErrorMessage } from "@/lib/messages";
import {
  accessSummary,
  canEdit,
  canView,
  grantAll,
  levelChoices,
  modulesForKind,
  permissionsPayload,
  setLevel,
} from "@/lib/permissions";
import { api } from "@/lib/session";
import type { AdminUser, ModuleDefinition, Page, PermissionLevel, Permissions, User } from "@/lib/types";

const LIST_LIMIT = 50;

function userPath(user: AdminUser): string {
  return `/api/admin/users/${encodeURIComponent(String(user.id))}`;
}

function PermissionsSheet({
  account,
  modules,
  onClose,
  onSaved,
}: {
  account: AdminUser;
  modules: readonly ModuleDefinition[];
  onClose: () => void;
  onSaved: (account: AdminUser) => void;
}) {
  const [levels, setLevels] = useState<Permissions>(account.permissions);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();
  const offered = modulesForKind(modules, account.kind);

  async function handleSubmit() {
    setFormError(null);
    const outcome = await save.run(() =>
      api.request<{ user: AdminUser }>(`${userPath(account)}/permissions`, {
        method: "PUT",
        body: { permissions: permissionsPayload(modules, account.kind, levels) },
      }),
    );
    if (outcome.ok) onSaved(outcome.value.user);
    else setFormError(userAdminErrorMessage(outcome.error));
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Hak akses ${account.fullName}`}
      description={
        account.kind === "INTERNAL"
          ? "Akun karyawan. Tingkat yang lebih tinggi mencakup yang di bawahnya."
          : `Akun partner${account.partner ? ` ${account.partner.name}` : ""}. Hanya modul yang boleh untuk partner yang tampil; data yang terlihat tetap data perusahaannya sendiri.`
      }
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setLevels(grantAll(modules, account.kind))}>
          <ShieldCheck aria-hidden="true" />
          Beri semua
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setLevels({})}>
          <ShieldOff aria-hidden="true" />
          Cabut semua
        </Button>
      </div>
      <fieldset className="flex flex-col gap-3" aria-label="Hak akses per modul">
        {offered.map((module) => (
          <SelectField
            key={module.code}
            label={module.name}
            name={`permission-${module.code}`}
            value={levels[module.code] ?? ""}
            onChange={(value) => setLevels((current) => setLevel(current, module.code, (value || null) as PermissionLevel | null))}
            emptyLabel="Tidak ada akses"
            options={levelChoices(module)
              .filter((choice) => choice.value !== "")
              .map((choice) => ({ value: choice.value, label: choice.label }))}
          />
        ))}
      </fieldset>
    </FormSheet>
  );
}

function UsersPage({ currentUser, onOwnAccountChanged }: { currentUser: User; onOwnAccountChanged: () => void }) {
  const ids = useId();
  const mayEdit = canEdit(currentUser, "users");
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
  const modules = useApiQuery("modules", (signal) =>
    api.request<{ items: ModuleDefinition[] }>("/api/admin/modules", { signal }),
  );
  const moduleList = useMemo(() => modules.data?.items ?? [], [modules.data]);

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
        id: "access",
        header: "Hak akses",
        wide: true,
        cellClassName: "max-w-72 whitespace-normal",
        cell: (account) =>
          Object.keys(account.permissions).length === 0 ? (
            <StatusBadge info={{ label: "Belum ada akses", tone: "warning" }} />
          ) : (
            <span className="text-sm">{accessSummary(account.permissions, moduleList, account.kind)}</span>
          ),
      },
      {
        id: "active",
        header: "Aktif",
        cell: (account) => (
          <span className="flex items-center gap-2">
            <Switch
              checked={account.isActive}
              disabled={!mayEdit || togglingId === account.id}
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
  }, [togglingId, moduleList, mayEdit]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Pengguna"
        description="Karyawan yang baru masuk lewat portal belum punya hak akses. Atur modul yang boleh dibukanya di sini."
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
            actions={
              mayEdit
                ? (account) =>
                    modules.data ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-10 md:h-8"
                        onClick={() => setEditing(account)}
                        aria-label={`Atur hak akses ${account.fullName}`}
                      >
                        <UserRoundCog aria-hidden="true" />
                        Atur hak akses
                      </Button>
                    ) : modules.hasError ? null : (
                      <Skeleton className="h-8 w-28" />
                    )
                : undefined
            }
          />
          {modules.hasError ? (
            <Notice tone="error">Daftar modul belum bisa dimuat, jadi hak akses belum bisa diatur. {userAdminErrorMessage(modules.error)}</Notice>
          ) : null}
        </div>
      )}

      {editing && modules.data ? (
        <PermissionsSheet
          account={editing}
          modules={modules.data.items}
          onClose={() => setEditing(null)}
          onSaved={(account) => {
            setEditing(null);
            setNotice({ tone: "success", text: `Hak akses ${account.fullName} disimpan.` });
            setReloadToken((token) => token + 1);
            // The admin's own permissions decide what this page and the menu may show.
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
  if (!canView(state.user, "users")) return <AccessDenied module="users" />;
  return <UsersPage currentUser={state.user} onOwnAccountChanged={restore} />;
}
