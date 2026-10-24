import PianoKeyboard from "./PianoKeyboard";
import PianoRoll from "./PianoRoll";
import { usePanelCollapse } from "../../stores/collapsed";

/** The practice room's pitch panel: the keyboard with the roll under it, folded by the keyboard's one button. */
export default function PitchMonitorPanel() {
  const { open } = usePanelCollapse("pitchMonitor");
  return (
    <>
      <PianoKeyboard />
      {open && <PianoRoll collapsible={false} />}
    </>
  );
}
