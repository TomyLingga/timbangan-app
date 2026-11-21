import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { errorMessage } from "../../src/api/messages";
import { goToMain } from "../../src/ui/nav";
import type { StepDetailResponse } from "../../src/api/types";
import { canSendForm } from "../../src/auth/permissions";
import { formFor, noFormReason } from "../../src/forms/registry";
import type { FieldValue, FormContext, FormDefinition, FormValues } from "../../src/forms/shared";
import { kg, plateOf } from "../../src/lib/format";
import { useQueue } from "../../src/state/queue";
import { useSession } from "../../src/state/session";
import { useRemote } from "../../src/state/useRemote";
import { space } from "../../src/theme/tokens";
import { NetStrip, TruckBlock } from "../../src/ui/chrome";
import { FormFields } from "../../src/ui/form";
import { SignedIn } from "../../src/ui/guard";
import { Banner, Button, Header, Loading, Panel, Rows, Screen, Sheet, T } from "../../src/ui/kit";

export default function StepScreen() {
  return (
    <SignedIn>
      <Step />
    </SignedIn>
  );
}

const back = () => (router.canGoBack() ? router.back() : router.replace("/beranda"));

function Step() {
  const params = useLocalSearchParams<{ id: string; ulang?: string }>();
  const id = Number(params.id);
  const { api } = useSession();
  const remote = useRemote(() => api.request<StepDetailResponse>(`/api/work/steps/${id}`), [id], { cacheKey: `step-${id}` });

  if (remote.loading && !remote.data) {
    return (
      <Screen>
        <Header title="Langkah" onBack={back} />
        <Loading />
      </Screen>
    );
  }
  if (!remote.data) {
    return (
      <Screen>
        <Header title="Langkah" onBack={back} />
        <Banner tone="bad" icon="alert-circle" title="Langkah tidak bisa dibuka">
          {errorMessage(remote.error)}
        </Banner>
        <Button label="Coba lagi" icon="refresh-cw" kind="secondary" onPress={() => void remote.reload()} />
      </Screen>
    );
  }
  const definition = formFor(remote.data.step);
  if (!definition) {
    return (
      <Screen>
        <Header title={remote.data.step.name} onBack={back} />
        <TruckBlock truck={remote.data.step.truck} stepName={remote.data.step.name} />
        <Banner tone="warn" icon="info" title={noFormReason(remote.data.step)} />
      </Screen>
    );
  }
  return <StepForm key={`${id}-${definition.route}`} detail={remote.data} definition={definition} reopen={params.ulang ?? null} fetchedAt={remote.fetchedAt} stale={remote.stale} />;
}

function StepForm({ detail, definition, reopen, fetchedAt, stale }: { detail: StepDetailResponse; definition: FormDefinition; reopen: string | null; fetchedAt: Date | null; stale: boolean }) {
  const { user } = useSession();
  const queue = useQueue();
  const reopened = reopen ? queue.items.find((item) => item.clientUuid === reopen) : undefined;
  const [now, setNow] = useState(() => new Date());
  const ctx: FormContext = useMemo(() => ({ step: detail.step, form: detail.form, now }), [detail, now]);
  const [values, setValues] = useState<FormValues>(() => (reopened?.values as FormValues | undefined) ?? definition.initial(ctx));
  const [showErrors, setShowErrors] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // a clock on the form for the loading times
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const errors = showErrors ? definition.validate(values, ctx) : {};
  const errorCount = Object.keys(errors).length;
  const allowed = canSendForm(user, detail.step.module);
  const pending = queue.pendingFor(detail.step.id);
  const fields = definition.fields(values, ctx);
  const letter = detail.form.letter;

  const setValue = (key: string, value: FieldValue) => setValues((current) => ({ ...current, [key]: value }));

  const check = () => {
    setShowErrors(true);
    setNow(new Date());
    if (Object.keys(definition.validate(values, { ...ctx, now: new Date() })).length === 0) setSummaryOpen(true);
  };

  const send = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const at = new Date();
      const sendCtx = { ...ctx, now: at };
      const clientUuid = randomUUID();
      await queue.enqueue({
        clientUuid,
        path: `/api/work/steps/${detail.step.id}/${definition.route}`,
        body: definition.body(values, sendCtx, clientUuid),
        photos: (definition.photos?.(values) ?? []).map((photo) => ({ uri: photo.uri, fileId: null })),
        label: { form: definition.title, plate: plateOf(detail.step.truck), stepId: detail.step.id, stepName: detail.step.name },
        values,
      });
      if (reopened) await queue.discard(reopened.clientUuid);
      setSummaryOpen(false);
      goToMain("/beranda");
    } catch {
      setSaveError("Form tidak bisa disimpan di ponsel. Coba lagi.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      testID={`form-${definition.route.replace("/", "-")}`}
      footer={
        <View style={{ padding: space.md, gap: space.sm }}>
          {errorCount > 0 ? <T kind="small" style={{ textAlign: "center", fontWeight: "700" }}>Ada {errorCount} isian yang perlu diperbaiki.</T> : null}
          <Button label={definition.submitLabel} icon="check-circle" onPress={check} disabled={!allowed || pending} testID="form-check" />
        </View>
      }
    >
      <Header title={definition.title} onBack={back} />
      <NetStrip fetchedAt={fetchedAt} stale={stale} />
      {reopened ? (
        <Banner tone="bad" icon="rotate-ccw" title="Kiriman ini ditolak server">
          {reopened.lastError?.message ?? ""} Perbaiki isiannya, lalu kirim lagi.
        </Banner>
      ) : null}
      {!allowed ? <Banner tone="warn" icon="lock" title="Akun ini hanya bisa melihat langkah ini." /> : null}
      {pending ? (
        <Banner tone="warn" icon="upload-cloud" title="Form langkah ini menunggu terkirim">
          Tunggu sampai terkirim. Keadaannya ada di Profil.
        </Banner>
      ) : null}
      <TruckBlock truck={detail.step.truck} stepName={detail.step.name} />
      {letter && detail.step.stepCode === "QC" ? (
        <Panel>
          <T kind="heading">Angka surat</T>
          <Rows
            rows={[
              { label: "Bruto surat", value: kg(letter.docGrossKg) },
              { label: "Tarra surat", value: kg(letter.docTareKg) },
              { label: "Netto surat", value: kg(letter.docNetKg) },
            ]}
          />
        </Panel>
      ) : null}
      <Panel>
        <FormFields fields={fields} values={values} errors={errors} ctx={ctx} onChange={setValue} />
      </Panel>
      <Sheet
        visible={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        title={`Ringkasan ${definition.title}`}
        testID="summary-sheet"
        footer={
          <>
            {saveError ? <Banner tone="bad" icon="alert-circle" title={saveError} /> : null}
            <Button label="Kirim" icon="send" onPress={() => void send()} busy={saving} testID="summary-send" />
            <Button label="Ubah isian" kind="secondary" onPress={() => setSummaryOpen(false)} />
          </>
        }
      >
        <T kind="label">{plateOf(detail.step.truck)} · {detail.step.name}</T>
        <Rows rows={definition.summary(values, { ...ctx, now })} testID="summary-rows" />
        <T kind="muted">Kiriman disimpan di ponsel dulu, lalu dikirim. Tanpa sinyal, dikirim sendiri saat sinyal kembali.</T>
      </Sheet>
    </Screen>
  );
}
