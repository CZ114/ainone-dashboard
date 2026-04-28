// DisplaySettings component — sliders that shape the channel grid.
//
// Snap points: range inputs still accept any value in their (min, max)
// but the associated <datalist> draws visible tick marks at the snap
// positions in Chromium/Webkit. A `snapTo()` helper rounds input to the
// nearest snap when the mouse is within a small tolerance window,
// giving a "detent" feel without forcing discrete stepping.

import { useStore } from '../../store';

// Snap positions for Card Scale. `0.7–2.0` covers "small but readable"
// → "mobile-style large". Closely-spaced low-end, wider at the high end
// matches how useful each size tier actually feels.
const CARD_SCALE_SNAPS = [0.7, 0.85, 1.0, 1.25, 1.5, 2.0];
const CARDS_PER_ROW_SNAPS = [1, 2, 3, 4, 5, 6, 7, 8];
// Wheel-zoom sensitivity stored as the raw multiplier. Snaps at
// "human-meaningful" percentages: 5% (very fine), 10%, 15% (default),
// 20%, 30% (aggressive).
const WHEEL_SENS_SNAPS = [1.05, 1.10, 1.15, 1.20, 1.30];

/**
 * Snap `raw` to the nearest value in `snaps` if within `tolerance` of
 * it; otherwise return `raw` unchanged. This gives the slider a
 * magnetic feel at useful increments without making it fully discrete.
 */
function snapTo(raw: number, snaps: number[], tolerance: number): number {
  for (const s of snaps) {
    if (Math.abs(raw - s) <= tolerance) return s;
  }
  return raw;
}

export function DisplaySettings() {
  const settings = useStore((state) => state.settings);
  const setSettings = useStore((state) => state.setSettings);

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">⚙️</span>
        <span className="font-semibold text-text-primary">Display Settings</span>
      </div>

      <div className="space-y-4">
        {/* Points per channel */}
        <div>
          <label className="text-sm text-text-secondary block mb-1">
            Waveform Points:{' '}
            <span className="text-text-primary font-mono">
              {settings.points_per_channel}
            </span>
          </label>
          <input
            type="range"
            min={20}
            max={500}
            step={10}
            value={settings.points_per_channel}
            onChange={(e) =>
              setSettings({ points_per_channel: Number(e.target.value) })
            }
            className="w-full accent-accent"
          />
        </div>

        {/* Cards per row */}
        <div>
          <label className="text-sm text-text-secondary block mb-1">
            Cards Per Row:{' '}
            <span className="text-text-primary font-mono">
              {settings.cards_per_row}
            </span>
          </label>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={settings.cards_per_row}
            onChange={(e) =>
              setSettings({ cards_per_row: Number(e.target.value) })
            }
            list="cards-per-row-ticks"
            className="w-full accent-accent"
          />
          <datalist id="cards-per-row-ticks">
            {CARDS_PER_ROW_SNAPS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="flex justify-between text-[10px] text-text-muted px-0.5 mt-0.5 select-none">
            {CARDS_PER_ROW_SNAPS.map((v) => (
              <span key={v}>{v}</span>
            ))}
          </div>
        </div>

        {/* Card scale — magnetic snap at useful sizes */}
        <div>
          <label className="text-sm text-text-secondary block mb-1">
            Card Size:{' '}
            <span className="text-text-primary font-mono">
              {settings.card_scale.toFixed(2)}×
            </span>
          </label>
          <input
            type="range"
            min={0.6}
            max={2.1}
            step={0.05}
            value={settings.card_scale}
            onChange={(e) => {
              const raw = Number(e.target.value);
              // Magnetic: within 0.04 of a snap → jump to it.
              const snapped = snapTo(raw, CARD_SCALE_SNAPS, 0.04);
              setSettings({ card_scale: snapped });
            }}
            list="card-scale-ticks"
            className="w-full accent-accent"
          />
          <datalist id="card-scale-ticks">
            {CARD_SCALE_SNAPS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="flex justify-between text-[10px] text-text-muted px-0.5 mt-0.5 select-none">
            {CARD_SCALE_SNAPS.map((v) => (
              <span key={v}>{v}×</span>
            ))}
          </div>
        </div>

        {/* Wheel zoom sensitivity — controls how much one notch of the
            scroll wheel tightens / expands the chart Y-axis. Shown as
            percentage for readability (raw multiplier under the hood). */}
        <div>
          <label className="text-sm text-text-secondary block mb-1">
            Wheel Zoom Step:{' '}
            <span className="text-text-primary font-mono">
              {((settings.wheel_zoom_sensitivity - 1) * 100).toFixed(0)}%
            </span>
          </label>
          <input
            type="range"
            min={1.02}
            max={1.40}
            step={0.01}
            value={settings.wheel_zoom_sensitivity}
            onChange={(e) => {
              const raw = Number(e.target.value);
              const snapped = snapTo(raw, WHEEL_SENS_SNAPS, 0.012);
              setSettings({ wheel_zoom_sensitivity: snapped });
            }}
            list="wheel-sens-ticks"
            className="w-full accent-accent"
          />
          <datalist id="wheel-sens-ticks">
            {WHEEL_SENS_SNAPS.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div className="flex justify-between text-[10px] text-text-muted px-0.5 mt-0.5 select-none">
            {WHEEL_SENS_SNAPS.map((v) => (
              <span key={v}>{((v - 1) * 100).toFixed(0)}%</span>
            ))}
          </div>
        </div>

        {/* Mini hint — tells users what they can do inside each chart
            without cluttering the main card UI. */}
        <div className="text-[11px] text-text-muted pt-1 border-t border-card-border/50 space-y-0.5">
          <div>🖱️ <span className="font-medium">Scroll</span> inside a chart → zoom Y-axis</div>
          <div>🖱️ <span className="font-medium">Double-click</span> chart → reset zoom</div>
        </div>
      </div>
    </div>
  );
}
