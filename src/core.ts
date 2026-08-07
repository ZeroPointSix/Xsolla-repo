import { changedFiles } from "./git.js";
import type { ReviewRequest, ReviewResult } from "./types.js";
import {
  CLI_VALIDATION_DEFAULTS,
  runValidations,
  type ValidationOptions,
} from "./validation.js";

export async function reviewRepository(
  request: ReviewRequest,
  validationOptions: ValidationOptions = CLI_VALIDATION_DEFAULTS,
): Promise<ReviewResult> {
  const changedFilesResult = changedFiles(request.repositoryPath, request.baseRef);
  const validationResults = await runValidations(
    request.validationCommands ?? [],
    request.repositoryPath,
    validationOptions,
  );
  return {
    repositoryPath: request.repositoryPath,
    changedFiles: changedFilesResult,
    validationResults,
  };
}