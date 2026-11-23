import { resource, type DslResource, type ResourceSubjectRef } from "../../index.js";
import { alpha } from "./cycle-alpha.access.js";

export type BetaResource = DslResource<"test/beta", { readonly peer: ResourceSubjectRef<"test/alpha"> }, "view">;

export const beta: BetaResource = resource("test/beta", {
  roles: {
    peer: () => alpha,
  },
  can: ({ peer }) => ({
    view: peer.view,
  }),
});
