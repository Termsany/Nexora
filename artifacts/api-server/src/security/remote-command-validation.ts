import { z } from "zod";

export const commandSchema = z.object({
  device_id: z.string().uuid(),
  shell: z.enum(["CMD", "POWERSHELL"]),
  command: z.string().min(1).max(64 * 1024).refine(value => value.trim().length > 0),
  timeout_seconds: z.coerce.number().int().min(1).max(900).default(60),
  reason: z.string().trim().min(1).max(1000),
  working_directory: z.string().max(260).optional(),
});
