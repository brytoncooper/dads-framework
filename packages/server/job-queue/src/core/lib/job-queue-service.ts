import { defineService } from "@dads-framework/core/plugin";

import type { JobQueue } from "./job-queue.js";

/** Narrow capability token for registering, enqueuing, and inspecting background jobs. */
export const jobQueueService = defineService("job-queue").ofType<JobQueue>();
