export function PairIllustration() {
  return (
    <svg
      viewBox="0 0 200 100"
      fill="none"
      className="mx-auto mb-6 h-24 w-48 text-foreground/65"
      aria-hidden="true"
    >
      <rect
        x="16"
        y="20"
        width="64"
        height="54"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M16 32h64M34 81h28M48 74v7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="23" cy="26" r="1.5" className="fill-primary" />
      <circle cx="29" cy="26" r="1.5" fill="currentColor" opacity=".3" />
      <rect
        x="139"
        y="14"
        width="38"
        height="70"
        rx="6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M150 20h16M153 77h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M87 48h43"
        className="stroke-primary"
        strokeWidth="1.5"
        strokeDasharray="3 5"
      />
      <path
        d="m124 43 6 5-6 5"
        className="stroke-primary"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M41 49h14M151 47h14M41 55h9M151 53h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".45"
      />
      <path d="M24 91h152" stroke="currentColor" opacity=".1" />
    </svg>
  )
}
