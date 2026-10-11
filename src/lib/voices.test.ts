import { describe, it, expect } from "vitest";
import { arrangeVoices, isMainVoice, MAIN_VOICES } from "./voices";

// 220 Hz and 277 Hz held together (a major third), then one voice alone, then a gap.
const f0 = [220, 220, 277, 0, 220];
const alt = [277, 277, 220, 0, 0];

describe("arrangeVoices", () => {
  it("loudest keeps the stored line as the main one and the other voice as the second", () => {
    expect(arrangeVoices(f0, alt, "loudest")).toEqual({ main: f0, second: alt });
  });

  it("higher puts the upper voice on the main line wherever two sing", () => {
    expect(arrangeVoices(f0, alt, "higher")).toEqual({
      main: [277, 277, 277, 0, 220],
      second: [220, 220, 220, 0, 0],
    });
  });

  it("lower puts the lower voice on the main line wherever two sing", () => {
    expect(arrangeVoices(f0, alt, "lower")).toEqual({
      main: [220, 220, 220, 0, 220],
      second: [277, 277, 277, 0, 0],
    });
  });

  it("never moves a single voice off the main line, whatever the preference", () => {
    const single = [220, 330, 0, 440];
    const none = [0, 0, 0, 0];
    for (const mode of MAIN_VOICES.map((v) => v.id)) {
      expect(arrangeVoices(single, none, mode)).toEqual({ main: single, second: none });
    }
  });

  it("treats a missing second line (songs analysed before it existed) as no second voice", () => {
    expect(arrangeVoices(f0, undefined, "higher")).toEqual({ main: f0, second: [0, 0, 0, 0, 0] });
  });

  it("ignores a second line of the wrong length instead of misaligning it", () => {
    expect(arrangeVoices(f0, [300, 300], "higher")).toEqual({ main: f0, second: [0, 0, 0, 0, 0] });
  });

  it("does not mutate its inputs", () => {
    const a = [220, 277];
    const b = [277, 220];
    arrangeVoices(a, b, "lower");
    expect(a).toEqual([220, 277]);
    expect(b).toEqual([277, 220]);
  });
});

describe("isMainVoice", () => {
  it.each(["loudest", "higher", "lower"])("accepts %s", (v) => expect(isMainVoice(v)).toBe(true));
  it.each(["", "upper", "LOUDEST", null, undefined, 3])("rejects %j", (v) => expect(isMainVoice(v)).toBe(false));
});
