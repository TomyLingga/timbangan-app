// Draws any step form from its field list (src/forms/*): one widget per field kind.

import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { AvailableSealsResponse } from "../api/types";
import { errorMessage } from "../api/messages";
import { SEAL_STATE } from "../forms/incoming";
import { type Errors, type Field, type FieldValue, type FormContext, type FormValues, type OldSealRow, OTHER_PRODUCT, type Photo, type SealCheckRow, type SealPick, type TankOption, tankOptions } from "../forms/shared";
import { clockTime } from "../lib/format";
import { takePhoto } from "../platform/photo";
import { useSession } from "../state/session";
import { useRemote } from "../state/useRemote";
import { useTheme } from "../theme/ThemeProvider";
import { fontSize, radius, space, TOUCH } from "../theme/tokens";
import { Banner, Button, Choices, ErrorText, Field as FieldBox, Input, Loading, mono, Rows, SectionTitle, Sheet, T } from "./kit";

interface Props {
  fields: Field[];
  values: FormValues;
  errors: Errors;
  ctx: FormContext;
  onChange(key: string, value: FieldValue): void;
}

export function FormFields({ fields, values, errors, ctx, onChange }: Props) {
  return (
    <View style={{ gap: space.lg }}>
      {fields.map((field) => (
        <FieldView key={field.key} field={field} value={values[field.key] ?? null} error={errors[field.key]} ctx={ctx} onChange={(value) => onChange(field.key, value)} />
      ))}
    </View>
  );
}

function FieldView({ field, value, error, ctx, onChange }: { field: Field; value: FieldValue; error?: string; ctx: FormContext; onChange(value: FieldValue): void }) {
  const testID = `field-${field.key}`;
  switch (field.kind) {
    case "section":
      return <SectionTitle>{field.title}</SectionTitle>;
    case "info":
      return <Rows rows={[{ label: field.label, value: field.value }]} />;
    case "choice":
      return (
        <FieldBox label={field.label} required={field.required} error={error} testID={testID}>
          <Choices options={field.options} value={typeof value === "string" ? value : null} onChange={onChange} columns={field.columns} invalid={!!error} />
        </FieldBox>
      );
    case "number":
      return (
        <FieldBox label={field.unit ? `${field.label} (${field.unit})` : field.label} required={field.required} hint={field.hint} error={error} testID={testID}>
          <Input
            value={typeof value === "string" ? value : ""}
            onChangeText={onChange}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="Ketik angka"
            invalid={!!error}
            accessibilityLabel={field.label}
            testID={`input-${field.key}`}
          />
        </FieldBox>
      );
    case "text":
      return (
        <FieldBox label={field.label} required={field.required} error={error} testID={testID}>
          <Input
            value={typeof value === "string" ? value : ""}
            onChangeText={onChange}
            placeholder={field.placeholder}
            multiline
            maxLength={field.maxLength}
            style={{ minHeight: 96 }}
            invalid={!!error}
            accessibilityLabel={field.label}
            testID={`input-${field.key}`}
          />
        </FieldBox>
      );
    case "tank":
      return (
        <FieldBox label={field.label} required={field.required} error={error} testID={testID}>
          {ctx.form.tanks.length === 0 ? (
            <Banner tone="warn" icon="alert-triangle" title="Belum ada tangki untuk produk ini">
              Minta admin menambah tangki di master.
            </Banner>
          ) : (
            <TankPicker options={tankOptions(ctx.form.tanks)} value={typeof value === "string" ? value : null} onChange={onChange} invalid={!!error} />
          )}
        </FieldBox>
      );
    case "tick":
      return <Tick label={field.label} required={field.required} checked={value === true} error={error} onChange={onChange} testID={testID} />;
    case "photos":
      return <PhotosField label={field.label} max={field.max} photos={Array.isArray(value) ? (value as Photo[]) : []} error={error} onChange={onChange} testID={testID} />;
    case "stockSeals":
      return <StockSeals label={field.label} slots={Array.isArray(value) ? (value as (SealPick | null)[]) : []} error={error} onChange={onChange} testID={testID} />;
    case "sealCheck":
      return <SealCheckList label={field.label} rows={Array.isArray(value) ? (value as SealCheckRow[]) : []} error={error} onChange={onChange} testID={testID} />;
    case "oldSeals":
      return <OldSeals label={field.label} rows={Array.isArray(value) ? (value as OldSealRow[]) : []} error={error} onChange={onChange} testID={testID} />;
    default:
      return null;
  }
}

/** One row per tank: code, what it holds, and a quiet "produk lain" for a tank of another product. */
function TankPicker({ options, value, onChange, invalid }: { options: TankOption[]; value: string | null; onChange(value: string): void; invalid: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={[option.code, option.label, option.fits ? null : OTHER_PRODUCT].filter(Boolean).join(", ")}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radius.md,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? colors.primary : invalid ? colors.danger : colors.lineStrong,
              backgroundColor: selected ? colors.primarySubtle : pressed ? colors.fill : colors.surface,
            })}
          >
            <Text style={{ fontFamily: mono, fontSize: 19, fontWeight: "800", color: selected ? colors.primaryInk : colors.foreground }}>{option.code}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: selected ? colors.primaryInk : colors.foreground }} numberOfLines={2}>
                {option.label ?? "–"}
              </Text>
              {option.fits ? null : <Text style={{ fontSize: fontSize.small, color: colors.muted }}>{OTHER_PRODUCT}</Text>}
            </View>
            {selected ? <Feather name="check" size={22} color={colors.primaryInk} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Tick({ label, required, checked, error, onChange, testID }: { label: string; required: boolean; checked: boolean; error?: string; onChange(value: boolean): void; testID: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.sm }} testID={testID}>
      <Pressable
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={label}
        style={({ pressed }) => ({
          minHeight: TOUCH + 8,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          padding: space.md,
          borderRadius: radius.lg,
          borderWidth: checked ? 2 : 1,
          borderColor: checked ? colors.success : error ? colors.danger : colors.lineStrong,
          backgroundColor: checked ? colors.successSubtle : pressed ? colors.fill : colors.surface,
        })}
      >
        <View style={{ width: 34, height: 34, borderRadius: 8, borderWidth: 2, borderColor: checked ? colors.success : colors.input, backgroundColor: checked ? colors.success : "transparent", alignItems: "center", justifyContent: "center" }}>
          {checked ? <Feather name="check" size={24} color={colors.card} /> : null}
        </View>
        <Text style={{ flex: 1, fontSize: fontSize.body, fontWeight: "700", color: colors.foreground }}>
          {label}
          {required ? <Text style={{ color: colors.danger }}> *</Text> : null}
        </Text>
      </Pressable>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

function PhotosField({ label, max, photos, error, onChange, testID }: { label: string; max: number; photos: Photo[]; error?: string; onChange(value: Photo[]): void; testID: string }) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async (source: "camera" | "gallery") => {
    setBusy(true);
    setProblem(null);
    const result = await takePhoto(source);
    setBusy(false);
    if (result.ok) onChange([...photos, result.photo].slice(0, max));
    else if (result.message) setProblem(result.message);
  };
  return (
    <FieldBox label={label} error={error ?? problem ?? undefined} testID={testID}>
      {photos.length > 0 ? (
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          {photos.map((photo, index) => (
            <View key={photo.uri} style={{ width: 104, height: 104, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.lineStrong }}>
              <Image source={{ uri: photo.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
              <Pressable
                onPress={() => onChange(photos.filter((_, at) => at !== index))}
                accessibilityRole="button"
                accessibilityLabel={`Hapus foto ${index + 1}`}
                style={{ position: "absolute", top: 4, right: 4, width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center" }}
              >
                <Feather name="x" size={22} color="#ffffff" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {photos.length < max ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button label="Kamera" icon="camera" kind="secondary" onPress={() => void add("camera")} busy={busy} style={{ flex: 1 }} />
          <Button label="Galeri" icon="image" kind="secondary" onPress={() => void add("gallery")} disabled={busy} style={{ flex: 1 }} />
        </View>
      ) : (
        <T kind="muted">Sudah {max} foto.</T>
      )}
    </FieldBox>
  );
}

function StockSeals({ label, slots, error, onChange, testID }: { label: string; slots: (SealPick | null)[]; error?: string; onChange(value: (SealPick | null)[]): void; testID: string }) {
  const { colors } = useTheme();
  const [picking, setPicking] = useState<number | null>(null);
  const chosen = slots.filter((slot): slot is SealPick => !!slot).map((slot) => slot.id);
  return (
    <View style={{ gap: space.md }} testID={testID}>
      {slots.map((slot, index) => (
        <FieldBox key={index} label={`${label} ${index + 1}`} required={index === 0} error={index === 0 ? error : undefined}>
          <Pressable
            onPress={() => setPicking(index)}
            accessibilityRole="button"
            accessibilityLabel={slot ? `${label} ${index + 1}: ${slot.sealNo}` : `Pilih ${label} ${index + 1}`}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingHorizontal: space.lg,
              borderRadius: radius.md,
              borderWidth: slot ? 2 : 1,
              borderColor: error && (index === 0 || slot) ? colors.danger : slot ? colors.primary : colors.input,
              backgroundColor: pressed ? colors.fill : colors.surface,
            })}
          >
            <Text style={{ flex: 1, fontFamily: slot ? mono : undefined, fontSize: slot ? 20 : fontSize.body, fontWeight: slot ? "800" : "500", color: slot ? colors.foreground : colors.muted }}>
              {slot ? slot.sealNo : "Pilih segel dari stok"}
            </Text>
            {slot ? (
              <Pressable
                onPress={() => onChange(slots.map((item, at) => (at === index ? null : item)))}
                accessibilityRole="button"
                accessibilityLabel={`Kosongkan ${label} ${index + 1}`}
                hitSlop={8}
                style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
              >
                <Feather name="x-circle" size={24} color={colors.muted} />
              </Pressable>
            ) : (
              <Feather name="chevron-right" size={24} color={colors.muted} />
            )}
          </Pressable>
        </FieldBox>
      ))}
      <SealPicker
        visible={picking !== null}
        exclude={chosen}
        title={picking === null ? "" : `${label} ${picking + 1}`}
        onClose={() => setPicking(null)}
        onPick={(seal) => {
          onChange(slots.map((item, at) => (at === picking ? seal : item)));
          setPicking(null);
        }}
      />
    </View>
  );
}

function SealPicker({ visible, exclude, title, onClose, onPick }: { visible: boolean; exclude: number[]; title: string; onClose(): void; onPick(seal: SealPick): void }) {
  const { api } = useSession();
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const remote = useRemote(
    () => api.request<AvailableSealsResponse>("/api/work/seals/available", { query: { q: query.trim(), limit: 50 } }),
    [query, visible],
    { cacheKey: query.trim() === "" ? "seals-available" : null, enabled: visible },
  );
  const items = (remote.data?.items ?? []).filter((seal) => !exclude.includes(seal.id));
  return (
    <Sheet visible={visible} onClose={onClose} title={title} testID="seal-picker" footer={<Button label="Tutup" kind="secondary" onPress={onClose} />}>
      <Input value={query} onChangeText={setQuery} placeholder="Cari nomor segel" autoCapitalize="characters" testID="seal-search" />
      {remote.stale && remote.fetchedAt ? <T kind="muted">Tidak tersambung. Daftar pukul {clockTime(remote.fetchedAt)}.</T> : null}
      {remote.loading && !remote.data ? <Loading /> : null}
      {remote.error && !remote.data ? <ErrorText>{errorMessage(remote.error)}</ErrorText> : null}
      {remote.data && items.length === 0 ? <T kind="muted">Tidak ada segel tersedia{query ? ` dengan nomor "${query}"` : ""}.</T> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {items.map((seal) => (
          <Pressable
            key={seal.id}
            onPress={() => onPick({ id: seal.id, sealNo: seal.sealNo })}
            accessibilityRole="button"
            accessibilityLabel={`Segel ${seal.sealNo}`}
            style={({ pressed }) => ({
              minHeight: TOUCH,
              minWidth: "47%",
              flexGrow: 1,
              justifyContent: "center",
              paddingHorizontal: space.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.lineStrong,
              backgroundColor: pressed ? colors.primarySubtle : colors.surface,
            })}
          >
            <Text style={{ fontFamily: mono, fontSize: 19, fontWeight: "800", color: colors.foreground }}>{seal.sealNo}</Text>
            <Text style={{ fontSize: 15, color: colors.muted, fontWeight: "600" }}>{seal.kind === "CUSTOMS" ? "Bea cukai" : "Locis"}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

function SealCheckList({ label, rows, error, onChange, testID }: { label: string; rows: SealCheckRow[]; error?: string; onChange(value: SealCheckRow[]): void; testID: string }) {
  const { colors } = useTheme();
  const update = (index: number, changes: Partial<SealCheckRow>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...changes } : row)));
  return (
    <FieldBox label={label} required error={error} testID={testID}>
      {rows.length === 0 ? <T kind="muted">Surat tidak mencatat segel. Tambahkan nomor segel yang terpasang.</T> : null}
      {rows.map((row, index) => (
        <View key={index} style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
          {row.declared ? (
            <Text style={{ fontFamily: mono, fontSize: 20, fontWeight: "800", color: colors.foreground }}>{row.sealNo}</Text>
          ) : (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <Input value={row.sealNo} onChangeText={(sealNo) => update(index, { sealNo })} placeholder="Nomor segel" autoCapitalize="characters" style={{ flex: 1 }} />
              <Pressable onPress={() => onChange(rows.filter((_, at) => at !== index))} accessibilityRole="button" accessibilityLabel="Hapus segel" style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
                <Feather name="trash-2" size={22} color={colors.danger} />
              </Pressable>
            </View>
          )}
          <Choices options={SEAL_STATE} value={row.intact === null ? null : row.intact ? "INTACT" : "BROKEN"} onChange={(state) => update(index, { intact: state === "INTACT" })} />
        </View>
      ))}
      <Button label="Tambah segel" icon="plus" kind="secondary" onPress={() => onChange([...rows, { sealNo: "", intact: null, declared: false }])} />
    </FieldBox>
  );
}

function OldSeals({ label, rows, error, onChange, testID }: { label: string; rows: OldSealRow[]; error?: string; onChange(value: OldSealRow[]): void; testID: string }) {
  const { colors } = useTheme();
  const update = (index: number, changes: Partial<OldSealRow>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...changes } : row)));
  return (
    <View style={{ gap: space.sm }} testID={testID}>
      <Banner tone="warn" icon="alert-triangle" title="Truk masih bersegel">
        {label}
      </Banner>
      {rows.map((row, index) => (
        <View key={row.tripSealId} style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
          <Text style={{ fontFamily: mono, fontSize: 20, fontWeight: "800", color: colors.foreground }}>{row.sealNo}</Text>
          <Tick label="Sudah dibuka" required checked={row.opened} onChange={(opened) => update(index, { opened })} testID={`old-seal-${index}`} />
          <Input value={row.reason} onChangeText={(reason) => update(index, { reason })} placeholder="Alasan dibuka" />
        </View>
      ))}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}
