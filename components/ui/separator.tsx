import * as React from "react"
import { cn } from "@/lib/utils"

function Separator({ className, ...props }: React.ComponentProps<"hr">) {
  return (
    <hr
      data-slot="separator"
      className={cn("w-full border-0 border-t border-border", className)}
      {...props}
    />
  )
}
export { Separator }
