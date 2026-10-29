// The Clip composition: the agent's <Scene/>, narration audio, harness captions on top.
import React from "react";
import { AbsoluteFill, Composition, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import Scene from "./Scene";
import { Captions } from "./Captions";
import { CLIP, FPS, SECOND_MS } from "./harness";

/** The agent's scene, narration and captions. */
const Clip: React.FC = () => (
  <AbsoluteFill>
    <AbsoluteFill>
      <Scene />
    </AbsoluteFill>
    <Audio src={staticFile(CLIP.audio)} />
    <Captions />
  </AbsoluteFill>
);

/** As long as the decoded narration. */
export const Root: React.FC = () => (
  <Composition
    id="Clip"
    component={Clip}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={Math.ceil((CLIP.durationMs / SECOND_MS) * FPS)}
  />
);
