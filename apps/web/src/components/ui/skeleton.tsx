import { cn } from "cn"

/** Placeholder bar with a slow light sweep; still under reduced motion. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton-shimmer rounded-sm", className)}
      {...props}
    />
  )
}

export { Skeleton }
