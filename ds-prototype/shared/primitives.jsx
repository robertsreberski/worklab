// Shared primitives: avatars, status pills, icons, live log ticker

function AgentAvatar({ slug, size = 18, title }) {
  const a = agentBySlug[slug];
  if (!a) return (
    <span title="Unassigned" style={{
      width: size, height: size, borderRadius: '50%',
      border: '1px dashed var(--border-strong)', color: 'var(--muted-2)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.55, fontWeight: 700, flex: '0 0 auto'
    }}>?</span>
  );
  return (
    <span title={title || `${a.name} · ${a.role}`} style={{
      width: size, height: size, borderRadius: '50%',
      background: `linear-gradient(135deg, ${a.color}, ${a.color}cc)`,
      color: 'var(--accent-ink)', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.52, fontWeight: 800, flex: '0 0 auto',
      boxShadow: a.role === 'reviewer' ? `0 0 0 1.5px rgba(245,242,235,0.15), 0 0 0 3px ${a.color}22` : 'none',
      fontFamily: 'var(--sans)',
    }}>{a.avatar}</span>
  );
}

function StatusPill({ status, size = 'md' }) {
  const s = statusById[status];
  const h = size === 'sm' ? 20 : 24;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: h, padding: '0 9px',
      borderRadius: 999,
      background: `color-mix(in oklch, ${s.color} 12%, transparent)`,
      color: s.color, border: `1px solid color-mix(in oklch, ${s.color} 30%, transparent)`,
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 700, letterSpacing: 0.1,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 9, lineHeight: 1 }}>{s.icon}</span>
      {s.label}
    </span>
  );
}

function PriorityChip({ p }) {
  if (!p) return null;
  const color = p === 1 ? 'var(--red)' : p === 2 ? 'var(--yellow)' : 'var(--muted)';
  return <span style={{
    fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
    color, letterSpacing: 0.5,
  }}>P{p}</span>;
}

// Animated dot that pulses while running
function LivePulse({ color = 'var(--yellow)', size = 7 }) {
  return (
    <span style={{ position: 'relative', width: size, height: size, display: 'inline-block', flex: '0 0 auto' }}>
      <span style={{
        position: 'absolute', inset: 0, background: color, borderRadius: '50%',
        animation: 'wl-pulse 1.6s ease-out infinite',
      }} />
      <span style={{
        position: 'absolute', inset: 0, background: color, borderRadius: '50%',
      }} />
    </span>
  );
}

// Inject shared keyframes once
if (typeof document !== 'undefined' && !document.getElementById('wl-shared-styles')) {
  const s = document.createElement('style');
  s.id = 'wl-shared-styles';
  s.textContent = `
    @keyframes wl-pulse {
      0% { transform: scale(1); opacity: 0.85; }
      70% { transform: scale(2.6); opacity: 0; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    @keyframes wl-tick-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes wl-shimmer {
      from { background-position: -200% 0; }
      to { background-position: 200% 0; }
    }
    @keyframes wl-caret {
      50% { opacity: 0; }
    }
    @keyframes wl-conveyor {
      from { transform: translateX(0); }
      to { transform: translateX(-32px); }
    }
    @keyframes wl-float-in {
      from { opacity: 0; transform: translateY(6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .wl-hide-scrollbar::-webkit-scrollbar { display: none; }
    .wl-hide-scrollbar { scrollbar-width: none; }
  `;
  document.head.appendChild(s);
}

// Simple chevron/icon system
function Ic({ name, size = 14, color = 'currentColor' }) {
  const paths = {
    'search': 'M11 4a7 7 0 1 0 4.2 12.6l3.1 3.1 1.4-1.4-3.1-3.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
    'plus': 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z',
    'cmd': 'M6 4a3 3 0 0 0 0 6h2V6a2 2 0 0 1 2-2v2h4V4a2 2 0 0 1 2 2v2h2a3 3 0 1 0-3-3h-2V3h-4v2H8V3A3 3 0 0 0 6 4Zm0 5a1 1 0 1 1 0-2h1v2H6Zm12 0h-1V7h1a1 1 0 1 1 0 2Z',
    'filter': 'M3 5h18v2l-7 8v5l-4-2v-3L3 7V5Z',
    'clock': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm1-13h-2v6l5 3 1-1.7-4-2.3V7Z',
    'zap': 'M13 2L4 14h7l-1 8 9-12h-7l1-8Z',
    'check': 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
    'x': 'M6 6l12 12M18 6 6 18',
    'arrow-right': 'M5 12h14M13 5l7 7-7 7',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-right': 'M9 18l6-6-6-6',
    'dot-grid': 'M4 4h2v2H4zM10 4h2v2h-2zM16 4h2v2h-2zM4 10h2v2H4zM10 10h2v2h-2zM16 10h2v2h-2zM4 16h2v2H4zM10 16h2v2h-2zM16 16h2v2h-2z',
    'terminal': 'M3 4h18v16H3V4Zm2 2v12h14V6H5Zm2 3 3 3-3 3 1 1 4-4-4-4-1 1Zm6 5h5v1h-5v-1Z',
    'spark': 'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2Z',
    'hand': 'M8 2a1.5 1.5 0 0 1 3 0v7h1V1a1.5 1.5 0 0 1 3 0v8h1V2a1.5 1.5 0 0 1 3 0v11a8 8 0 0 1-16 0V6a1.5 1.5 0 0 1 3 0v7h1V2Z',
    'git-branch': 'M6 3a2 2 0 1 0-1 3.7v10.6a2 2 0 1 0 2 0V12h5a4 4 0 0 0 4-4V6.3A2 2 0 1 0 14 6v2a2 2 0 0 1-2 2H7V6.7A2 2 0 0 0 6 3Z',
    'retry': 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z',
    'warn': 'M12 2 1 21h22L12 2Zm0 6 7.5 13h-15L12 8Zm-1 5v3h2v-3h-2Zm0 4v2h2v-2h-2Z',
    'book': 'M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3V3Zm2 2v12a1 1 0 0 0 1 1h9V6a1 1 0 0 0-1-1H7Zm2 3h7v2H9V8Zm0 4h7v2H9v-2Z',
    'database': 'M12 3c4.5 0 8 1.3 8 3s-3.5 3-8 3-8-1.3-8-3 3.5-3 8-3Zm8 6c0 1.7-3.5 3-8 3s-8-1.3-8-3v3c0 1.7 3.5 3 8 3s8-1.3 8-3V9Zm0 6c0 1.7-3.5 3-8 3s-8-1.3-8-3v3c0 1.7 3.5 3 8 3s8-1.3 8-3v-3Z',
    'users': 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 2c-3 0-8 1.5-8 4.5V20h16v-2.5C17 14.5 12 13 9 13Zm8 0c-.8 0-1.7.1-2.6.3 1.6.9 2.6 2.3 2.6 4.2V20h6v-1.8c0-2.6-4-5.2-6-5.2Z',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d={paths[name] || paths['dot-grid']} fill={color} />
    </svg>
  );
}

// LiveTicker: animates through a sequence of events one at a time,
// so the UI feels cinematic even from static data.
function useLiveTicker(events, { intervalMs = 1800, running = true } = {}) {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    if (!running || !events || events.length === 0) return;
    const t = setInterval(() => setIdx(i => (i + 1) % events.length), intervalMs);
    return () => clearInterval(t);
  }, [events, intervalMs, running]);
  if (!events || events.length === 0) return null;
  return events[idx % events.length];
}

// Small shimmer bar used for live streaming indicator
function ShimmerBar({ height = 2 }) {
  return (
    <div style={{
      height,
      background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
      backgroundSize: '200% 100%',
      animation: 'wl-shimmer 1.6s linear infinite',
      borderRadius: height,
    }} />
  );
}

// Tool-call token: "read_file src/auth/refreshToken.ts"
function ToolToken({ event, compact = false }) {
  if (!event) return null;
  if (event.kind === 'think') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        color: 'var(--muted)', fontStyle: 'italic', fontSize: compact ? 11 : 12,
        fontFamily: 'var(--sans)',
      }}>
        <span style={{ color: 'var(--purple)' }}>✦</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.text}</span>
      </span>
    );
  }
  if (event.kind === 'handoff') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        color: 'var(--accent-strong)', fontSize: compact ? 11 : 12,
      }}>
        <Ic name="arrow-right" size={11} />
        <span>{event.text}</span>
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6,
      fontFamily: 'var(--mono)', fontSize: compact ? 11 : 12,
      color: 'var(--text-soft)',
    }}>
      <span style={{ color: 'var(--accent)' }}>{event.name}</span>
      <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: compact ? 180 : 320 }}>
        {event.arg}{event.detail ? ` · ${event.detail}` : ''}
      </span>
    </span>
  );
}

Object.assign(window, {
  AgentAvatar, StatusPill, PriorityChip, LivePulse, Ic, useLiveTicker, ShimmerBar, ToolToken,
});
