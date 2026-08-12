// useGloveWorn — derives a stable "glove is worn" boolean from the live
// gsr_filtered channel + the user's calibration (see lib/gloveCalibration).
//
// The raw threshold crossing is debounced: the value must stay on the new
// side for DEBOUNCE_MS before the worn state flips, so a momentary artifact
// (hand adjustment, motion) doesn't make the green indicator flicker.

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { isWorn, readGsr, useCalib } from '../lib/gloveCalibration';

const DEBOUNCE_MS = 800;

export interface GloveWorn {
  worn: boolean;         // debounced worn state (false until calibrated)
  gsr: number | null;    // live gsr_filtered value, or null if no channel
  calibrated: boolean;   // has the user calibrated this session/device?
  hasGsr: boolean;       // is a gsr channel present in the stream at all?
}

export function useGloveWorn(): GloveWorn {
  const channels = useStore((s) => s.channels);
  const calib = useCalib();
  const gsr = readGsr(channels);
  const raw = gsr != null && calib != null ? isWorn(gsr, calib) : false;

  const [worn, setWorn] = useState(false);
  useEffect(() => {
    if (raw === worn) return; // already stable — nothing pending
    const id = setTimeout(() => setWorn(raw), DEBOUNCE_MS);
    return () => clearTimeout(id); // raw flipped back before the window elapsed → cancel
  }, [raw, worn]);

  return {
    worn: calib != null && worn,
    gsr,
    calibrated: calib != null,
    hasGsr: gsr != null,
  };
}
