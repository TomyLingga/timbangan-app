import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { isApiError } from "../../src/api/client";
import { decisionErrorMessage, errorMessage } from "../../src/api/messages";
import type { DecisionCode, ExceptionResponse, ExceptionView } from "../../src/api/types";
import { canDecide } from "../../src/auth/permissions";
import { decisionBody, decisionChoices, figureRows, plateRows, qcRows, REASON_MAX, reasonHint, reasonRequired, statusText, typeLabel, validateDecision } from "../../src/decisions/decision";
import { clockTime, readyFor } from "../../src/lib/format";
import { confirmIdentity } from "../../src/platform/deviceAuth";
import { useQueue } from "../../src/state/queue";
import { useSession } from "../../src/state/session";
import { useRemote } from "../../src/state/useRemote";
import { useTheme } from "../../src/theme/ThemeProvider";
import { radius, space } from "../../src/theme/tokens";
import { NetStrip } from "../../src/ui/chrome";
import { SignedIn } from "../../src/ui/guard";
import { Badge, Banner, Button, ErrorText, Field, Header, Input, Loading, Panel, Plate, Rows, Screen, T } from "../../src/ui/kit";

export default function DecisionScreen() {
  return (
    <SignedIn>
      <Decision />
    </SignedIn>
  );
}

const back = () => (router.canGoBack() ? router.back() : router.replace("/keputusan"));

function Decision() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const remote = useRemote(() => api.request<ExceptionResponse>(`/api/exceptions/${id}`), [id], { intervalMs: 2_000 });
  const view = remote.data?.exception;
  if (!view) {
    return (
      <Screen>
        <Header title="Keputusan" onBack={back} />
        {remote.loading ? <Loading /> : <Banner tone="bad" icon="alert-circle" title="Permintaan tidak bisa dibuka">{errorMessage(remote.error)}</Banner>}
      </Screen>
    );
  }
  const offline = remote.stale && isApiError(remote.error) && remote.error.status === 0;
  return <DecisionBody view={view} offline={offline} fetchedAt={remote.fetchedAt} stale={remote.stale} reload={remote.reload} />;
}

function DecisionBody({ view, offline, fetchedAt, stale, reload }: { view: ExceptionView; offline: boolean; fetchedAt: Date | null; stale: boolean; reload(): Promise<void> }) {
  const { api, user } = useSession();
  const { online } = useQueue();
  const { colors } = useTheme();
  const [reason, setReason] = useState("");
  const [masterTare, setMasterTare] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tapped, setTapped] = useState<DecisionCode | null>(null);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pendingNow = view.status === "PENDING";
  const allowed = canDecide(user, view.approverModule);
  const noSignal = !online || offline;
  const qc = view.type === "QC_HOLD";
  const locked = tapped !== null || sent || !pendingNow || !allowed || noSignal;

  const decide = async (code: DecisionCode) => {
    if (locked) return;
    const input = { decision: code, reason, updateMasterTare: masterTare };
    const found = validateDecision(view, input);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setTapped(code);
    setProblem(null);
    const identity = await confirmIdentity("Pastikan identitas sebelum keputusan dikirim");
    if (!identity.ok) {
      setProblem(identity.message);
      setTapped(null);
      return;
    }
    try {
      await api.request(`/api/exceptions/${view.id}/decide`, { method: "POST", body: decisionBody(view.type, input) });
      setSent(true);
      await reload();
    } catch (error) {
      setProblem(decisionErrorMessage(error));
      // a refusal that cannot change keeps the buttons off; a failed connection may be tried again
      if (!(isApiError(error) && (error.code === "ALREADY_DECIDED" || error.code === "EXCEPTION_CANCELLED"))) setTapped(null);
      else await reload();
    }
  };

  return (
    <Screen testID="screen-keputusan-detail">
      <Header title={typeLabel(view.type)} onBack={back} />
      <NetStrip fetchedAt={fetchedAt} stale={stale} />
      <Panel tone={pendingNow ? "warn" : "plain"}>
        <View style={{ alignSelf: "flex-start", backgroundColor: colors.surface, borderColor: colors.lineStrong, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          <Plate>{view.trip.plateDisplay ?? view.trip.plateNo ?? "Tanpa plat"}</Plate>
        </View>
        {pendingNow ? <Badge label={`Menunggu ${readyFor(view.raisedAt)}`} tone="warn" icon="clock" /> : <Badge label={statusText(view)} tone={view.status === "APPROVED" ? "ok" : "bad"} />}
        <T kind="muted">
          {qc ? "QC pass" : (view.station?.name ?? "Timbangan")}
          {view.stage ? ` · timbang ${view.stage}` : ""} · No Trip {view.trip.tripNo ?? "–"}
        </T>
      </Panel>

      <Panel>
        <T kind="heading">{qc ? "Hasil QC" : "Angka"}</T>
        <Rows rows={qc ? qcRows(view) : figureRows(view)} testID="decision-figures" />
        {!qc && view.liveWeightAt ? <T kind="muted">Berat sekarang dikirim timbangan pukul {clockTime(view.liveWeightAt)}.</T> : null}
      </Panel>

      {!qc ? (
        <Panel>
          <T kind="heading">Plat</T>
          <Rows rows={plateRows(view)} />
        </Panel>
      ) : null}

      {!pendingNow ? (
        <Panel>
          <T kind="heading">Sudah diputuskan</T>
          <Rows
            rows={[
              { label: "Keputusan", value: statusText(view) },
              { label: "Oleh", value: view.decidedBy?.fullName ?? "–" },
              { label: "Pukul", value: view.decidedAt ? clockTime(view.decidedAt) : "–" },
              ...(view.reason ? [{ label: "Alasan", value: view.reason }] : []),
              ...(view.reportNo ? [{ label: "Berita Acara", value: view.reportNo }] : []),
            ]}
          />
        </Panel>
      ) : !allowed ? (
        <Banner tone="warn" icon="lock" title="Akun ini hanya bisa melihat permintaan ini." />
      ) : (
        <Panel>
          <Field label={qc ? "Keterangan Approver" : "Alasan"} required={reasonRequired(view.type)} error={errors.reason}>
            <Input
              value={reason}
              onChangeText={setReason}
              placeholder={reasonHint(view)}
              multiline
              maxLength={REASON_MAX}
              style={{ minHeight: 88 }}
              invalid={!!errors.reason}
              editable={!locked}
              testID="decision-reason"
            />
          </Field>
          {view.type === "TARE_OUT" ? (
            <Button
              label={masterTare ? "Jadikan tarra master: ya" : "Jadikan tarra master: tidak"}
              icon={masterTare ? "check-square" : "square"}
              kind={masterTare ? "warn" : "secondary"}
              onPress={() => setMasterTare(!masterTare)}
              disabled={locked}
              testID="decision-master-tare"
            />
          ) : null}
          {errors.updateMasterTare ? <ErrorText>{errors.updateMasterTare}</ErrorText> : null}
          {noSignal ? <Banner tone="warn" icon="wifi-off" title="Tidak ada sinyal">Keputusan dikirim langsung, tidak lewat antrean. Tunggu sinyal kembali.</Banner> : null}
          <View style={{ gap: space.sm }}>
            {decisionChoices(view).map((choice) => (
              <Button
                key={choice.code}
                label={noSignal ? `${choice.label} (tidak ada sinyal)` : choice.label}
                kind={choice.tone === "ok" ? "primary" : choice.tone === "bad" ? "danger" : "warn"}
                icon={choice.tone === "ok" ? "check" : choice.tone === "bad" ? "x" : "repeat"}
                onPress={() => void decide(choice.code)}
                disabled={locked}
                busy={tapped === choice.code && !sent}
                testID={`decide-${choice.code}`}
              />
            ))}
          </View>
          <T kind="muted">Sidik jari atau PIN ponsel diminta sebelum keputusan dikirim.</T>
        </Panel>
      )}
      {problem ? <Banner tone="bad" icon="alert-circle" title={problem} /> : null}
      {sent ? <Banner tone="ok" icon="check-circle" title="Keputusan terkirim." /> : null}
    </Screen>
  );
}
