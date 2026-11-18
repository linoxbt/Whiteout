export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="wo-peak" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#8fd8ff" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="#0b1017" stroke="rgba(255,255,255,0.14)" />
      <path d="M5 24 13.5 9.5l4.2 6.4 3.1-4.1L27 24z" fill="url(#wo-peak)" />
      <path d="m13.5 9.5-2.6 4.6 2.6-1.4 1.6 2z" fill="#0b1017" opacity="0.35" />
      <circle cx="22.5" cy="8" r="1.6" fill="#ffcf5c" />
    </svg>
  );
}
