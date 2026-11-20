import { Loader2Icon } from "lucide-react";

import { useElementsCopy } from "../../copy/elements-copy.js";
import { cn } from "../../lib/utils.js";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const t = useElementsCopy();
  return (
    <Loader2Icon
      role="status"
      aria-label={t("elements.loading.label")}
      className={cn(
        "size-4 animate-spin motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
