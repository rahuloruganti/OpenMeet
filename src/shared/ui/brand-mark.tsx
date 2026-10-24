/** The OpenMeet mark: an open ring (the O of Open) around a record dot. Decorative only. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="32"
        cy="32"
        r="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray="116.2 22"
        transform="rotate(-50 32 32)"
      />
      <circle cx="32" cy="32" r="9" fill="var(--brand-dot)" />
    </svg>
  );
}
