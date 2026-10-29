import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { w, BEAT, Show, pop, FONT, COLOR } from "./harness";

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

export default function Scene() {
  const frame = useCurrentFrame();
  const phone = pop(frame, BEAT[1]);
  const app = pop(frame, w("app"));
  const label = pop(frame, w("thread"));
  const line = interpolate(frame, [w("thread"), w("thread") + 15], [0, 800], clamp);
  const box = pop(frame, w("processo"));
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.bg, fontFamily: FONT }}>
      <Show from={0} to={BEAT[2]}>
        <div
          style={{
            position: "absolute",
            left: 300,
            top: 280,
            width: 480,
            height: 960,
            borderRadius: 60,
            background: COLOR.panel,
            transform: `scale(${phone})`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 300,
            top: 1260,
            width: 480,
            textAlign: "center",
            color: COLOR.text,
            fontSize: 64,
            fontWeight: 800,
            opacity: app,
            transform: `scale(${app})`,
          }}
        >
          app
        </div>
      </Show>
      <Show from={BEAT[2]} to={BEAT[3]}>
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 760,
            width: line,
            height: 16,
            borderRadius: 8,
            background: COLOR.green,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 600,
            width: 800,
            textAlign: "center",
            color: COLOR.text,
            fontSize: 72,
            fontWeight: 800,
            opacity: label,
          }}
        >
          thread
        </div>
      </Show>
      <Show from={BEAT[3]}>
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 400,
            width: 800,
            height: 600,
            borderRadius: 40,
            background: COLOR.panel,
            transform: `scale(${box})`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 1060,
            width: 800,
            textAlign: "center",
            color: COLOR.text,
            fontSize: 72,
            fontWeight: 800,
            opacity: box,
          }}
        >
          processo
        </div>
      </Show>
    </AbsoluteFill>
  );
}
