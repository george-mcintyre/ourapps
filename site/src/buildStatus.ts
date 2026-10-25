import { api, type BuildStatus, type TestflightStatus } from "./api.js";
import { html, type Raw } from "./html.js";
import { fmtDate, pill } from "./ui.js";

const labels: Record<BuildStatus["state"], [string, "" | "ok" | "warn" | "bad" | "accent"]> = {
  "not-started": ["Not requested", ""], requested: ["Requested", "accent"], pending: ["Pending", "accent"],
  running: ["Running", "accent"], complete: ["Complete", "ok"], failed: ["Failed", "bad"],
  cancelled: ["Cancelled", "warn"], unavailable: ["Status unavailable", "warn"],
};

const duration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)} seconds` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sec`;

export function buildStatusCard(status: BuildStatus | undefined): Raw {
  if (!status) return html``;
  const [label, tone] = status.state === "complete" && !status.uploadReceived ? ["Finished without upload", "warn"] as const : labels[status.state];
  return html`<section class="card mt-s"><div class="row wrap"><h3 class="grow">GitHub build</h3>${pill(label, tone, true)}</div>
    ${status.workflowName ? html`<p class="small">${status.workflowName}${status.runNumber === null ? "" : ` · run ${status.runNumber}`}${status.runAttempt && status.runAttempt > 1 ? ` · attempt ${status.runAttempt}` : ""}</p>` : ""}
    ${status.requestedAt ? html`<p class="small muted">Requested ${fmtDate(status.requestedAt, true)}.</p>` : ""}
    ${status.state === "pending" ? html`<p class="small">GitHub has queued the run or is waiting for approval or a runner.</p>` : ""}
    ${status.state === "running" ? html`<p class="small">Elapsed: ${status.elapsedSeconds === null ? "not reported" : duration(status.elapsedSeconds)}.</p>
      ${status.expectedSeconds !== null && status.progressPercent !== null ? html`<p class="small">Estimated progress: ${status.progressPercent}%. Typical total ${duration(status.expectedSeconds)}, based on ${status.estimateSampleCount} successful run${status.estimateSampleCount === 1 ? "" : "s"}.</p><progress max="100" value="${status.progressPercent}" aria-label="Estimated build progress" style="width:100%"></progress><p class="tiny faint">Time-based estimate, not GitHub's measured build progress. It stays below 100% until the run finishes.</p>` : html`<p class="small muted">No successful-run timing estimate is available.</p>`}` : ""}
    ${status.state === "complete" ? status.uploadReceived
      ? html`<p class="small">The workflow finished successfully and ourapps has received a matching upload.</p>`
      : html`<p class="small">The workflow finished, but no matching upload has reached ourapps. Open its GitHub run to check the export and upload steps.</p>` : ""}
    ${status.state === "failed" || status.state === "cancelled" ? html`<p class="small">${status.state === "cancelled" ? "The workflow was cancelled." : "The workflow did not finish successfully."}${status.conclusion ? ` GitHub reports: ${status.conclusion.replace(/_/g, " ")}.` : ""}</p>` : ""}
    ${status.correlation !== "none" && !status.platformVerified ? html`<p class="tiny faint">Repository workflow status; its app/platform inputs are not confirmed by GitHub's run listing. ${status.correlation === "request-time" ? "Matched by request time." : status.correlation === "build-number" ? "Matched by the uploaded build number." : "Showing the selected repository workflow."}</p>` : ""}
    ${status.correlation === "platform-title" ? html`<p class="tiny faint">Platform identified by the workflow title; the app/request match is approximate.</p>` : ""}
    ${status.message && (status.state === "unavailable" || status.correlation === "none") ? html`<p class="small muted">${status.message}</p>` : ""}
    ${status.state === "unavailable" ? html`<p class="small"><a href="/dev/guide#github-token">GitHub token setup</a>: status needs <b>Actions: read</b>. iPhone/iPad build requests need <b>Contents: write</b>; Mac/Apple TV requests need <b>Actions: write</b> and private-release <b>Contents: read</b>.</p>` : ""}
    ${status.runUrl ? html`<a class="btn sm secondary" href="${status.runUrl}" target="_blank" rel="noopener">Open GitHub run</a>` : ""}
    <p class="tiny faint">Checked ${fmtDate(status.checkedAt, true)}. Refreshes every 30 seconds while this page is visible.</p>
  </section>`;
}

// Refresh the build panel without replacing a form the developer may be editing.
export function watchBuildStatus(box: HTMLElement, path: string, onStatus?: (status: TestflightStatus) => void): void {
  let busy = false;
  let checkedAt = 0;
  const refresh = async () => {
    if (!box.isConnected) return stop();
    if (document.visibilityState !== "visible" || busy || Date.now() - checkedAt < 5000) return;
    busy = true;
    checkedAt = Date.now();
    try {
      const status = await api<TestflightStatus>("GET", path);
      if (box.isConnected) onStatus?.(status);
      const panel = box.querySelector<HTMLElement>("[data-github-status]");
      if (panel && box.isConnected) panel.innerHTML = buildStatusCard(status.buildStatus).html;
    } catch {
      const panel = box.querySelector<HTMLElement>("[data-github-status]");
      if (panel && box.isConnected) panel.innerHTML = html`<p class="small muted">Build status could not be refreshed. The next check retries.</p>`.html;
    } finally { busy = false; }
  };
  const timer = window.setInterval(() => void refresh(), 30_000);
  const stop = () => {
    clearInterval(timer);
    removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    removeEventListener("navigate", stop);
    removeEventListener("popstate", stop);
  };
  addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  addEventListener("navigate", stop, { once: true });
  addEventListener("popstate", stop, { once: true });
}
