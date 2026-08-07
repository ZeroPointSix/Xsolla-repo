import { inspectRepository } from "./git.js";
import { reviewRequestSchema, type ReviewRequest } from "./schema.js";
import type { ReviewExecutionOptions, ReviewResult, ValidationStatus } from "./types.js";
import { runValidations } from "./validation.js";

function countStatus(result: ReviewResult, status: ValidationStatus): number {
  return result.validationResults.filter((validation) => validation.status === status).length;
}

export async function reviewRepository(
  request: ReviewRequest,
  options: ReviewExecutionOptions = {},
): Promise<ReviewResult> {
  const input = reviewRequestSchema.parse(request);
  const repository = inspectRepository(input.repositoryPath, input.baseRef);
  const validationResults = await runValidations(
    input.validationCommands,
    repository.path,
    {
      timeoutMs: options.validationTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    },
  );

  const result: ReviewResult = {
    repository: {
      name: repository.name,
      path: repository.path,
      baseRef: repository.baseRef,
    },
    changedFiles: repository.changedFiles,
    validationResults,
    summary: {
      changedFiles: repository.changedFiles.length,
      validations: validationResults.length,
      passed: 0,
      failed: 0,
      timedOut: 0,
      errors: 0,
    },
  };

  result.summary.passed = countStatus(result, "passed");
  result.summary.failed = countStatus(result, "failed");
  result.summary.timedOut = countStatus(result, "timeout");
  result.summary.errors = countStatus(result, "error");
  return result;
}
