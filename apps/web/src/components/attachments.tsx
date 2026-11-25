"use client";

import { useId, useRef, useState } from "react";
import { ExternalLink, FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { checkAttachment, formatFileSize, ATTACHMENT_ACCEPT } from "@/lib/attachments";
import { isApiError } from "@/lib/api-client";
import { api } from "@/lib/session";
import type { AttachedFile, UploadedFile } from "@/lib/types";

/**
 * Opens a stored file in a new tab. The file route needs the session token, so the file is fetched here and the
 * tab shows it from a blob address. The tab is opened first, inside the click, so pop-up blockers let it through.
 */
export async function openStoredFile(id: string | number): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const { blob } = await api.download(`/api/files/${encodeURIComponent(String(id))}`);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** The words for a refused upload or link. */
export function attachmentErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "FILE_TOO_LARGE") return "Berkas terlalu besar: PDF paling besar 10 MB, gambar 5 MB.";
    if (error.code === "TOO_MANY_FILES" || error.code === "INVALID_STATE" || error.code === "DUPLICATE") return error.message;
    // a sent shipment request keeps one file: add the new one first
    if (error.code === "FILE_REQUIRED") return "Permintaan yang sudah dikirim harus tetap punya satu lampiran. Tambah berkas baru dulu, lalu hapus yang lama.";
    if (error.code === "VALIDATION") return Object.values(error.fieldMessages)[0] ?? "Berkas ditolak. Pilih PDF atau gambar JPEG, PNG, atau WebP.";
    if (error.code === "NETWORK_ERROR") return "Server tidak bisa dihubungi. Periksa sambungan, lalu coba lagi.";
    if (error.code === "FORBIDDEN") return "Akun Anda tidak berhak mengubah lampiran ini.";
    if (error.code === "NOT_FOUND") return "Lampiran tidak ditemukan. Muat ulang halaman.";
  }
  return "Berkas belum terkirim. Coba lagi.";
}

/** What the list shows of a file, linked or still waiting to be linked. */
export type ListedFile = Pick<AttachedFile, "id" | "originalName" | "mimeType" | "sizeBytes"> & Partial<Pick<AttachedFile, "label" | "addedAt" | "addedBy">>;

export interface AttachmentListProps {
  /** Accessible name of the block and the start of its button labels, e.g. "Lampiran" or "Slip timbang truk 1". */
  title: string;
  files: readonly ListedFile[];
  /** At most this many files. */
  max: number;
  /** Whether files may be added and removed here. */
  canChange: boolean;
  /** Links an uploaded file. Throws when the link is refused. */
  onAdd?: (file: UploadedFile) => Promise<void>;
  /** Unlinks a file. Throws when it is refused. */
  onRemove?: (file: ListedFile) => Promise<void>;
  emptyText: string;
  hint?: string;
  testId?: string;
}

/** A list of attached files with open buttons; upload with progress and remove when allowed. */
export function AttachmentList({ title, files, max, canChange, onAdd, onRemove, emptyText, hint, testId }: AttachmentListProps) {
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | number | null>(null);
  const [busyId, setBusyId] = useState<string | number | null>(null);
  const full = files.length >= max;

  async function choose(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file || !onAdd) return;
    const problem = checkAttachment(file);
    setMessage(problem);
    if (problem) return;
    setProgress(0);
    try {
      const uploaded = await api.upload<UploadedFile>("/api/files", file, file.name, { onProgress: setProgress });
      await onAdd(uploaded);
    } catch (error) {
      setMessage(attachmentErrorMessage(error));
    } finally {
      setProgress(null);
    }
  }

  async function open(file: ListedFile) {
    setMessage(null);
    try {
      await openStoredFile(file.id);
    } catch (error) {
      setMessage(isApiError(error) && error.code === "NOT_FOUND" ? "Berkas tidak ditemukan." : "Berkas belum bisa dibuka. Coba lagi.");
    }
  }

  async function remove(file: ListedFile) {
    if (!onRemove) return;
    setBusyId(file.id);
    setMessage(null);
    try {
      await onRemove(file);
      setConfirming(null);
    } catch (error) {
      setMessage(attachmentErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId} aria-label={title} role="group">
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((file) => {
            const pdf = file.mimeType === "application/pdf";
            const Icon = pdf ? FileText : ImageIcon;
            const name = file.originalName ?? (pdf ? "Dokumen PDF" : "Gambar");
            return (
              <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm" data-file-id={file.id}>
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={name}>
                    {name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {[file.label && file.label !== "SLIP_TIMBANG" ? file.label : null, formatFileSize(file.sizeBytes), file.addedBy?.fullName].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {confirming === file.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs">Hapus berkas ini?</span>
                    <Button size="sm" variant="destructive" disabled={busyId === file.id} onClick={() => void remove(file)}>
                      Ya, hapus
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Batal
                    </Button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-10 md:h-8" onClick={() => void open(file)} aria-label={`Buka ${name}`}>
                      <ExternalLink aria-hidden="true" />
                      Buka
                    </Button>
                    {canChange && onRemove ? (
                      <Button size="sm" variant="ghost" className="h-10 md:h-8" onClick={() => setConfirming(file.id)} aria-label={`Hapus ${name}`}>
                        <Trash2 aria-hidden="true" />
                        Hapus
                      </Button>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canChange && onAdd ? (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            id={`${ids}-file`}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label={`Pilih berkas untuk ${title}`}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            disabled={full || progress !== null}
            onClick={() => input.current?.click()}
            aria-describedby={`${ids}-hint`}
          >
            {progress !== null ? <Upload className="animate-pulse" aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
            {progress !== null ? "Mengunggah" : "Tambah berkas"}
          </Button>
          <span id={`${ids}-hint`} className="text-xs text-muted-foreground">
            {full ? `Sudah ${max} berkas, batasnya.` : (hint ?? "PDF sampai 10 MB atau gambar sampai 5 MB.")}
          </span>
          {progress !== null ? (
            <div
              role="progressbar"
              aria-label={`Unggah ${title}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite" className="empty:hidden">
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
      </div>
    </div>
  );
}
