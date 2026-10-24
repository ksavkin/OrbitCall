export function LogoMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="5.2" fill="white" />
      <ellipse cx="12" cy="12" rx="10.4" ry="4.1" transform="rotate(-28 12 12)" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" />
      <circle cx="20.6" cy="7.2" r="1.6" fill="white" />
    </svg>
  );
}
