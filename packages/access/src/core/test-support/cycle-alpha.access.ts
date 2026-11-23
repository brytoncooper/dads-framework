import { resource, type DslResource, type ResourceSubjectRef } from "../../index.js";
import { beta } from "./cycle-beta.access.js";

export type AlphaResource = DslResource<"test/alpha", { readonly peer: ResourceSubjectRef<"test/beta"> }, "view">;

export const alpha: AlphaResource = resource("test/alpha", {
  roles: {
    peer: () => beta,
  },
  can: ({ peer }) => ({
    view: peer.view,
  }),
});
