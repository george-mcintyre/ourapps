import { describe, expect, it } from "vitest";
import type { BuildStatus } from "./api.js";
import { buildStatusCard } from "./buildStatus.js";

const status: BuildStatus = {
  state: "running", checkedAt: "2026-10-25T03:00:00Z", requestedAt: null, reason: null, message: null,
  workflowName: "release", runUrl: "https://github.com/example/app/actions/runs/1", runId: 1,
  runNumber: 12, runAttempt: 1, conclusion: null, correlation: "request-time", platformVerified: false, uploadReceived: false,
  startedAt: "2026-10-25T02:55:00Z", elapsedSeconds: 300, expectedSeconds: 600,
  estimateSampleCount: 4, estimateSource: "median-successful-job-completion", progressPercent: 50,
};

describe("GitHub status panel", () => {
  it("labels timing as an estimate and preserves the correlation limit", () => {
    const card = buildStatusCard(status).html;
    expect(card).toContain("Estimated progress: 50%");
    expect(card).toContain("based on 4 successful runs");
    expect(card).toContain('value="50"');
    expect(card).toContain("inputs are not confirmed");
    expect(card).toContain('href="https://github.com/example/app/actions/runs/1"');
  });

  it("does not invent timing without successful samples", () => {
    const card = buildStatusCard({ ...status, expectedSeconds: null, progressPercent: null, estimateSampleCount: 0 }).html;
    expect(card).toContain("No successful-run timing estimate");
    expect(card).not.toContain("<progress");
  });

  it("requires matching upload evidence before showing a completed build", () => {
    const missing = buildStatusCard({ ...status, state: "complete", conclusion: "success" }).html;
    expect(missing).toContain("Finished without upload");
    expect(missing).toContain("no matching upload has reached ourapps");
    const card = buildStatusCard({ ...status, state: "complete", conclusion: "success", uploadReceived: true }).html;
    expect(card).toContain("Complete");
    expect(card).toContain("ourapps has received a matching upload");
    expect(card).not.toContain("Apple processing, review and installation availability are separate");
  });

  it("shows permission guidance and failed/cancelled outcomes", () => {
    expect(buildStatusCard({ ...status, state: "unavailable" }).html).toContain("Actions: read");
    expect(buildStatusCard({ ...status, state: "failed", conclusion: "failure" }).html).toContain("did not finish successfully");
    expect(buildStatusCard({ ...status, state: "cancelled" }).html).toContain("workflow was cancelled");
  });
});
