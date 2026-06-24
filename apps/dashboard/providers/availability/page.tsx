import React, { useState, useMemo } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

type TimeRange = '7d' | '30d' | '90d';

interface AvailabilitySlot {
  label: string;
  availability: number; // 0–1
  outage: boolean;
}

interface ProviderAvailability {
  provider: string;
  slots: AvailabilitySlot[];
  overallAvailability: number;
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const PROVIDERS = ['AllBridge', 'Squid', 'Stargate'];

function makeSlots(days: number, baseAvail: number, outageDays: number[]): AvailabilitySlot[] {
  const now = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const outage = outageDays.includes(i);
    const availability = outage ? Math.random() * 0.4 : baseAvail - Math.random() * 0.02;
    return { label, availability: Math.max(0, Math.min(1, availability)), outage };
  });
}

const DATA: Record<TimeRange, ProviderAvailability[]> = {
  '7d': [
    { provider: 'AllBridge', slots: makeSlots(7, 0.998, []), overallAvailability: 0.998 },
    { provider: 'Squid',     slots: makeSlots(7, 0.991, [4]), overallAvailability: 0.987 },
    { provider: 'Stargate',  slots: makeSlots(7, 0.999, []), overallAvailability: 0.999 },
  ],
  '30d': [
    { provider: 'AllBridge', slots: makeSlots(30, 0.997, [7, 21]), overallAvailability: 0.994 },
    { provider: 'Squid',     slots: makeSlots(30, 0.988, [3, 14, 26]), overallAvailability: 0.981 },
    { provider: 'Stargate',  slots: makeSlots(30, 0.999, [19]), overallAvailability: 0.996 },
  ],
  '90d': [
    { provider: 'AllBridge', slots: makeSlots(90, 0.996, [12, 34, 67]), overallAvailability: 0.993 },
    { provider: 'Squid',     slots: makeSlots(90, 0.985, [5, 22, 41, 78]), overallAvailability: 0.977 },
    { provider: 'Stargate',  slots: makeSlots(90, 0.998, [55]), overallAvailability: 0.996 },
  ],
};

// ── Heatmap cell ──────────────────────────────────────────────────────────────

function cellColor(availability: number): string {
  if (availability >= 0.999) return '#16a34a';
  if (availability >= 0.995) return '#4ade80';
  if (availability >= 0.98)  return '#fbbf24';
  if (availability >= 0.95)  return '#f97316';
  return '#ef4444';
}

function HeatmapRow({ data, compact }: { data: ProviderAvailability; compact: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const cellW = compact ? 8 : 14;
  const cellGap = compact ? 2 : 3;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
      <div style={{ width: '80px', fontSize: '13px', fontWeight: 600, color: '#1e293b', flexShrink: 0 }}>
        {data.provider}
      </div>

      <div style={{ display: 'flex', gap: `${cellGap}px`, flexWrap: 'nowrap', overflow: 'hidden', position: 'relative' }}>
        {data.slots.map((slot, i) => (
          <div
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            style={{
              width: `${cellW}px`,
              height: '24px',
              borderRadius: '3px',
              backgroundColor: cellColor(slot.availability),
              cursor: 'default',
              flexShrink: 0,
              position: 'relative',
            }}
          >
            {hovered === i && (
              <div style={{
                position: 'absolute',
                bottom: '28px',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: '#1e293b',
                color: '#fff',
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: '4px',
                whiteSpace: 'nowrap',
                zIndex: 10,
                pointerEvents: 'none',
              }}>
                {slot.label}: {(slot.availability * 100).toFixed(2)}%
                {slot.outage && ' ⚠ outage'}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ fontSize: '13px', color: '#475569', flexShrink: 0, minWidth: '56px' }}>
        {(data.overallAvailability * 100).toFixed(2)}%
      </div>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  const items = [
    { color: '#16a34a', label: '≥ 99.9%' },
    { color: '#4ade80', label: '≥ 99.5%' },
    { color: '#fbbf24', label: '≥ 98%' },
    { color: '#f97316', label: '≥ 95%' },
    { color: '#ef4444', label: '< 95%' },
  ];
  return (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
      {items.map(({ color, label }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: color }} />
          <span style={{ fontSize: '12px', color: '#64748b' }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProviderAvailabilityHeatmap() {
  const [range, setRange] = useState<TimeRange>('30d');
  const [filter, setFilter] = useState<string>('All');

  const providers = useMemo(() => {
    const rows = DATA[range];
    return filter === 'All' ? rows : rows.filter((r) => r.provider === filter);
  }, [range, filter]);

  const compact = range === '90d';

  return (
    <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', maxWidth: '1000px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#0f172a', marginBottom: '4px' }}>
        Stellar Provider Availability Heatmap
      </h1>
      <p style={{ color: '#64748b', marginBottom: '24px', fontSize: '14px' }}>
        Visualize provider uptime trends and outage periods over time.
      </p>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '28px' }}>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['7d', '30d', '90d'] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid',
                borderColor: range === r ? '#6366f1' : '#e2e8f0',
                backgroundColor: range === r ? '#6366f1' : '#fff',
                color: range === r ? '#fff' : '#374151',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              {r}
            </button>
          ))}
        </div>

        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            padding: '6px 12px',
            borderRadius: '6px',
            border: '1px solid #e2e8f0',
            fontSize: '13px',
            color: '#374151',
          }}
        >
          <option value="All">All Providers</option>
          {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
        </select>
      </div>

      {/* Heatmap */}
      <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px 20px 16px', backgroundColor: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
            Availability — last {range}
          </span>
          <Legend />
        </div>

        {providers.map((p) => (
          <HeatmapRow key={p.provider} data={p} compact={compact} />
        ))}
      </div>

      {/* Outage summary */}
      <div style={{ marginTop: '20px', padding: '14px 16px', backgroundColor: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#92400e' }}>Outage periods</span>
        <span style={{ fontSize: '13px', color: '#78350f', marginLeft: '8px' }}>
          Orange/red cells indicate degraded or unavailable service. Hover for details.
        </span>
      </div>
    </div>
  );
}
