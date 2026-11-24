// One Odoo pull and one VCF pull at a time in this process, whoever starts it: the web buttons or the daily job.
// `npm run sync:odoo` and `npm run sync:vcf` run in another process and are not seen here.

export type SyncKind = "odoo" | "vcf";

export class SyncLock {
  private readonly busy = new Set<SyncKind>();

  /** Takes the pull; answers the function that gives it back, or null when that pull is running already. */
  acquire(kind: SyncKind): (() => void) | null {
    if (this.busy.has(kind)) return null;
    this.busy.add(kind);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(kind);
    };
  }

  isRunning(kind: SyncKind): boolean {
    return this.busy.has(kind);
  }
}
