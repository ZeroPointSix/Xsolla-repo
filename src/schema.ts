import { z } from "zod";

export const reviewRequestSchema = z
  .object({
    repositoryPath: z.string().trim().min(1),
    baseRef: z.string().trim().min(1).optional(),
    validationCommands: z.array(z.string().trim().min(1)).max(20).default([]),
  })
  .strict();

export type ReviewRequest = z.input<typeof reviewRequestSchema>;
export type NormalizedReviewRequest = z.output<typeof reviewRequestSchema>;

