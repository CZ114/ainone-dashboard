// ChannelGrid - responsive grid layout for channel cards

import { useStore } from '../../store';
import { ChannelCard } from './ChannelCard';

export function ChannelGrid() {
  const channels = useStore((state) => state.channels);
  const settings = useStore((state) => state.settings);
  const toggleChannel = useStore((state) => state.toggleChannel);

  // Placeholder for zoom handler - in a real app this would update backend
  const handleZoom = (index: number, yMin: number, yMax: number) => {
    // Could send to backend via WebSocket if needed
    console.log(`Channel ${index} zoomed to [${yMin.toFixed(2)}, ${yMax.toFixed(2)}]`);
  };

  if (channels.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <div className="text-center">
          <div className="text-4xl mb-4">📊</div>
          <p className="text-lg">Waiting for sensor data...</p>
          <p className="text-sm mt-2">Connect via Serial or BLE to receive data</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid gap-4 p-4"
      style={{
        gridTemplateColumns: `repeat(${settings.cards_per_row}, minmax(0, 1fr))`,
      }}
    >
      {channels.map((channel, index) => (
        <ChannelCard
          key={index}
          channel={channel}
          index={index}
          onToggle={toggleChannel}
          onZoom={handleZoom}
        />
      ))}
    </div>
  );
}