import {
  claimActionOutputSchema,
  renewActionClaimOutputSchema,
  resumeOutputSchema,
  resultOutputSchema,
  reviewResultSubmitOutputSchema,
  statusOutputSchema,
  submitLeaderDecisionOutputSchema,
  waitOutputSchema,
  type ResultOutput,
  type ReviewSubmission
} from "@smartflow/protocol";

import type { HostGateway } from "./approval.js";
import {
  reviewerSessionIdFromOutput,
  validateHostReviewOutput,
  type HostReviewCallbackOutput,
  type HostReviewContext,
  type HostReviewOutput
} from "./reviewer.js";

export type ReviewActionResult = HostReviewCallbackOutput;
export type ReviewActionContext = HostReviewContext;

export interface RepairLimitContext {
  projectId: string;
  jobId: string;
  revision: number;
  repairRounds: 15;
  result: ReviewSubmission;
}

export interface HostActionCallbacks {
  review?(context: ReviewActionContext): Promise<ReviewActionResult>;
  continueAfterRepairLimit?(context: RepairLimitContext): Promise<boolean>;
}

export interface ActionLoopInput {
  projectId: string;
  jobId: string;
  expectedRevision: number;
  expectedStateVersion: number;
  hostTurnId: string;
  requestId: string;
}

export interface RunLoopInput {
  projectId: string;
  jobId: string;
  hostTurnId: string;
  requestId: string;
}

const REVIEW_RETRY_LIMIT = 3;
const REPAIR_ROUND_LIMIT = 15;

export class HostActionLoop {
  private readonly gateway: HostGateway;
  private readonly callbacks: HostActionCallbacks;

  public constructor(gateway: HostGateway, callbacks: HostActionCallbacks) {
    this.gateway = gateway;
    this.callbacks = callbacks;
  }

  public async runToCompletion(input: RunLoopInput): Promise<ResultOutput> {
    let repairRounds = 0;
    let requestSequence = 0;
    const requestId = (scope: string): string => {
      requestSequence += 1;
      return `${input.requestId}:${scope}:${String(requestSequence)}`;
    };
    for (;;) {
      const status = statusOutputSchema.parse(
        await this.gateway.call("smartflow_status", {
          projectId: input.projectId,
          jobId: input.jobId
        })
      );
      if (new Set(["COMPLETED", "CANCELED", "FAILED"]).has(status.phase)) {
        return resultOutputSchema.parse(await this.gateway.call("smartflow_result", {
          projectId: input.projectId,
          jobId: input.jobId
        }));
      }
      if (status.phase === "PAUSED") {
        if (status.pause?.code === "REPAIR_TASKS_READY") {
          await this.pollOnce({
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: status.revision,
            expectedStateVersion: status.stateVersion,
            hostTurnId: input.hostTurnId,
            requestId: requestId("repair-revision")
          });
          continue;
        }
        return resultOutputSchema.parse(await this.gateway.call("smartflow_result", {
          projectId: input.projectId,
          jobId: input.jobId
        }));
      }
      if (status.phase === "REVIEW_PENDING") {
        const reviewResponse = await this.pollOnce({
          projectId: input.projectId,
          jobId: input.jobId,
          expectedRevision: status.revision,
          expectedStateVersion: status.stateVersion,
          hostTurnId: input.hostTurnId,
          requestId: requestId("review")
        });
        const review = reviewResultSubmitOutputSchema.safeParse(reviewResponse);
        if (!review.success) continue;
        const blockingFindings = [...new Map([
          ...review.data.result.convergeFindings,
          ...review.data.result.adversarialFindings
        ].filter((finding) => finding.blocking).map((finding) => [
          finding.fingerprint,
          finding
        ])).values()];
        const fullyCovered = status.pendingAction?.changedPaths.every(
          (path) => review.data.result.pathCoverage[path] === "FULL"
        ) ?? false;
        const complete =
          review.data.result.verdict === "APPROVE" &&
          review.data.result.completionPercentage === 100 &&
          blockingFindings.length === 0 &&
          fullyCovered;
        if (complete) {
          await this.gateway.call("smartflow_submit_leader_decision", {
            requestId: requestId("accept"),
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: review.data.revision,
            expectedStateVersion: review.data.stateVersion,
            reviewHash: review.data.reviewHash,
            decision: "accept",
            repairItems: [],
            reason: "Reviewer confirmed every approved task is 100% complete"
          });
          continue;
        }
        if (blockingFindings.length === 0) {
          await this.gateway.call("smartflow_submit_leader_decision", {
            requestId: requestId("pause-invalid-review"),
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: review.data.revision,
            expectedStateVersion: review.data.stateVersion,
            reviewHash: review.data.reviewHash,
            decision: "pause",
            repairItems: [],
            reason: "Reviewer did not provide actionable incomplete-task guidance"
          });
          continue;
        }
        let expectedStateVersion = review.data.stateVersion;
        if (repairRounds === REPAIR_ROUND_LIMIT) {
          const paused = submitLeaderDecisionOutputSchema.parse(
            await this.gateway.call("smartflow_submit_leader_decision", {
              requestId: requestId("pause-repair-limit"),
              projectId: input.projectId,
              jobId: input.jobId,
              expectedRevision: review.data.revision,
              expectedStateVersion,
              reviewHash: review.data.reviewHash,
              decision: "pause",
              repairItems: [],
              reason: "Automatic repair limit reached"
            })
          );
          const shouldContinue = await this.callbacks.continueAfterRepairLimit?.({
            projectId: input.projectId,
            jobId: input.jobId,
            revision: review.data.revision,
            repairRounds: REPAIR_ROUND_LIMIT,
            result: review.data.result
          }) ?? false;
          if (!shouldContinue) {
            return resultOutputSchema.parse(await this.gateway.call("smartflow_result", {
              projectId: input.projectId,
              jobId: input.jobId
            }));
          }
          const resumed = resumeOutputSchema.parse(await this.gateway.call("smartflow_resume", {
            requestId: requestId("continue-repairs"),
            projectId: input.projectId,
            jobId: input.jobId,
            expectedRevision: paused.revision,
            expectedStateVersion: paused.stateVersion,
            resumeAction: "resume_review_decision"
          }));
          expectedStateVersion = resumed.stateVersion;
          repairRounds = 0;
        }
        await this.gateway.call("smartflow_submit_leader_decision", {
          requestId: requestId("repair"),
          projectId: input.projectId,
          jobId: input.jobId,
          expectedRevision: review.data.revision,
          expectedStateVersion,
          reviewHash: review.data.reviewHash,
          decision: "repair",
          repairItems: blockingFindings.map((finding) => ({
            source: "reviewer",
            findingFingerprint: finding.fingerprint
          })),
          reason: "Reviewer reported incomplete approved tasks"
        });
        repairRounds += 1;
        continue;
      }
      if (status.phase === "LEADER_DECISION" || status.phase === "REVIEWING") {
        return resultOutputSchema.parse(await this.gateway.call("smartflow_result", {
          projectId: input.projectId,
          jobId: input.jobId
        }));
      }
      const waited = waitOutputSchema.parse(await this.gateway.call("smartflow_wait", {
        projectId: input.projectId,
        jobId: input.jobId,
        afterStateVersion: status.stateVersion,
        timeoutMs: 30_000
      }));
      if (!waited.changed) continue;
    }
  }

  public async pollOnce(input: ActionLoopInput): Promise<unknown> {
    const status = statusOutputSchema.parse(
      await this.gateway.call("smartflow_status", {
        projectId: input.projectId,
        jobId: input.jobId
      })
    );
    const action = status.pendingAction;
    if (action === undefined) {
      if (
        status.pause?.code === "REPAIR_TASKS_READY"
      ) {
        const result = resultOutputSchema.parse(await this.gateway.call("smartflow_result", {
          projectId: input.projectId,
          jobId: input.jobId
        }));
        const draft = result.repairDraft;
        if (draft === undefined || draft.approval.kind !== "LEADER_REPAIR") return result;
        return this.gateway.call("smartflow_resume", {
          requestId: `${input.requestId}:repair-revision`,
          projectId: input.projectId,
          jobId: input.jobId,
          expectedRevision: input.expectedRevision,
          expectedStateVersion: status.stateVersion,
          resumeAction: "approve_new_manifest_revision",
          approval: draft.approval
        });
      }
      return status;
    }
    const claim = claimActionOutputSchema.parse(
      await this.gateway.call("smartflow_claim_action", {
        requestId: input.requestId,
        projectId: input.projectId,
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        expectedStateVersion: input.expectedStateVersion,
        actionId: action.actionId,
        hostTurnId: input.hostTurnId
      })
    );
    const reviewRequest = {
      requestId: `${input.requestId}:review`,
      projectId: input.projectId,
      jobId: input.jobId,
      expectedRevision: input.expectedRevision,
      claimId: claim.claimId
    };
    if (this.callbacks.review === undefined) {
      return this.gateway.call("smartflow_submit_review", {
        ...reviewRequest,
        expectedStateVersion: claim.stateVersion,
        hostUnavailableReason: "HOST_REVIEW_UNAVAILABLE:review callback missing"
      });
    }
    const context: ReviewActionContext = {
      reviewAttemptId: claim.action.reviewAttemptId,
      taskSource: { ...claim.action.taskSource },
      approvedSourceHash: claim.action.approvedSourceHash,
      reviewBundle: { ...claim.action.reviewBundle },
      changedPaths: [...claim.action.changedPaths],
      reviewerSession: { ...claim.action.reviewerSession },
      piSessionId: claim.action.piSessionId,
      reviewBundleHash: claim.action.reviewBundleHash
    };
    let stateVersion = claim.stateVersion;
    let renewalSequence = 0;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalInFlight: Promise<void> | undefined;
    let renewalFailure: unknown;
    let stopped = false;
    const scheduleRenewal = (): void => {
      renewalTimer = setTimeout(() => {
        renewalTimer = undefined;
        renewalSequence += 1;
        renewalInFlight = (async (): Promise<void> => {
          const renewal = renewActionClaimOutputSchema.parse(
            await this.gateway.call("smartflow_renew_action_claim", {
              requestId: `${input.requestId}:review-renew:${String(renewalSequence)}`,
              projectId: input.projectId,
              jobId: input.jobId,
              expectedRevision: input.expectedRevision,
              expectedStateVersion: stateVersion,
              actionId: claim.action.actionId,
              claimId: claim.claimId,
              hostTurnId: input.hostTurnId
            })
          );
          stateVersion = renewal.stateVersion;
        })().then(
          () => {
            if (!stopped) scheduleRenewal();
          },
          (error: unknown) => {
            renewalFailure = error;
          }
        );
      }, 60_000);
    };
    scheduleRenewal();
    let output: HostReviewOutput | undefined;
    let reviewFailure: string | undefined;
    try {
      let retryContext = context;
      for (let attempt = 1; attempt <= REVIEW_RETRY_LIMIT; attempt += 1) {
        try {
          const candidate = await this.callbacks.review(retryContext);
          const reviewerSessionId = reviewerSessionIdFromOutput(candidate);
          if (
            reviewerSessionId !== undefined &&
            retryContext.reviewerSession.mode === "CREATE" &&
            reviewerSessionId !== retryContext.piSessionId
          ) {
            retryContext = {
              ...retryContext,
              reviewerSession: { mode: "RESUME", reviewerSessionId }
            };
          }
          output = validateHostReviewOutput(retryContext, candidate);
          reviewFailure = undefined;
          break;
        } catch (error) {
          reviewFailure = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      reviewFailure = error instanceof Error ? error.message : String(error);
    } finally {
      stopped = true;
      if (renewalTimer !== undefined) clearTimeout(renewalTimer);
      await renewalInFlight;
    }
    if (renewalFailure !== undefined) {
      throw renewalFailure instanceof Error
        ? renewalFailure
        : new Error("REVIEW_CLAIM_RENEWAL_FAILED");
    }
    if (reviewFailure !== undefined) {
      return this.gateway.call("smartflow_submit_review", {
        ...reviewRequest,
        expectedStateVersion: stateVersion,
        hostUnavailableReason: reviewFailure.startsWith("HOST_REVIEW_UNAVAILABLE")
          ? reviewFailure
          : `HOST_REVIEW_UNAVAILABLE:${reviewFailure}`
      });
    }
    if (output === undefined) throw new Error("HOST_REVIEW_INVALID_OUTPUT");
    return this.gateway.call("smartflow_submit_review", {
      ...reviewRequest,
      expectedStateVersion: stateVersion,
      reviewAttemptId: context.reviewAttemptId,
      reviewBundleHash: context.reviewBundleHash,
      reviewerSessionId: output.reviewerSessionId,
      result: output.result
    });
  }
}
