import { changedFiles } from "./git.js";
import { markdownReport } from "./report.js";
import type { ReviewRequest } from "./types.js";
import {
  CLI_VALIDATION_DEFAULTS,
  runValidations,
  type ValidationOptions,
} from "./validation.js";

export async function reviewRepository(
  request: ReviewRequest,
  validationOptions: ValidationOptions = CLI_VALIDATION_DEFAULTS,
): Promise<string> {
  const files = changedFiles(request.repositoryPath, request.baseRef);
  const validations = await runValidations(
    request.validationCommands ?? [],
    request.repositoryPath,
    validationOptions,
  );
  return markdownReport({
    repositoryPath: request.repositoryPath,
    changedFiles: files,
    validationResults: validations,
  });
}