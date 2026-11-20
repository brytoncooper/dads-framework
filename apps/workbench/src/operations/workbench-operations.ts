import { artifactAndActivityOperations } from "./artifacts-and-activity.js";
import { memberOperations } from "./members.js";
import {
  OperationCoordinator,
  type OperationDependencies,
} from "./operation-coordinator.js";
import { taskOperations } from "./tasks.js";
import { workspaceOperations } from "./workspaces.js";

export function createWorkbenchOperations(dependencies: OperationDependencies) {
  const coordinator = new OperationCoordinator(dependencies);
  return {
    ...workspaceOperations(coordinator),
    ...taskOperations(coordinator),
    ...memberOperations(coordinator),
    ...artifactAndActivityOperations(coordinator),
    synchronize: () => coordinator.synchronize(),
  };
}

export type WorkbenchOperations = ReturnType<typeof createWorkbenchOperations>;
