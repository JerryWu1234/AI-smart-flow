import type { ReviewResult, TaskReview } from "@smartflow/protocol";

function mergeTaskReviews(converge: TaskReview, adversarial: TaskReview): TaskReview {
  const issues = [...new Map(
    [...converge.issues, ...adversarial.issues].map((issue) => [
      `${issue.path}\u0000${issue.message}`,
      issue
    ] as const)
  ).values()];
  return {
    id: converge.id,
    completionPercentage: Math.min(
      converge.completionPercentage,
      adversarial.completionPercentage
    ),
    issues
  };
}

export function combineReviewStageResults(
  converge: ReviewResult,
  adversarial: ReviewResult
): ReviewResult {
  const adversarialTasks = new Map(adversarial.tasks.map((task) => [task.id, task] as const));
  if (
    converge.tasks.length !== adversarial.tasks.length ||
    converge.tasks.some((task) => !adversarialTasks.has(task.id))
  ) {
    throw new Error("REVIEW_STAGE_TASK_COVERAGE_MISMATCH");
  }
  return {
    tasks: converge.tasks.map((task) => {
      const adversarialTask = adversarialTasks.get(task.id);
      if (adversarialTask === undefined) throw new Error("REVIEW_STAGE_TASK_COVERAGE_MISMATCH");
      return mergeTaskReviews(task, adversarialTask);
    })
  };
}
