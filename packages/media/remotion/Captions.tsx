// Harness-drawn word captions, the same for every scene.
import React from "react";
import { useCurrentFrame } from "remotion";
import { CLIP, FONT, FPS, SECOND_MS } from "./harness";
import { captionAt, captionPages } from "./pages";

const pages = captionPages(CLIP.words);

/** Caption band y 1420–1620 (~75% down), x 140–940, centred on the canvas. */
export const Captions: React.FC = () => {
  const shown = captionAt(pages, (useCurrentFrame() / FPS) * SECOND_MS);
  if (!shown) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 140,
        top: 1420,
        width: 800,
        height: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: 72,
        lineHeight: 1.15,
        whiteSpace: "pre-wrap",
        wordSpacing: 10,
        // A 16px stroke painted under the fill is an 8px black outline.
        WebkitTextStroke: "16px black",
        paintOrder: "stroke fill",
      }}
    >
      <div>
        {shown.page.tokens.map((token, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a page's tokens never reorder, and start times repeat (zero-length words)
          <span key={i} style={{ color: i === shown.active ? "#FFD400" : "white" }}>
            {token.text}
          </span>
        ))}
      </div>
    </div>
  );
};
