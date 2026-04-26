// WaveformChart — dumb renderer. Interaction (wheel zoom, double-click
// reset) is handled by the parent ChannelCard via a native listener on
// the wrapping div, since React's onWheel is passive-only and can't
// preventDefault the page scroll.

import { useMemo } from 'react';
import { AreaChart, Area, ResponsiveContainer, YAxis } from 'recharts';

interface WaveformChartProps {
  data: number[];
  color: string;
  yMin: number;
  yMax: number;
  dataMin: number;
  dataMax: number;
  height?: number;
}

export function WaveformChart({
  data,
  color,
  yMin,
  yMax,
  dataMin,
  dataMax,
  height = 80,
}: WaveformChartProps) {
  const chartData = useMemo(() => {
    return data.map((value, index) => ({ x: index, y: value }));
  }, [data]);

  const gradientId = useMemo(
    () => `gradient-${Math.random().toString(36).substr(2, 9)}`,
    [],
  );

  // Pixel positions for min/max labels within the Y-axis domain.
  const maxLabelStyle = useMemo(() => {
    const range = yMax - yMin || 1;
    const topPercent = ((yMax - dataMax) / range) * 100;
    return { top: `${topPercent}%`, right: 4, left: 'auto' };
  }, [yMin, yMax, dataMax]);

  const minLabelStyle = useMemo(() => {
    const range = yMax - yMin || 1;
    const topPercent = ((yMax - dataMin) / range) * 100;
    return { top: `${topPercent}%`, right: 4, left: 'auto' };
  }, [yMin, yMax, dataMin]);

  return (
    <div className="h-full w-full relative">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart
          data={chartData}
          margin={{ top: 5, right: 5, bottom: 5, left: 5 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <YAxis
            domain={[yMin, yMax]}
            orientation="left"
            tick={false}
            axisLine={false}
            tickLine={false}
            width={1}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            strokeWidth={1.5}
          />
        </AreaChart>
      </ResponsiveContainer>
      {/* Min/max labels positioned outside the chart area. pointer-events-none
          so the wheel event on the parent div gets a clean shot at the
          chart region (labels don't intercept). */}
      <div
        className="absolute right-0 top-0 h-full flex flex-col justify-between pointer-events-none"
        style={{ width: 44 }}
      >
        <span
          className="text-xs text-text-secondary font-mono text-right"
          style={maxLabelStyle}
        >
          {dataMax.toFixed(1)}
        </span>
        <span
          className="text-xs text-text-secondary font-mono text-right"
          style={minLabelStyle}
        >
          {dataMin.toFixed(1)}
        </span>
      </div>
    </div>
  );
}