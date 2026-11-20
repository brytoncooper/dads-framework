import * as React from "react";

export type RemoteComboboxHandle = {
  readonly prefetchNext: () => void;
};

export const RemoteComboboxContext =
  React.createContext<RemoteComboboxHandle | null>(null);
